import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "../../tools/collection/artifacts.ts";

const roots: string[] = [];
async function cache(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "phonebook-artifacts-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("source artifact integrity", () => {
  it("deduplicates concurrent fetches and replays identical bytes offline", async () => {
    const root = await cache();
    const request = vi.fn<typeof fetch>(
      async (): Promise<Response> =>
        new Response("学校名,電話番号\n例小学校,0312345678\n", {
          headers: { etag: '"directory"' },
        }),
    );
    const store = new ArtifactStore(root, {
      request,
      minimumIntervalMs: 0,
      clock: (): string => "2026-10-30T00:00:00Z",
    });
    const [first, second] = await Promise.all([
      store.get("https://example.go.jp/schools.csv"),
      store.get("https://example.go.jp/schools.csv"),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    const offline = new ArtifactStore(root, { offline: true, request });
    expect(await offline.get(first.url)).toEqual(first);
    expect(new TextDecoder().decode(await offline.read(first))).toContain(
      "例小学校,0312345678",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("honors a conditional response without changing the original retrieval date", async () => {
    const root = await cache();
    const initial = new ArtifactStore(root, {
      request: async (): Promise<Response> =>
        new Response("data", {
          headers: {
            etag: '"a"',
            "last-modified": "Thu, 29 Oct 2026 00:00:00 GMT",
          },
        }),
      minimumIntervalMs: 0,
      clock: (): string => "2026-10-29T00:00:00Z",
    });
    const original = await initial.get("https://example.go.jp/data.csv");
    const request = vi.fn<typeof fetch>(
      async (_url, init): Promise<Response> => {
        const headers = new Headers(init?.headers);
        expect(headers.get("if-none-match")).toBe('"a"');
        expect(headers.get("if-modified-since")).toBe(
          "Thu, 29 Oct 2026 00:00:00 GMT",
        );
        return new Response(null, { status: 304 });
      },
    );
    const updated = await new ArtifactStore(root, {
      request,
      minimumIntervalMs: 0,
      clock: (): string => "2026-10-30T00:00:00Z",
    }).get(original.url);
    expect(updated.retrievedAt).toBe(original.retrievedAt);
    expect(updated.sha256).toBe(original.sha256);
    expect(updated.checkedAt).toBe("2026-10-30T00:00:00Z");
  });
  it("rejects corrupted cached bytes and never silently fetches in offline mode", async () => {
    const root = await cache();
    const store = new ArtifactStore(root, {
      request: async (): Promise<Response> => new Response("data"),
      minimumIntervalMs: 0,
    });
    const artifact = await store.get("https://example.go.jp/data.csv");
    await writeFile(join(root, "objects", artifact.sha256), "evil");
    await expect(
      new ArtifactStore(root, { offline: true }).get(artifact.url),
    ).rejects.toThrow("integrity failure");
    await expect(
      new ArtifactStore(root, { offline: true }).get(
        "https://example.go.jp/missing.csv",
      ),
    ).rejects.toThrow("not cached");
  });
  it("waits five seconds between requests to one origin and never across origins", async () => {
    const root = await cache();
    let now = 0;
    const waits: number[] = [];
    const store = new ArtifactStore(root, {
      request: async (): Promise<Response> => new Response("data"),
      now: (): number => now,
      sleep: async (milliseconds): Promise<void> => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });
    await store.get("https://example.go.jp/a.csv");
    now += 1000;
    await store.get("https://example.go.jp/b.csv");
    await store.get("https://other.go.jp/c.csv");
    await store.get("https://example.go.jp/d.csv");
    expect(waits).toEqual([4000, 5000]);
  });
  it.each([403, 429])(
    "stops requesting an origin for the run after HTTP %i, even while a request waits, and keeps other origins",
    async (status) => {
      const root = await cache();
      const request = vi.fn<typeof fetch>(
        async (url): Promise<Response> =>
          (typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url
          ).includes("refusing.go.jp")
            ? new Response("refused", {
                status,
                headers: { "retry-after": "0" },
              })
            : new Response("data"),
      );
      const store = new ArtifactStore(root, { request, minimumIntervalMs: 0 });
      // Either concurrent request may reach the origin first; the other must wait for the answer and never be sent.
      const settled = await Promise.allSettled([
        store.get("https://refusing.go.jp/a.csv"),
        store.get("https://refusing.go.jp/b.csv"),
      ]);
      const messages = settled
        .map((result) =>
          result.status === "rejected" && result.reason instanceof Error
            ? result.reason.message.replace(/: https:.*$/u, "")
            : result.status,
        )
        .sort();
      expect(messages).toEqual([
        `Source origin refused an earlier request with HTTP ${status}`,
        `Source returned HTTP ${status}`,
      ]);
      await expect(store.get("https://refusing.go.jp/c.csv")).rejects.toThrow(
        "refused an earlier request",
      );
      await expect(
        store.get("https://other.go.jp/data.csv"),
      ).resolves.toMatchObject({ bytes: 4 });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("lists every retrieved artifact once in URL order and leaves out failed retrievals", async () => {
    const root = await cache();
    const store = new ArtifactStore(root, {
      request: async (url): Promise<Response> => {
        const href =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        return href.includes("missing")
          ? new Response(null, { status: 404 })
          : new Response(href);
      },
      minimumIntervalMs: 0,
      clock: (): string => "2026-11-02T00:00:00Z",
    });
    const urls = [
      "https://example.go.jp/z.csv",
      "https://example.go.jp/a.csv",
      "https://example.go.jp/z.csv",
    ];
    const fetched = await Promise.all(urls.map((url) => store.get(url)));
    await expect(
      store.get("https://example.go.jp/missing.csv"),
    ).rejects.toThrow("HTTP 404");
    const listed = await store.artifacts();
    expect(listed.map((artifact) => artifact.url)).toEqual([
      "https://example.go.jp/a.csv",
      "https://example.go.jp/z.csv",
    ]);
    const offline = new ArtifactStore(root, { offline: true });
    for (const artifact of fetched) await offline.get(artifact.url);
    expect(JSON.stringify(await offline.artifacts())).toBe(
      JSON.stringify(listed),
    );
  });
  it("rejects untrusted protocol changes, oversized responses and uncached 304 responses", async () => {
    const root = await cache();
    await expect(
      new ArtifactStore(root).get("http://example.go.jp/data.csv"),
    ).rejects.toThrow("HTTPS");
    const oversized = new ArtifactStore(root, {
      request: async (): Promise<Response> =>
        new Response("", { headers: { "content-length": "33554433" } }),
      minimumIntervalMs: 0,
    });
    await expect(
      oversized.get("https://example.go.jp/oversized.csv"),
    ).rejects.toThrow("download limit");
    const unchanged = new ArtifactStore(root, {
      request: async (): Promise<Response> =>
        new Response(null, { status: 304 }),
      minimumIntervalMs: 0,
    });
    await expect(
      unchanged.get("https://example.go.jp/uncached.csv"),
    ).rejects.toThrow("Uncached source");
  });
});
