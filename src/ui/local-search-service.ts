import * as v from "valibot";
import {
  continueCategory,
  type LocalMatches,
  localQuery,
  matchIndex,
  previewGroups,
} from "../core/local-search.ts";
import { indexAdmission } from "../core/local-search-policy.ts";
import {
  type LocalRow,
  type LocalSearchReply,
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

export interface LocalSearchPorts {
  readonly fetch: (url: string) => Promise<Response>;
  readonly post: (reply: LocalSearchReply) => void;
}

interface Expected {
  readonly url: string;
  readonly snapshot: string;
  readonly bytes: number;
  readonly sha256: string;
}

async function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(hexadecimalRadix).padStart(hexadecimalByteWidth, "0"),
  ).join("");
}

async function download(
  ports: LocalSearchPorts,
  url: string,
): Promise<Result<Uint8Array<ArrayBuffer>, string>> {
  try {
    const response = await ports.fetch(url);
    if (!response.ok)
      return { ok: false, error: `The index responded ${response.status}` };
    return { ok: true, value: new Uint8Array(await response.arrayBuffer()) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function decode(bytes: Uint8Array): Result<SearchIndex, string> {
  try {
    return { ok: true, value: decodeSearchIndex(bytes) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function localRow(index: SearchIndex, position: number): LocalRow {
  const row = index.rows[position];
  if (!row) throw new Error("A local search row is out of range");
  return {
    row: position,
    name: row.name,
    category: row.category,
    region: row.region,
    phones: [...row.phones],
  };
}

export function localSearchService(
  ports: LocalSearchPorts,
): (message: unknown) => Promise<void> {
  let loads = 0;
  let index: SearchIndex | null = null;
  let cached: {
    readonly query: string;
    readonly matches: LocalMatches;
  } | null = null;

  async function load(expected: Expected): Promise<void> {
    loads += 1;
    const generation = loads;
    index = null;
    cached = null;
    const downloaded = await download(ports, expected.url);
    if (generation !== loads) return;
    if (!downloaded.ok) {
      ports.post({
        type: "unavailable",
        reason: "fetch_failed",
        detail: downloaded.error,
      });
      return;
    }
    const bytes = downloaded.value;
    const lengthMatches = bytes.byteLength === expected.bytes;
    const digestMatches =
      lengthMatches && (await digestHex(bytes)) === expected.sha256;
    if (generation !== loads) return;
    const signatureMatches = digestMatches && hasSearchIndexSignature(bytes);
    const decoded = signatureMatches ? decode(bytes) : null;
    const admission = indexAdmission(
      bytes.byteLength,
      expected.bytes,
      digestMatches,
      signatureMatches,
      decoded?.ok === true,
      decoded?.ok === true &&
        decoded.value.header.snapshot === expected.snapshot,
    );
    if (admission !== "admitted" || !decoded?.ok) {
      ports.post({
        type: "unavailable",
        reason: admission === "admitted" ? "malformed" : admission,
        detail: decoded?.ok === false ? decoded.error : "",
      });
      return;
    }
    index = decoded.value;
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
    const matches = matchIndex(current, parsed.value);
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
