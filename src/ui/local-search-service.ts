import * as v from "valibot";
import {
  continueCategory,
  createRankedSearch,
  type LocalMatches,
  localQuery,
  matchIndex,
  previewGroups,
  type RankedSearch,
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
import { decodeRankingArtifact } from "../core/search-ranking-artifact.ts";

const hexadecimalRadix = 16;
const hexadecimalByteWidth = 2;

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

async function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(hexadecimalRadix).padStart(hexadecimalByteWidth, "0"),
  ).join("");
}

function concatenate(
  chunks: readonly Uint8Array[],
  length: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
    const chunks: Uint8Array[] = [];
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
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > expected.uncompressedBytes || !current()) {
        await reader.cancel();
        return { ok: false, error: { reason: "length_mismatch", detail: "" } };
      }
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
    const bytes = concatenate(chunks, received);
    if (bytes.length !== expected.uncompressedBytes)
      return { ok: false, error: { reason: "length_mismatch", detail: "" } };
    if ((await digestHex(bytes)) !== expected.uncompressedSha256)
      return { ok: false, error: { reason: "digest_mismatch", detail: "" } };
    return { ok: true, value: bytes };
  } catch (error) {
    return {
      ok: false,
      error: { reason: "fetch_failed", detail: String(error) },
    };
  }
}

function decode(bytes: Uint8Array): Result<SearchIndex, string> {
  try {
    return { ok: true, value: decodeSearchIndex(bytes) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
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
): (message: unknown) => Promise<void> {
  let loads = 0;
  let index: SearchIndex | null = null;
  let ranked: RankedSearch | null = null;
  let cached: {
    readonly query: string;
    readonly matches: LocalMatches;
  } | null = null;

  /** Keeps answering from the current index until a replacement is admitted, and drops it when the replacement fails. */
  async function load(
    request: Extract<LocalSearchRequest, { type: "load" }>,
  ): Promise<void> {
    loads += 1;
    const generation = loads;
    const current = (): boolean => generation === loads;
    const expected = request.index;
    const total =
      expected.uncompressedBytes + request.ranking.uncompressedBytes;
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
    const decoded = signatureMatches ? decode(bytes) : null;
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
    let replacement: RankedSearch;
    try {
      if (request.ranking.snapshot !== expected.snapshot)
        throw new Error("Ranking discovery snapshot mismatch");
      replacement = createRankedSearch(
        decoded.value,
        decodeRankingArtifact(
          companion.value,
          expected.snapshot,
          decoded.value.rows.length,
        ),
      );
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
  ): Result<LocalMatches, "invalid_query"> {
    if (cached?.query === query) return { ok: true, value: cached.matches };
    const parsed = localQuery(query);
    if (!parsed.ok) return parsed;
    let matches: LocalMatches;
    if (parsed.value.kind === "words" && ranked) {
      const hits = ranked.search(query);
      const categories = new Map<string, number[]>();
      for (const { row: position } of hits) {
        const category = current.rows[position]?.category;
        if (!category) throw new Error("A ranked row is out of range");
        const rows = categories.get(category) ?? [];
        rows.push(position);
        categories.set(category, rows);
      }
      matches = {
        total: hits.length,
        categories: [...categories].map(([category, rows]) => ({
          category,
          rows,
        })),
      };
    } else matches = matchIndex(current, parsed.value);
    cached = { query, matches };
    return { ok: true, value: matches };
  }

  return async (message: unknown): Promise<void> => {
    const request = v.parse(LocalSearchRequestSchema, message);
    if (request.type === "load") {
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
    if (request.type === "search") {
      const results = previewGroups(matches.value);
      ports.post({
        type: "results",
        id: request.id,
        total: results.total,
        groups: results.groups.map((group) => ({
          category: group.category,
          total: group.total,
          rows: group.rows.map((position) => localRow(current, position)),
        })),
      });
      return;
    }
    const page = continueCategory(
      matches.value,
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
      rows: page.value.rows.map((position) => localRow(current, position)),
    });
  };
}
