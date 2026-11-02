import { createHash } from "node:crypto";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  indexProgressSteps,
  type LocalSearchReply,
  LocalSearchReplySchema,
} from "../../src/core/local-search-protocol.ts";
import { localSearchService } from "../../src/ui/local-search-service.ts";
import { type ModelContact, modelDirectory } from "./local-search-fixture.ts";

const snapshot = "d".repeat(64);
const indexPath = `/api/search-index/${snapshot}/index`;
const chunkCount = 7;
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function withoutProgress(
  replies: readonly LocalSearchReply[],
): LocalSearchReply[] {
  return replies.filter((reply) => reply.type !== "progress");
}

interface Harness {
  readonly handle: (message: unknown) => Promise<void>;
  readonly replies: LocalSearchReply[];
  readonly requested: string[];
  readonly network: { online: boolean };
}

function harness(body: Uint8Array, status = 200): Harness {
  const replies: LocalSearchReply[] = [];
  const requested: string[] = [];
  const network = { online: true };
  return {
    replies,
    requested,
    network,
    handle: localSearchService({
      fetch: async (url) => {
        requested.push(url);
        if (!network.online) throw new TypeError("Failed to fetch");
        return new Response(body.slice(), { status });
      },
      post: (reply) => {
        replies.push(v.parse(LocalSearchReplySchema, reply));
      },
    }),
  };
}

function load(
  bytes: Uint8Array,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "load",
    url: indexPath,
    snapshot,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    ...overrides,
  };
}

function row(
  position: number,
  name: string,
  category: string,
  phone: string,
): Record<string, unknown> {
  return { row: position, name, category, region: "13101", phones: [phone] };
}

describe("local search worker", () => {
  it("fetches only the index once and keeps searching offline", async () => {
    const { bytes } = modelDirectory(contacts, snapshot);
    const worker = harness(bytes);
    await worker.handle(load(bytes));
    expect(worker.replies.at(-1)).toMatchObject({
      type: "ready",
      snapshot,
      contacts: contacts.length,
    });
    worker.network.online = false;
    await worker.handle({ type: "search", id: 1, query: "図書館" });
    expect(worker.replies.at(-1)).toEqual({
      type: "results",
      id: 1,
      total: 3,
      groups: [
        {
          category: "library",
          total: 2,
          rows: [
            row(1, "図書館", "library", "0335812331"),
            row(3, "市立図書館", "library", "0774981200"),
          ],
        },
        {
          category: "medical",
          total: 1,
          rows: [row(2, "図書館", "medical", "0335812331")],
        },
      ],
    });
    await worker.handle({
      type: "continue",
      id: 2,
      query: "図書館",
      category: "library",
      visible: 0,
    });
    expect(worker.replies.at(-1)).toEqual({
      type: "page",
      id: 2,
      category: "library",
      total: 2,
      visible: 2,
      rows: [
        row(1, "図書館", "library", "0335812331"),
        row(3, "市立図書館", "library", "0774981200"),
      ],
    });
    await worker.handle({ type: "search", id: 3, query: "ａ診療所" });
    expect(worker.replies.at(-1)).toEqual({
      type: "results",
      id: 3,
      total: 1,
      groups: [
        {
          category: "medical",
          total: 1,
          rows: [row(0, "Ａ診療所", "medical", "09012345678")],
        },
      ],
    });
    await worker.handle({ type: "search", id: 4, query: "03-3581-2331" });
    expect(worker.replies.at(-1)).toMatchObject({ type: "results", total: 2 });
    expect(worker.requested).toEqual([indexPath]);
  });

  it("answers requests it can't serve without throwing", async () => {
    const { bytes } = modelDirectory(contacts, snapshot);
    const worker = harness(bytes);
    await worker.handle({ type: "search", id: 1, query: "図書館" });
    await worker.handle(load(bytes));
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

  it("falls back when the index differs from its published checks", async () => {
    const { bytes } = modelDirectory(contacts, snapshot);
    const other = modelDirectory(contacts, "e".repeat(64)).bytes;
    const unsigned = bytes.slice();
    unsigned[0] = 0x50;
    const truncated = bytes.slice(0, -1);
    const cases = [
      [bytes, load(bytes, { bytes: bytes.byteLength + 1 }), "length_mismatch"],
      [bytes, load(bytes, { sha256: "0".repeat(64) }), "digest_mismatch"],
      [unsigned, load(unsigned), "signature_mismatch"],
      [truncated, load(truncated), "malformed"],
      [other, load(other), "snapshot_mismatch"],
    ] as const;
    for (const [body, message, reason] of cases) {
      const worker = harness(body);
      await worker.handle(message);
      expect(withoutProgress(worker.replies)).toEqual([
        {
          type: "unavailable",
          reason,
          detail:
            reason === "malformed"
              ? "Error: The search index length differs from its header"
              : "",
        },
      ]);
      await worker.handle({ type: "search", id: 1, query: "図書館" });
      expect(worker.replies.at(-1)).toEqual({
        type: "failed",
        id: 1,
        error: "not_ready",
      });
    }
    const missing = harness(bytes, 404);
    await missing.handle(load(bytes));
    const offline = harness(bytes);
    offline.network.online = false;
    await offline.handle(load(bytes));
    expect([...missing.replies, ...offline.replies]).toEqual([
      {
        type: "unavailable",
        reason: "fetch_failed",
        detail: "The index responded 404",
      },
      {
        type: "unavailable",
        reason: "fetch_failed",
        detail: "TypeError: Failed to fetch",
      },
    ]);
  });

  it("keeps only the newest index when loads overlap", async () => {
    const current = modelDirectory(contacts, snapshot).bytes;
    const stale = modelDirectory(contacts.slice(1), snapshot).bytes;
    const replies: LocalSearchReply[] = [];
    const pending: ((response: Response) => void)[] = [];
    const handle = localSearchService({
      fetch: async () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
      post: (reply) => {
        replies.push(v.parse(LocalSearchReplySchema, reply));
      },
    });
    const first = handle(load(stale));
    const second = handle(load(current));
    pending[1]?.(new Response(current.slice()));
    await second;
    const answered = replies.length;
    pending[0]?.(new Response(stale.slice()));
    await first;
    expect(replies).toHaveLength(answered);
    expect(withoutProgress(replies)).toHaveLength(1);
    expect(replies.at(-1)).toMatchObject({
      type: "ready",
      contacts: contacts.length,
    });
  });

  it("reports the decoded bytes in bounded, increasing steps", async () => {
    const { bytes } = modelDirectory(contacts, snapshot);
    const chunk = Math.ceil(bytes.byteLength / chunkCount);
    const replies: LocalSearchReply[] = [];
    const handle = localSearchService({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              for (let offset = 0; offset < bytes.byteLength; offset += chunk)
                controller.enqueue(bytes.slice(offset, offset + chunk));
              controller.close();
            },
          }),
        ),
      post: (reply) => {
        replies.push(v.parse(LocalSearchReplySchema, reply));
      },
    });
    await handle(load(bytes));
    const progress = replies.flatMap((reply) =>
      reply.type === "progress" ? [reply] : [],
    );
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBeLessThanOrEqual(indexProgressSteps);
    expect(progress.every((reply) => reply.total === bytes.byteLength)).toBe(
      true,
    );
    expect(
      progress.every(
        (reply, index) =>
          index === 0 || reply.received > (progress[index - 1]?.received ?? 0),
      ),
    ).toBe(true);
    expect(progress.at(-1)?.received).toBe(bytes.byteLength);
    expect(replies.at(-1)).toMatchObject({ type: "ready" });
  });

  it("answers from the current index until a replacement is admitted, and drops it when the replacement fails", async () => {
    const current = modelDirectory(contacts, snapshot).bytes;
    const replacement = modelDirectory(contacts.slice(1), snapshot).bytes;
    const replies: LocalSearchReply[] = [];
    const pending: ((response: Response) => void)[] = [];
    const handle = localSearchService({
      fetch: async () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
      post: (reply) => {
        replies.push(v.parse(LocalSearchReplySchema, reply));
      },
    });
    const first = handle(load(current));
    pending[0]?.(new Response(current.slice()));
    await first;
    const second = handle(load(replacement));
    await handle({ type: "search", id: 1, query: "図書館" });
    expect(replies.at(-1)).toMatchObject({ type: "results", id: 1, total: 3 });
    pending[1]?.(new Response(replacement.slice()));
    await second;
    await handle({ type: "search", id: 2, query: "図書館" });
    expect(replies.at(-1)).toMatchObject({ type: "results", id: 2, total: 2 });
    const failing = handle(load(current));
    pending[2]?.(new Response(null, { status: 404 }));
    await failing;
    await handle({ type: "search", id: 3, query: "図書館" });
    expect(replies.at(-1)).toEqual({
      type: "failed",
      id: 3,
      error: "not_ready",
    });
  });

  it("refuses malformed messages and foreign index locations", async () => {
    const { bytes } = modelDirectory(contacts, snapshot);
    const worker = harness(bytes);
    for (const url of ["https://example.org/index", "//example.org/x", "/\\x"])
      await expect(worker.handle(load(bytes, { url }))).rejects.toThrow();
    await expect(
      worker.handle({ type: "search", query: "x" }),
    ).rejects.toThrow();
    expect(worker.requested).toEqual([]);
  });
});
