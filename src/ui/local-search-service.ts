import { sha256 } from "@noble/hashes/sha2.js";
import * as v from "valibot";
import type { RankedSearch } from "../core/forgiving-search.ts";
import {
  continueCategory,
  type LocalMatches,
  localQuery,
  matchIndex,
  previewGroups,
} from "../core/local-search.ts";
import { indexAdmission } from "../core/local-search-policy.ts";
import {
  type IndexUnavailable,
  indexProgressSteps,
  type LocalRow,
  type LocalSearchReply,
  type LocalSearchRequest,
  LocalSearchRequestSchema,
} from "../core/local-search-protocol.ts";
import type { Result } from "../core/result.ts";
import {
  decodeSearchIndex,
  hasSearchIndexSignature,
  type SearchIndex,
} from "../core/search-index.ts";

const hexadecimalRadix = 16;
const hexadecimalByteWidth = 2;

export type RankingFactory = (
  index: SearchIndex,
  bytes: Uint8Array,
) => RankedSearch;

export interface LocalSearchPorts {
  readonly fetch: (url: string) => Promise<Response>;
  readonly post: (reply: LocalSearchReply) => void;
}

interface Expected {
  readonly url: string;
  readonly snapshot: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly uncompressedBytes: number;
  readonly uncompressedSha256: string;
}

function digestHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(hexadecimalRadix).padStart(hexadecimalByteWidth, "0"),
  ).join("");
}

/** Reads the decoded body and reports each completed step; a body longer than expected stops early and fails admission. */
async function download(
  ports: LocalSearchPorts,
  expected: Expected,
  current: () => boolean,
  receivedBefore: number,
  total: number,
): Promise<
  Result<
    Uint8Array<ArrayBuffer>,
    { readonly reason: IndexUnavailable; readonly detail: string }
  >
> {
  try {
    const response = await ports.fetch(expected.url);
    if (!response.ok)
      return {
        ok: false,
        error: {
          reason: "fetch_failed",
          detail: `The index responded ${response.status}`,
        },
      };
    if (
      response.headers.get("Content-Encoding") !== "br" ||
      response.headers.get("Content-Length") !== String(expected.bytes) ||
      response.headers.get("ETag") !== `"${expected.sha256}"` ||
      response.headers.get("X-Dataset-Snapshot") !== expected.snapshot
    )
      return { ok: false, error: { reason: "transport_mismatch", detail: "" } };
    if (!response.body)
      return { ok: false, error: { reason: "length_mismatch", detail: "" } };
    const reader = response.body.getReader();
    const bytes = new Uint8Array(expected.uncompressedBytes);
    const hash = sha256.create();
    let received = 0;
    let step = Math.floor(
      (receivedBefore * indexProgressSteps) / Math.max(total, 1),
    );
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      const chunk: unknown = read.value;
      if (!(chunk instanceof Uint8Array))
        throw new TypeError("The index body didn't stream bytes");
      received += chunk.byteLength;
      if (received > expected.uncompressedBytes || !current()) {
        await reader.cancel();
        return { ok: false, error: { reason: "length_mismatch", detail: "" } };
      }
      bytes.set(chunk, received - chunk.byteLength);
      hash.update(chunk);
      const reached = Math.floor(
        ((receivedBefore + received) * indexProgressSteps) / Math.max(total, 1),
      );
      if (reached > step && current()) {
        step = reached;
        ports.post({
          type: "progress",
          received: receivedBefore + received,
          total,
        });
      }
    }
    if (received !== expected.uncompressedBytes)
      return { ok: false, error: { reason: "length_mismatch", detail: "" } };
    if (digestHex(hash.digest()) !== expected.uncompressedSha256)
      return { ok: false, error: { reason: "digest_mismatch", detail: "" } };
    return { ok: true, value: bytes };
  } catch (error) {
    return {
      ok: false,
      error: { reason: "fetch_failed", detail: String(error) },
    };
  }
}

function decode(bytes: Uint8Array, lazy: boolean): Result<SearchIndex, string> {
  try {
    return { ok: true, value: decodeSearchIndex(bytes, lazy) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** The category groups of one query, with the forgiving score of each ranked row. */
interface Matched {
  readonly matches: LocalMatches;
  readonly scores: ReadonlyMap<number, number>;
}

/** Groups rows in their given order by category, placing each category where its first row appears. */
function groupRows(
  index: SearchIndex,
  positions: readonly number[],
): LocalMatches {
  const categories = new Map<string, number[]>();
  for (const position of positions) {
    const category = index.rows[position]?.category;
    if (category === undefined)
      throw new Error("A matched row is out of range");
    const rows = categories.get(category) ?? [];
    rows.push(position);
    categories.set(category, rows);
  }
  return {
    total: positions.length,
    categories: [...categories].map(([category, rows]) => ({ category, rows })),
  };
}

export function localRow(index: SearchIndex, position: number): LocalRow {
  const row = index.rows[position];
  if (!row) throw new Error("A local search row is out of range");
  return {
    row: position,
    name: row.name,
    category: row.category,
    region: row.region,
    phones: [...row.phones],
    hasAddress: row.hasAddress,
  };
}

export function localSearchService(
  ports: LocalSearchPorts,
  createRanking?: RankingFactory,
): (message: unknown) => Promise<void> {
  let loads = 0;
  let index: SearchIndex | null = null;
  let ranked: RankedSearch | null = null;
  let cached: ({ readonly query: string } & Matched) | null = null;

  /** Keeps answering from the current index until a replacement is admitted, and drops it when the replacement fails. */
  async function load(
    request: Extract<LocalSearchRequest, { type: "load" | "load-forgiving" }>,
  ): Promise<void> {
    loads += 1;
    const generation = loads;
    const current = (): boolean => generation === loads;
    if (request.type === "load-forgiving" && !createRanking) {
      ports.post({
        type: "unavailable",
        reason: "malformed",
        detail: "Forgiving search is unavailable",
      });
      return;
    }
    const expected = request.index;
    const total =
      expected.uncompressedBytes +
      (request.type === "load-forgiving"
        ? request.ranking.uncompressedBytes
        : 0);
    const downloaded = await download(ports, expected, current, 0, total);
    if (!current()) return;
    if (!downloaded.ok) {
      index = null;
      ranked = null;
      cached = null;
      ports.post({
        type: "unavailable",
        reason: downloaded.error.reason,
        detail: downloaded.error.detail,
      });
      return;
    }
    const bytes = downloaded.value;
    const lengthMatches = bytes.byteLength === expected.uncompressedBytes;
    const digestMatches = lengthMatches;
    if (!current()) return;
    const signatureMatches = digestMatches && hasSearchIndexSignature(bytes);
    const decoded = signatureMatches
      ? decode(bytes, request.type === "load-forgiving")
      : null;
    const admission = indexAdmission(
      bytes.byteLength,
      expected.uncompressedBytes,
      digestMatches,
      signatureMatches,
      decoded?.ok === true,
      decoded?.ok === true &&
        decoded.value.header.snapshot === expected.snapshot,
    );
    cached = null;
    if (admission !== "admitted" || !decoded?.ok) {
      index = null;
      ranked = null;
      ports.post({
        type: "unavailable",
        reason: admission === "admitted" ? "malformed" : admission,
        detail: decoded?.ok === false ? decoded.error : "",
      });
      return;
    }
    let replacement: RankedSearch | null = null;
    if (request.type === "load-forgiving" && createRanking) {
      const companion = await download(
        ports,
        request.ranking,
        current,
        expected.uncompressedBytes,
        total,
      );
      if (!current()) return;
      if (!companion.ok) {
        index = null;
        ranked = null;
        ports.post({ type: "unavailable", ...companion.error });
        return;
      }
      try {
        if (request.ranking.snapshot !== expected.snapshot)
          throw new Error("Ranking discovery snapshot mismatch");
        replacement = createRanking(decoded.value, companion.value);
      } catch (error) {
        index = null;
        ranked = null;
        ports.post({
          type: "unavailable",
          reason: "malformed",
          detail: String(error),
        });
        return;
      }
    }
    index = decoded.value;
    ranked = replacement;
    cached = null;
    const { snapshot, contacts, categories, prefectures, municipalities } =
      index.header;
    ports.post({
      type: "ready",
      snapshot,
      contacts,
      categories,
      prefectures,
      municipalities,
    });
  }

  function matchesFor(
    current: SearchIndex,
    query: string,
  ): Result<Matched, "invalid_query"> {
    if (cached?.query === query) return { ok: true, value: cached };
    const parsed = localQuery(query);
    if (!parsed.ok) return parsed;
    let matched: Matched;
    if (parsed.value.kind === "words" && ranked) {
      const hits = ranked.search(query);
      matched = {
        matches: groupRows(
          current,
          hits.map((hit) => hit.row),
        ),
        scores: new Map(hits.map((hit) => [hit.row, hit.score])),
      };
    } else if (parsed.value.kind === "telephone" && current.telephoneRows)
      matched = {
        matches: groupRows(current, current.telephoneRows(parsed.value.number)),
        scores: new Map(),
      };
    else
      matched = {
        matches: matchIndex(current, parsed.value),
        scores: new Map(),
      };
    cached = { query, ...matched };
    return { ok: true, value: matched };
  }

  function row(
    current: SearchIndex,
    matched: Matched,
    position: number,
  ): LocalRow {
    const score = matched.scores.get(position);
    return score === undefined
      ? localRow(current, position)
      : { ...localRow(current, position), score };
  }

  return async (message: unknown): Promise<void> => {
    const request = v.parse(LocalSearchRequestSchema, message);
    if (request.type === "load" || request.type === "load-forgiving") {
      await load(request);
      return;
    }
    const current = index;
    if (!current) {
      ports.post({ type: "failed", id: request.id, error: "not_ready" });
      return;
    }
    const matches = matchesFor(current, request.query);
    if (!matches.ok) {
      ports.post({ type: "failed", id: request.id, error: matches.error });
      return;
    }
    const matched = matches.value;
    if (request.type === "search") {
      const results = previewGroups(matched.matches);
      ports.post({
        type: "results",
        id: request.id,
        total: results.total,
        groups: results.groups.map((group) => ({
          category: group.category,
          total: group.total,
          rows: group.rows.map((position) => row(current, matched, position)),
        })),
      });
      return;
    }
    const page = continueCategory(
      matched.matches,
      request.category,
      request.visible,
    );
    if (!page.ok) {
      ports.post({ type: "failed", id: request.id, error: page.error });
      return;
    }
    ports.post({
      type: "page",
      id: request.id,
      category: page.value.category,
      total: page.value.total,
      visible: page.value.visible,
      rows: page.value.rows.map((position) => row(current, matched, position)),
    });
  };
}
