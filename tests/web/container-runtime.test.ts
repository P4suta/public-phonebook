import assert from "node:assert/strict";
import test from "node:test";
import {
  type DirectoryContainer,
  DirectoryRuntime,
  type DirectoryStartOptions,
} from "../../cloudflare/container-runtime.ts";

const IMAGE = "registry.example/directory@sha256:" + "a".repeat(64);
const IDLE_MS = 600_000;
const MAX_ATTEMPTS = 180;
const CONCURRENT_REQUESTS = 20;

class FakeContainer implements DirectoryContainer {
  running = false;
  images: Record<string, string> = { directory: IMAGE };
  image: string | null = null;
  labels: Record<string, string> = { profile: "standard-1" };
  starts: DirectoryStartOptions[] = [];
  timeouts: number[] = [];
  requests: Request[] = [];
  destroyed = 0;
  probes = 0;
  canceled = 0;
  failures = 0;
  startFailures = 0;
  statuses: number[] = [];
  gate: (() => Promise<void>) | undefined;

  start(options: DirectoryStartOptions): void {
    this.starts.push(options);
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new Error("allocation is still stopping");
    }
    this.running = true;
    this.image = options.image;
    this.labels = { ...options.labels };
  }

  async inspect(): Promise<{
    image: string;
    labels: Record<string, string>;
  } | null> {
    return this.running
      ? { image: this.image ?? "", labels: this.labels }
      : null;
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
    this.running = false;
    this.image = null;
  }

  async setInactivityTimeout(durationMs: number): Promise<void> {
    this.timeouts.push(durationMs);
  }

  getTcpPort(port: number): { fetch: (request: Request) => Promise<Response> } {
    assert.equal(port, 8080);
    return { fetch: (request) => this.fetch(request) };
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/healthz") {
      this.probes += 1;
      assert.equal(this.running, true);
      await this.gate?.();
      if (this.failures > 0) {
        this.failures -= 1;
        throw new Error("port is not ready");
      }
      return new Response(
        new ReadableStream({
          cancel: () => {
            this.canceled += 1;
          },
        }),
        { status: this.statuses.shift() ?? 200 },
      );
    }
    this.requests.push(request);
    request.signal.throwIfAborted();
    return new Response("directory");
  }
}

function fixture(): {
  container: FakeContainer;
  directory: DirectoryRuntime;
  pauses: number[];
} {
  const container = new FakeContainer();
  const pauses: number[] = [];
  return {
    container,
    pauses,
    directory: new DirectoryRuntime(container, async (durationMs) => {
      pauses.push(durationMs);
    }),
  };
}

test("cold startup pins the image, blocks internet, waits for health and releases probe bodies", async () => {
  const { directory, container, pauses } = fixture();
  container.failures = 2;
  container.statuses = [503, 200];
  const request = new Request("https://directory.example/search?q=library");
  const response = await directory.fetch(request);
  assert.equal(await response.text(), "directory");
  assert.deepEqual(container.starts, [
    {
      image: IMAGE,
      instance: "standard-1",
      enableInternet: false,
      labels: { profile: "standard-1" },
    },
  ]);
  assert.equal(container.probes, 4);
  assert.equal(container.canceled, 2);
  assert.deepEqual(pauses, [500, 500, 500]);
  assert.equal(container.requests[0], request);
  assert.ok(container.timeouts.every((value) => value === IDLE_MS));
});

test("concurrent requests share one startup without sharing client cancellation", async () => {
  const { directory, container } = fixture();
  let release = (): void => assert.fail("the gate is not installed");
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = (): void => assert.fail("the observer is not installed");
  const observed = new Promise<void>((resolve) => {
    started = resolve;
  });
  container.gate = async () => {
    started();
    await gate;
  };
  const controller = new AbortController();
  const requests = Array.from({ length: CONCURRENT_REQUESTS }, (_, index) =>
    directory.fetch(
      new Request("https://directory.example/contact/" + index, {
        signal: index === 0 ? controller.signal : null,
      }),
    ),
  );
  await observed;
  controller.abort();
  release();
  const results = await Promise.allSettled(requests);
  assert.equal(container.starts.length, 1);
  assert.equal(container.probes, 1);
  assert.equal(container.requests.length, CONCURRENT_REQUESTS);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    CONCURRENT_REQUESTS - 1,
  );
  assert.equal(results[0]?.status, "rejected");
});

test("a warm object restores inactivity and replaces an obsolete image before forwarding", async () => {
  const { directory, container } = fixture();
  container.running = true;
  container.image = IMAGE;
  await directory.restore();
  assert.deepEqual(container.timeouts, [IDLE_MS]);
  await directory.fetch(new Request("https://directory.example/"));
  assert.equal(container.starts.length, 0);
  container.image = "registry.example/obsolete";
  await directory.fetch(new Request("https://directory.example/"));
  assert.equal(container.destroyed, 1);
  assert.equal(container.starts.length, 1);
  assert.equal(container.image, IMAGE);
});

test("idle shutdown and transient allocation failure recover with the same pinned image", async () => {
  const { directory, container, pauses } = fixture();
  await directory.fetch(new Request("https://directory.example/"));
  container.running = false;
  container.image = null;
  container.startFailures = 1;
  await directory.fetch(new Request("https://directory.example/"));
  assert.equal(container.starts.length, 3);
  assert.deepEqual(pauses, [500]);
  assert.ok(
    container.starts.every(
      (value) => value.image === IMAGE && !value.enableInternet,
    ),
  );
});

test("unavailable health has a finite retry bound and never poisons the next request", async () => {
  const { directory, container, pauses } = fixture();
  container.failures = Number.POSITIVE_INFINITY;
  await assert.rejects(
    directory.fetch(new Request("https://directory.example/")),
    /did not become ready/,
  );
  assert.equal(container.probes, MAX_ATTEMPTS);
  assert.equal(pauses.length, MAX_ATTEMPTS - 1);
  assert.equal(container.requests.length, 0);
  container.failures = 0;
  await directory.fetch(new Request("https://directory.example/"));
  assert.equal(container.starts.length, 1);
  assert.equal(container.requests.length, 1);
});

test("a missing image refuses startup without inventing a registry reference", async () => {
  const { directory, container } = fixture();
  container.images = {};
  await assert.rejects(
    directory.fetch(new Request("https://directory.example/")),
    /image is missing/,
  );
  assert.equal(container.starts.length, 0);
  assert.equal(container.requests.length, 0);
});

test("a changed or missing resource profile replaces the running image before serving", async () => {
  for (const labels of [{}, { profile: "lite" }, { profile: "standard-1" }]) {
    const { directory, container } = fixture();
    container.running = true;
    container.image = IMAGE;
    container.labels = labels;
    await directory.fetch(new Request("https://directory.example/"));
    const replace = labels.profile !== "standard-1";
    assert.equal(container.destroyed, Number(replace));
    assert.equal(container.starts.length, Number(replace));
    if (replace)
      assert.deepEqual(container.starts[0], {
        image: IMAGE,
        instance: "standard-1",
        enableInternet: false,
        labels: { profile: "standard-1" },
      });
    assert.equal(container.requests.length, 1);
  }
});

test("a slow cold start stays pending until the national snapshot is ready", async () => {
  const { directory, container, pauses } = fixture();
  container.failures = 90;
  await directory.fetch(new Request("https://directory.example/"));
  assert.equal(container.probes, 91);
  assert.equal(pauses.length, 90);
  assert.equal(container.starts.length, 1);
  assert.equal(container.requests.length, 1);
});
