import { createHash } from "node:crypto";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import {
  indexProgressSteps,
  type LocalSearchReply,
  LocalSearchReplySchema,
  type LocalSearchRequest,
} from "../../src/core/local-search-protocol.ts";
import { decodeSearchIndex } from "../../src/core/search-index.ts";
import { encodeRankingArtifact } from "../../src/core/search-ranking-artifact.ts";
import { createRanking } from "../../src/ui/forgiving-search-loader.ts";
import { localSearchService } from "../../src/ui/local-search-service.ts";
import { buildRankingArtifact } from "../../tools/search-ranking.ts";
import { type ModelContact, modelDirectory } from "./local-search-fixture.ts";

const snapshot = "d".repeat(64);
const contacts: ModelContact[] = [
  ["c:1", "図書館", "library", "+81335812331"],
  ["c:2", "図書館", "medical", "+81335812331"],
  ["c:3", "市立図書館", "library", "+81774981200"],
  ["c:4", "Ａ診療所", "medical", "+819012345678"],
].map(([id = "", name = "", category = "", e164 = ""]) => ({
  id,
  name,
  category,
  prefectureCode: "13",
  municipalityCode: "13101",
  phones: [{ e164 }],
}));

type Load = Extract<LocalSearchRequest, { type: "load-forgiving" }>;
type Location = Load["index"];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function location(kind: string, bytes: Uint8Array): Location {
  return {
    snapshot,
    url: `/api/${kind}/${snapshot}/${sha256(bytes)}`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    uncompressedBytes: bytes.length,
    uncompressedSha256: sha256(bytes),
  };
}

function fixture(rows = contacts): {
  readonly index: Uint8Array;
  readonly ranking: Uint8Array;
  readonly load: Load;
} {
  const { bytes: index } = modelDirectory(rows, snapshot);
  const decoded = decodeSearchIndex(index);
  const ranking = encodeRankingArtifact(
    buildRankingArtifact(
      decoded,
      {
        readings: decoded.rows.map((entry) =>
          entry.name.replaceAll("図書館", "トショカン"),
        ),
        lexicon: [["図書館", "トショカン", 10]],
      },
      [],
    ),
  );
  return {
    index,
    ranking,
    load: {
      type: "load-forgiving",
      index: location("search-index", index),
      ranking: {
        ...location("search-ranking", ranking),
        format: "public-phonebook-search-ranking/1",
      },
    },
  };
}

function response(bytes: Uint8Array, expected: Location): Response {
  return new Response(bytes.slice(), {
    headers: {
      "Content-Encoding": "br",
      "Content-Length": String(expected.bytes),
      ETag: `"${expected.sha256}"`,
      "X-Dataset-Snapshot": expected.snapshot,
    },
  });
}

function harness(
  source = fixture(),
  fetcher?: (url: string) => Promise<Response>,
): {
  readonly handle: (message: unknown) => Promise<void>;
  readonly replies: LocalSearchReply[];
  readonly requested: string[];
} {
  const replies: LocalSearchReply[] = [];
  const requested: string[] = [];
  return {
    replies,
    requested,
    handle: localSearchService(
      {
        fetch: async (url) => {
          requested.push(url);
          if (fetcher) return fetcher(url);
          return url === source.load.index.url
            ? response(source.index, source.load.index)
            : response(source.ranking, source.load.ranking);
        },
        post: (reply) => {
          replies.push(v.parse(LocalSearchReplySchema, reply));
        },
      },
      createRanking,
    ),
  };
}

describe("local search worker", () => {
  it("matches names and verified place readings with only the name index", async () => {
    const source = fixture();
    const replies: LocalSearchReply[] = [];
    const fetcher = vi.fn(async () =>
      response(source.index, source.load.index),
    );
    const handle = localSearchService({
      fetch: fetcher,
      post: (reply) => replies.push(reply),
    });
    await handle({ type: "load", index: source.load.index });
    expect(replies.at(-1)).toMatchObject({ type: "ready" });
    for (const [query, total] of [
      ["図書館", 3],
      ["としょかん", 2],
      ["とうきょう としょかん", 2],
      ["東京 図書館", 3],
      ["03-3581-2331", 2],
    ] as const) {
      await handle({ type: "search", id: 1, query });
      const reply = replies.at(-1);
      expect(reply).toMatchObject({ type: "results", total });
      if (query === "図書館")
        expect(
          reply?.type === "results"
            ? reply.groups.flatMap((group) => group.rows.map((row) => row.name))
            : [],
        ).toEqual(["図書館", "市立図書館", "図書館"]);
    }
    await handle(source.load);
    expect(replies.at(-1)).toMatchObject({ type: "unavailable" });
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("admits both artifacts and searches kana and complete numbers offline", async () => {
    const source = fixture();
    const worker = harness(source);
    await worker.handle(source.load);
    expect(worker.replies.at(-1)).toMatchObject({
      type: "ready",
      snapshot,
      contacts: contacts.length,
    });
    for (const query of ["図書館", "としょかん"]) {
      await worker.handle({ type: "search", id: 1, query });
      expect(worker.replies.at(-1)).toMatchObject({
        type: "results",
        total: 2,
      });
    }
    await worker.handle({ type: "search", id: 2, query: "03-3581-2331" });
    expect(worker.replies.at(-1)).toMatchObject({ type: "results", total: 2 });
    await worker.handle({
      type: "continue",
      id: 3,
      query: "図書館",
      category: "library",
      visible: 0,
    });
    expect(worker.replies.at(-1)).toMatchObject({
      type: "page",
      total: 1,
      visible: 1,
      rows: [{ row: 1 }],
    });
    expect(worker.requested).toEqual([
      source.load.index.url,
      source.load.ranking.url,
    ]);
  });

  it("rejects malformed literal rows before replacing an admitted index", async () => {
    const source = fixture();
    const invalid = source.index.slice();
    const headerEnd = invalid.indexOf(0x0a, invalid.indexOf(0x0a) + 1);
    invalid[headerEnd + 1] = 0x62;
    const changed = location("search-index", invalid);
    const worker = harness(source, async (url) =>
      url === changed.url
        ? response(invalid, changed)
        : response(source.index, source.load.index),
    );
    await worker.handle({ type: "load", index: source.load.index });
    expect(worker.replies.at(-1)).toMatchObject({ type: "ready" });
    await worker.handle({ type: "load", index: changed });
    expect(worker.replies.at(-1)).toMatchObject({
      type: "unavailable",
      reason: "malformed",
    });
    await worker.handle({ type: "search", id: 1, query: "図書館" });
    expect(worker.replies.at(-1)).toEqual({
      type: "failed",
      id: 1,
      error: "not_ready",
    });
  });

  it("passes original spelling to the exact-name guard", async () => {
    const source = fixture(
      ["国立図書館", "國立図書館"].map((name, position) => ({
        id: `variant:${position}`,
        name,
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: "+81335812331" }],
      })),
    );
    const worker = harness(source);
    await worker.handle(source.load);
    await worker.handle({ type: "search", id: 1, query: "國立図書館" });
    const reply = worker.replies.at(-1);
    expect(
      reply?.type === "results" ? reply.groups[0]?.rows[0]?.name : null,
    ).toBe("國立図書館");
  });

  it("answers invalid queries and continuations without throwing", async () => {
    const source = fixture();
    const worker = harness(source);
    await worker.handle({ type: "search", id: 1, query: "図書館" });
    await worker.handle(source.load);
    await worker.handle({ type: "search", id: 2, query: "図書館\0" });
    await worker.handle({
      type: "continue",
      id: 3,
      query: "図書館",
      category: "library",
      visible: 3,
    });
    expect(worker.replies.filter((reply) => reply.type === "failed")).toEqual([
      { type: "failed", id: 1, error: "not_ready" },
      { type: "failed", id: 2, error: "invalid_query" },
      { type: "failed", id: 3, error: "invalid_continuation" },
    ]);
  });

  it("rejects either artifact's length, digest, transport, or malformed content", async () => {
    const source = fixture();
    for (const kind of ["index", "ranking"] as const) {
      for (const defect of [
        "length",
        "digest",
        "transport",
        "malformed",
        "missing",
      ] as const) {
        const bytes = source[kind];
        const invalid = new Uint8Array(bytes.length).fill(42);
        const expected = source.load[kind];
        const message = {
          ...source.load,
          [kind]: {
            ...expected,
            uncompressedBytes: bytes.length + (defect === "length" ? 1 : 0),
            uncompressedSha256:
              defect === "malformed"
                ? sha256(invalid)
                : defect === "digest"
                  ? "0".repeat(64)
                  : sha256(bytes),
          },
        };
        const worker = harness(source, async (url) => {
          if (url !== expected.url)
            return response(source.index, source.load.index);
          if (defect === "missing") return new Response(null, { status: 404 });
          const reply = response(
            defect === "malformed" ? invalid : bytes,
            expected,
          );
          if (defect === "transport") reply.headers.set("ETag", '"wrong"');
          return reply;
        });
        await worker.handle(message);
        expect(worker.replies.at(-1), `${kind}:${defect}`).toMatchObject({
          type: "unavailable",
        });
        await worker.handle({ type: "search", id: 1, query: "図書館" });
        expect(worker.replies.at(-1)).toEqual({
          type: "failed",
          id: 1,
          error: "not_ready",
        });
      }
    }
  });

  it("rejects a ranking companion with a different contact count", async () => {
    const source = fixture();
    const smaller = fixture(contacts.slice(1));
    const worker = harness(source, async (url) =>
      url === source.load.index.url
        ? response(source.index, source.load.index)
        : response(smaller.ranking, smaller.load.ranking),
    );
    await worker.handle({ ...source.load, ranking: smaller.load.ranking });
    expect(worker.replies.at(-1)).toMatchObject({
      type: "unavailable",
      reason: "malformed",
    });
  });

  it("keeps the admitted pair during replacement and ignores stale loads", async () => {
    const source = fixture();
    const replacement = fixture(contacts.slice(1));
    const pending = new Map<string, (value: Response) => void>();
    let held = false;
    const worker = harness(source, async (url) => {
      if (held)
        return new Promise<Response>((resolve) => {
          pending.set(url, resolve);
        });
      return url === source.load.index.url
        ? response(source.index, source.load.index)
        : response(source.ranking, source.load.ranking);
    });
    await worker.handle(source.load);
    held = true;
    const stale = worker.handle(source.load);
    const latest = worker.handle(replacement.load);
    await worker.handle({ type: "search", id: 1, query: "図書館" });
    expect(worker.replies.at(-1)).toMatchObject({ type: "results", total: 2 });
    pending.get(replacement.load.index.url)?.(
      response(replacement.index, replacement.load.index),
    );
    await vi.waitFor(() => {
      expect(pending.has(replacement.load.ranking.url)).toBe(true);
    });
    pending.get(replacement.load.ranking.url)?.(
      response(replacement.ranking, replacement.load.ranking),
    );
    await latest;
    const answered = worker.replies.length;
    pending.get(source.load.index.url)?.(
      response(source.index, source.load.index),
    );
    await stale;
    expect(worker.replies).toHaveLength(answered);
    await worker.handle({ type: "search", id: 2, query: "図書館" });
    expect(worker.replies.at(-1)).toMatchObject({ type: "results", total: 1 });
  });

  it("reports increasing progress across both decoded artifacts", async () => {
    const source = fixture();
    const worker = harness(source);
    await worker.handle(source.load);
    const progress = worker.replies.flatMap((reply) =>
      reply.type === "progress" ? [reply] : [],
    );
    expect(progress.length).toBeLessThanOrEqual(indexProgressSteps);
    expect(
      progress.every(
        (reply, i) =>
          reply.total === source.index.length + source.ranking.length &&
          (i === 0 || reply.received > (progress[i - 1]?.received ?? 0)),
      ),
    ).toBe(true);
    expect(progress.at(-1)?.received).toBe(
      source.index.length + source.ranking.length,
    );
  });

  it("refuses foreign artifact locations before fetching", async () => {
    const source = fixture();
    const worker = harness(source);
    for (const kind of ["index", "ranking"] as const)
      await expect(
        worker.handle({
          ...source.load,
          [kind]: { ...source.load[kind], url: "https://example.org/index" },
        }),
      ).rejects.toThrow();
    expect(worker.requested).toEqual([]);
  });
});
