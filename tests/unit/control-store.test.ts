import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ControlStore,
  ControlStoreConflict,
  controlKeys,
  controlStoreFromEnvironment,
  fileControlStore,
  r2ControlStore,
  writeOnce,
  writePolicy,
} from "../../tools/control-store.ts";

const digest = "a".repeat(64);
const tree = "b".repeat(40);
const serverDate = "Sun, 01 Nov 2026 12:00:00 GMT";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phonebook-control-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("control keys", () => {
  it("names every planned prefix and classifies its write policy", () => {
    expect(controlKeys.blob(digest)).toBe(`blobs/sha256/${digest}`);
    expect(controlKeys.dataset(digest, "catalog.json")).toBe(
      `datasets/${digest}/catalog.json`,
    );
    expect(controlKeys.candidate(tree, digest, "e2e")).toBe(
      `candidates/${tree}/${digest}/e2e.json`,
    );
    expect(controlKeys.journalHistory("production", 7)).toBe(
      "journals/production/history/000000000007.json",
    );
    const policies = {
      [controlKeys.blob(digest)]: "write-once",
      [controlKeys.dataset(digest, "manifest.ready.json")]: "write-once",
      [controlKeys.collection(digest, "report.json")]: "write-once",
      [controlKeys.collectionCache(digest)]: "write-once",
      [controlKeys.candidate(tree, digest, "check")]: "write-once",
      [controlKeys.journalHead("production")]: "conditional",
      [controlKeys.lease("production")]: "conditional",
      [controlKeys.journalHistory("production", 1)]: "append-only",
      [controlKeys.evidence("imported", digest)]: "append-only",
    };
    for (const [key, policy] of Object.entries(policies))
      expect(writePolicy(key), key).toBe(policy);
    for (const unsafe of [
      "../outside",
      "blobs/../journals/production/head.json",
      "blobs/sha256/UPPER",
      "unknown/key",
      "single",
    ])
      expect(() => writePolicy(unsafe), unsafe).toThrow();
    expect(() => controlKeys.blob("short")).toThrow();
    expect(() => controlKeys.candidate("tree", digest, "e2e")).toThrow();
    expect(() => controlKeys.journalHistory("production", 0)).toThrow();
  });
});

describe("file control store", () => {
  it("creates once, replaces only the current entity tag, and answers 412 otherwise", async () => {
    const store = fileControlStore(directory);
    const key = controlKeys.journalHead("production");
    expect((await store.read(key)).object).toBeNull();
    expect(await store.head(key)).toBeNull();
    await expect(
      store.write(key, bytes("first"), { kind: "replace", etag: '"none"' }),
    ).rejects.toMatchObject({ status: 412 });
    const first = await store.write(key, bytes("first"), { kind: "create" });
    expect(first.etag).toMatch(/^"[0-9a-f]{64}"$/u);
    await expect(
      store.write(key, bytes("second"), { kind: "create" }),
    ).rejects.toMatchObject({ status: 412 });
    const second = await store.write(key, bytes("second"), {
      kind: "replace",
      etag: first.etag,
    });
    await expect(
      store.write(key, bytes("third"), { kind: "replace", etag: first.etag }),
    ).rejects.toBeInstanceOf(ControlStoreConflict);
    const current = await store.read(key);
    expect(new TextDecoder().decode(current.object?.body)).toBe("second");
    expect(current.object?.etag).toBe(second.etag);
    expect(await store.head(key)).toEqual({ etag: second.etag, bytes: 6 });
  });

  it("refuses to replace write-once and append-only keys", async () => {
    const store = fileControlStore(directory);
    await expect(
      store.write(`${digest}/${digest}/contacts.csv.gz`, bytes("x"), {
        kind: "create",
      }),
    ).rejects.toThrow("Unsupported control key");
    for (const key of [
      controlKeys.blob(digest),
      controlKeys.journalHistory("production", 1),
    ]) {
      const written = await store.write(key, bytes("x"), { kind: "create" });
      await expect(
        store.write(key, bytes("y"), { kind: "replace", etag: written.etag }),
      ).rejects.toThrow("can't be replaced");
    }
  });

  it("answers 409 for an existing object under a locked prefix before evaluating conditions", async () => {
    const store = fileControlStore(directory, {
      lockedPrefixes: ["journals/production/history/", "evidence/"],
    });
    const key = controlKeys.journalHistory("production", 1);
    await store.write(key, bytes("x"), { kind: "create" });
    await expect(
      store.write(key, bytes("x"), { kind: "create" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await writeOnce(store, key, bytes("x"))).toBe("unchanged");
    await expect(writeOnce(store, key, bytes("y"))).rejects.toThrow(
      "different bytes",
    );
  });

  it("reports its injected clock as the observed server time", async () => {
    const clock = new Date("2030-01-02T03:04:05.000Z");
    const store = fileControlStore(directory, { now: () => clock });
    const key = controlKeys.lease("production");
    expect((await store.read(key)).observedAt).toEqual(clock);
    expect(
      (await store.write(key, bytes("x"), { kind: "create" })).observedAt,
    ).toEqual(clock);
  });

  it("serializes concurrent creators so exactly one wins", async () => {
    const store = fileControlStore(directory);
    const key = controlKeys.lease("production");
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        store.write(key, bytes(String(index)), { kind: "create" }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ControlStoreConflict &&
          result.reason.status === 412,
      ),
    ).toHaveLength(7);
  });
});

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

async function fakeR2(
  respond: (request: Received) => {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{
  endpoint: URL;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: new TextDecoder().decode(joined(chunks)),
      };
      received.push(entry);
      const answer = respond(entry);
      response.writeHead(answer.status, {
        Date: serverDate,
        ...answer.headers,
      });
      response.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (!address || typeof address === "string")
    throw new Error("The fake R2 server has no port");
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}`),
    received,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function r2(endpoint: URL): ControlStore {
  return r2ControlStore({
    endpoint,
    bucket: "dial-control",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    pause: async () => undefined,
  });
}

describe("R2 control store", () => {
  it("signs conditional writes, sends the payload digest and length, and maps 412 and 409", async () => {
    const statuses = [200, 412, 409, 200];
    const server = await fakeR2(() => ({
      status: statuses.shift() ?? 500,
      headers: { ETag: '"etag-1"' },
      body: "<Error><Code>PreconditionFailed</Code></Error>",
    }));
    try {
      const store = r2(server.endpoint);
      const key = controlKeys.journalHead("production");
      const result = await store.write(key, bytes("body"), { kind: "create" });
      expect(result).toEqual({
        etag: '"etag-1"',
        observedAt: new Date(serverDate),
      });
      await expect(
        store.write(key, bytes("body"), { kind: "replace", etag: '"etag-1"' }),
      ).rejects.toMatchObject({ status: 412 });
      await expect(
        store.write(controlKeys.journalHistory("production", 1), bytes("x"), {
          kind: "create",
        }),
      ).rejects.toMatchObject({ status: 409 });
      const file = join(directory, "blob");
      await writeFile(file, "streamed body");
      const sha256 = createHash("sha256").update("streamed body").digest("hex");
      await store.write(
        controlKeys.blob(sha256),
        { path: file, bytes: 13, sha256 },
        { kind: "create" },
      );
      const [created, replaced, , streamed] = server.received;
      expect(created?.method).toBe("PUT");
      expect(created?.url).toBe("/dial-control/journals/production/head.json");
      expect(created?.headers["if-none-match"]).toBe("*");
      expect(created?.headers["if-match"]).toBeUndefined();
      expect(created?.headers["x-amz-content-sha256"]).toBe(
        createHash("sha256").update("body").digest("hex"),
      );
      expect(created?.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*if-none-match.*, Signature=[0-9a-f]{64}$/u,
      );
      expect(
        JSON.stringify(server.received.map((entry) => entry.headers)),
      ).not.toContain("test-secret-key");
      expect(replaced?.headers["if-match"]).toBe('"etag-1"');
      expect(replaced?.headers["if-none-match"]).toBeUndefined();
      expect(streamed?.headers["content-length"]).toBe("13");
      expect(streamed?.headers["transfer-encoding"]).toBeUndefined();
      expect(streamed?.headers["x-amz-content-sha256"]).toBe(sha256);
      expect(streamed?.body).toBe("streamed body");
    } finally {
      await server.close();
    }
  });

  it("reads objects and absence with the server's time and refuses unlisted buckets", async () => {
    const server = await fakeR2((request) =>
      request.url.endsWith("head.json")
        ? { status: 200, headers: { ETag: '"tag"' }, body: "journal" }
        : { status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" },
    );
    try {
      const store = r2(server.endpoint);
      const found = await store.read(controlKeys.journalHead("production"));
      expect(found.observedAt).toEqual(new Date(serverDate));
      expect(new TextDecoder().decode(found.object?.body)).toBe("journal");
      expect(found.object?.etag).toBe('"tag"');
      const missing = await store.read(controlKeys.lease("production"));
      expect(missing).toEqual({
        observedAt: new Date(serverDate),
        object: null,
      });
      expect(() =>
        r2ControlStore({
          endpoint: server.endpoint,
          bucket: "another-bucket",
          accessKeyId: "a",
          secretAccessKey: "b",
        }),
      ).toThrow("unlisted bucket");
    } finally {
      await server.close();
    }
  });

  it("streams a downloaded object to a file and reports absence", async () => {
    const server = await fakeR2((request) =>
      request.url.endsWith(digest)
        ? { status: 200, headers: { ETag: '"blob"' }, body: "blob bytes" }
        : { status: 404 },
    );
    try {
      const store = r2(server.endpoint);
      const target = join(directory, "download");
      expect(await store.download(controlKeys.blob(digest), target)).toEqual({
        etag: '"blob"',
        bytes: 10,
      });
      expect(await readFile(target, "utf8")).toBe("blob bytes");
      expect(
        await store.download(controlKeys.blob("c".repeat(64)), target),
      ).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("treats a retried create that finds its own committed bytes as written", async () => {
    let calls = 0;
    const server = await fakeR2((request) => {
      calls += 1;
      if (request.method === "PUT" && calls === 1) return { status: 503 };
      if (request.method === "PUT") return { status: 412 };
      return { status: 200, headers: { ETag: '"committed"' }, body: "mine" };
    });
    try {
      const result = await r2(server.endpoint).write(
        controlKeys.lease("production"),
        bytes("mine"),
        { kind: "create" },
      );
      expect(result.etag).toBe('"committed"');
      expect(server.received.map((entry) => entry.method)).toEqual([
        "PUT",
        "PUT",
        "GET",
      ]);
    } finally {
      await server.close();
    }
  });

  it("names the credential variables without echoing their values", () => {
    expect(() =>
      controlStoreFromEnvironment("dial-control", {
        CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
        R2_ACCESS_KEY_ID: "visible-access",
      }),
    ).toThrow(
      "The control store requires CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY",
    );
    try {
      controlStoreFromEnvironment("dial-control", {
        CLOUDFLARE_ACCOUNT_ID: "invalid",
        R2_ACCESS_KEY_ID: "visible-access",
        R2_SECRET_ACCESS_KEY: "hidden-secret",
      });
    } catch (error) {
      expect(String(error)).not.toContain("hidden-secret");
      expect(String(error)).not.toContain("visible-access");
    }
  });
});
