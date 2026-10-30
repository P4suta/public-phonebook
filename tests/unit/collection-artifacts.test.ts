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
  it("stops requests to a rate-limited host and preserves other hosts", async () => {
    const root = await cache();
    const request = vi.fn<typeof fetch>(
      async (url): Promise<Response> =>
        (typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).includes("limited.go.jp")
          ? new Response("retry later", {
              status: 429,
              headers: { "retry-after": "120" },
            })
          : new Response("data"),
    );
    const store = new ArtifactStore(root, { request, minimumIntervalMs: 0 });
    await expect(store.get("https://limited.go.jp/a.csv")).rejects.toThrow(
      "HTTP 429",
    );
    await expect(store.get("https://limited.go.jp/b.csv")).rejects.toThrow(
      "rate limit persists",
    );
    await expect(
      store.get("https://other.go.jp/data.csv"),
    ).resolves.toMatchObject({ bytes: 4 });
    expect(request).toHaveBeenCalledTimes(2);
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
