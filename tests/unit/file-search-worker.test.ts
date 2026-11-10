import { createHash } from "node:crypto";
import type { LocalSearchReply } from "@public-phonebook/directory/local-search-protocol";
import { describe, expect, it } from "vitest";
import {
  fileSearchService,
  type TemporarySearchFiles,
} from "../../apps/web/src/ui/file-search-service.ts";
import { MemoryFile } from "./file-search-fixture.ts";
import { modelDirectory } from "./local-search-fixture.ts";

const snapshot = "d".repeat(64);
const { bytes } = modelDirectory(
  [
    {
      id: "c:1",
      name: "図書館",
      category: "library",
      prefectureCode: "13",
      municipalityCode: "13101",
      phones: [{ e164: "+81335812331" }],
    },
  ],
  snapshot,
);
const digest = createHash("sha256").update(bytes).digest("hex");
const location = {
  snapshot,
  url: `/api/search-index/${snapshot}/${digest}`,
  bytes: bytes.length,
  sha256: digest,
  uncompressedBytes: bytes.length,
  uncompressedSha256: digest,
};

function harness(
  payload: Uint8Array | (() => Uint8Array) = bytes,
  retire?: () => Promise<void>,
): {
  readonly receive: (message: unknown) => Promise<void>;
  readonly replies: LocalSearchReply[];
  readonly disposed: number[];
  readonly files: Readonly<
    Record<"raw" | "folded" | "names" | "phones", MemoryFile>
  >;
} {
  const replies: LocalSearchReply[] = [];
  const disposed: number[] = [];
  const files = {
    raw: new MemoryFile(),
    folded: new MemoryFile(),
    names: new MemoryFile(),
    phones: new MemoryFile(),
  };
  let opened = 0;
  const receive = fileSearchService({
    fetch: async () =>
      new Response(
        (typeof payload === "function" ? payload() : payload).slice(),
        {
          headers: {
            "Content-Encoding": "br",
            "Content-Length": String(bytes.length),
            ETag: `"${digest}"`,
            "X-Dataset-Snapshot": snapshot,
          },
        },
      ),
    post: (reply) => {
      replies.push(reply);
    },
    yield: async () => {},
    files: async (): Promise<TemporarySearchFiles> => {
      const candidate =
        opened++ === 0
          ? files
          : {
              raw: new MemoryFile(),
              folded: new MemoryFile(),
              names: new MemoryFile(),
              phones: new MemoryFile(),
            };
      return {
        ...candidate,
        dispose: async () => {
          await retire?.();
          disposed.push(1);
        },
      };
    },
  });
  return { receive, replies, disposed, files };
}

describe("file search worker admission", () => {
  it("does not publish an obsolete failure after a newer index is ready", async () => {
    let selected = bytes;
    let finish: () => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const disposing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const test = harness(
      () => selected,
      async () => {
        started();
        await waiting;
      },
    );
    await test.receive({ type: "load", index: location });
    selected = bytes.slice();
    selected[0] = 0;
    const obsolete = test.receive({ type: "load", index: location });
    await disposing;
    try {
      selected = bytes;
      await test.receive({ type: "load", index: location });
      expect(test.replies.at(-1)?.type).toBe("ready");
    } finally {
      finish();
      await obsolete;
    }
    expect(
      test.replies.filter((reply) => reply.type === "unavailable"),
    ).toHaveLength(0);
  });
  it("publishes a replacement before waiting for retired files", async () => {
    let finish: () => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const disposing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const test = harness(bytes, async () => {
      started();
      await waiting;
    });
    await test.receive({ type: "load", index: location });
    const replacement = test.receive({ type: "load", index: location });
    await disposing;
    try {
      await test.receive({ type: "search", id: 9, query: "図書館" });
      expect(test.replies.at(-1)).toMatchObject({
        type: "results",
        id: 9,
        total: 1,
      });
    } finally {
      finish();
      await replacement;
    }
  });

  it("keeps an admitted replacement when retired-file cleanup fails", async () => {
    const test = harness(bytes, async () => {
      throw new Error("Retired directory is temporarily busy");
    });
    await test.receive({ type: "load", index: location });
    await expect(
      test.receive({ type: "load", index: location }),
    ).resolves.toBeUndefined();
    await test.receive({ type: "search", id: 8, query: "図書館" });
    expect(test.replies.at(-1)).toMatchObject({
      type: "results",
      id: 8,
      total: 1,
    });
  });
  it("admits verified files and searches without another request", async () => {
    const test = harness();
    await test.receive({ type: "load", index: location });
    expect(test.replies.at(-1)?.type).toBe("ready");
    await test.receive({ type: "search", id: 1, query: "図書館" });
    expect(test.replies.at(-1)).toMatchObject({
      type: "results",
      total: 1,
      groups: [{ rows: [{ name: "図書館" }] }],
    });
    expect(test.files.raw.largestWrite).toBeLessThanOrEqual(65_536);
  });

  it("disposes failed candidates without publishing corrupt files", async () => {
    const payload = bytes.slice();
    payload[payload.length - 1] = 0;
    const test = harness(payload);
    await test.receive({ type: "load", index: location });
    expect(test.replies.at(-1)).toMatchObject({
      type: "unavailable",
      reason: "digest_mismatch",
    });
    expect(test.disposed).toHaveLength(1);
    await test.receive({ type: "search", id: 1, query: "図書館" });
    expect(test.replies.at(-1)).toEqual({
      type: "failed",
      id: 1,
      error: "not_ready",
    });
  });
});
