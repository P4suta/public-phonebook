import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { brotliDecompressSync } from "node:zlib";
import {
  type Browser,
  type BrowserType,
  chromium,
  devices,
  type Page,
  webkit,
} from "@playwright/test";
import * as v from "valibot";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  decodeSearchIndex,
  searchIndexFile,
} from "../src/core/search-index.ts";
import { serveBuiltWorker } from "./built-worker-server.ts";
import { developmentHost } from "./local-data.ts";
import { parityQueries } from "./search-parity.ts";

const commandArgumentOffset = 2;
const defaultState = ".local/state";
const defaultOutput = ".local/search-performance.json";
const defaultPort = 8791;
const throttledCpuRate = 4;
const readyTimeoutMs = 300_000;
const searchTimeoutMs = 60_000;
const typingDelayMs = 100;
const typedText = "国立国会図書館";
const sampleSeed = 0x0f_2026;
const sampleCounts = { substrings: 20, names: 10, numbers: 10, absent: 0 };
const median = 0.5;
const tail = 0.95;
const unmeasurable = "not supported by this engine";
const jsonIndentation = 2;
const eventThresholdMs = 16;

const RecordSchema = v.object({
  ready: v.nullable(v.number()),
  searches: v.array(v.number()),
  longTasks: v.array(v.number()),
  events: v.array(v.object({ name: v.string(), duration: v.number() })),
  heap: v.nullable(v.number()),
});

interface Profile {
  readonly name: string;
  readonly engine: BrowserType;
  readonly device: (typeof devices)[string];
  readonly cpuThrottling: number | null;
}

const profiles: readonly Profile[] = [
  {
    name: "chromium-4x-cpu",
    engine: chromium,
    device: devices["Desktop Chrome"],
    cpuThrottling: throttledCpuRate,
  },
  {
    name: "webkit",
    engine: webkit,
    device: devices["Desktop Safari"],
    cpuThrottling: null,
  },
  {
    name: "mobile-webkit",
    engine: webkit,
    device: devices["iPhone 13"],
    cpuThrottling: null,
  },
];

/** Measurements that this tool can't take and that a person records by hand. */
export const manualMeasurements = [
  {
    name: "iphone-safari",
    status: "not-run",
    reason:
      "Needs a physical iPhone with Safari Web Inspector over a real network; the iPhone 13 profile above only emulates its viewport and engine.",
  },
  {
    name: "worker-heap",
    status: "not-run",
    reason:
      "Browsers expose a Worker's heap only to cross-origin isolated pages or a debugger session; the record keeps the main-thread heap and a V8 estimate of the decoded index instead.",
  },
] as const;

/** Returns the value at a quantile by the nearest-rank method, or null for no samples. */
export function quantile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(fraction * sorted.length)),
  );
  return sorted[rank - 1] ?? null;
}

export function summarize(values: readonly number[]): {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
} {
  return {
    count: values.length,
    p50: quantile(values, median),
    p95: quantile(values, tail),
    max: values.length ? Math.max(...values) : null,
  };
}

/** Runs in the page before its scripts: times the Worker's search round trips and the moment the index is ready. */
function installRecorder(eventThreshold: number): void {
  const record: {
    ready: number | null;
    searches: number[];
    longTasks: number[];
    events: { name: string; duration: number }[];
  } = { ready: null, searches: [], longTasks: [], events: [] };
  Reflect.set(window, "__searchPerformance", record);
  new MutationObserver(() => {
    const search = document.querySelector("search[data-local-search]");
    if (
      record.ready === null &&
      search instanceof HTMLElement &&
      search.dataset.localSearch === "ready"
    )
      record.ready = performance.now();
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-local-search"],
  });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      const pending = new Map<number, number>();
      const post: unknown = Reflect.get(this, "postMessage");
      Reflect.set(
        this,
        "postMessage",
        (message: unknown, options?: unknown) => {
          if (
            typeof message === "object" &&
            message !== null &&
            Reflect.get(message, "type") === "search"
          )
            pending.set(Number(Reflect.get(message, "id")), performance.now());
          if (typeof post === "function")
            Reflect.apply(post, this, [message, options]);
        },
      );
      this.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (typeof data !== "object" || data === null) return;
        const id = Number(Reflect.get(data, "id"));
        const started = pending.get(id);
        if (started === undefined || Reflect.get(data, "type") !== "results")
          return;
        pending.delete(id);
        record.searches.push(performance.now() - started);
      });
    }
  };
  if (PerformanceObserver.supportedEntryTypes.includes("longtask"))
    new PerformanceObserver((list) => {
      record.longTasks.push(
        ...list.getEntries().map((entry) => entry.duration),
      );
    }).observe({ type: "longtask", buffered: true });
  // Event Timing reports events of at least 16 ms when asked, the smallest threshold it allows.
  const eventOptions: PerformanceObserverInit & { durationThreshold: number } =
    { type: "event", buffered: true, durationThreshold: eventThreshold };
  if (PerformanceObserver.supportedEntryTypes.includes("event"))
    new PerformanceObserver((list) => {
      record.events.push(
        ...list
          .getEntries()
          .map((entry) => ({ name: entry.name, duration: entry.duration })),
      );
    }).observe(eventOptions);
}

async function readRecord(
  page: Page,
): Promise<v.InferOutput<typeof RecordSchema>> {
  const raw: unknown = await page.evaluate(() => {
    const record: unknown = Reflect.get(window, "__searchPerformance");
    const memory: unknown = Reflect.get(performance, "memory");
    const heap =
      typeof memory === "object" && memory !== null
        ? Number(Reflect.get(memory, "usedJSHeapSize"))
        : null;
    return typeof record === "object" && record !== null
      ? { ...record, heap }
      : null;
  });
  return v.parse(RecordSchema, raw);
}

async function measureProfile(
  browser: Browser,
  profile: Profile,
  origin: string,
  indexPath: string,
  queries: readonly string[],
): Promise<Record<string, unknown>> {
  const context = await browser.newContext({
    ...profile.device,
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await context.newPage();
    await page.addInitScript(installRecorder, eventThresholdMs);
    if (profile.cpuThrottling !== null) {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", {
        rate: profile.cpuThrottling,
      });
    }
    let transferred: number | null = null;
    page.on("requestfinished", (request) => {
      if (new URL(request.url()).pathname !== indexPath) return;
      void request.sizes().then((sizes) => {
        transferred = sizes.responseBodySize;
      });
    });
    await page.goto("/");
    await page
      .locator("search[data-local-search='ready']")
      .waitFor({ state: "attached", timeout: readyTimeoutMs });
    const input = page.getByRole("searchbox");
    for (const query of queries) {
      const before = (await readRecord(page)).searches.length;
      await input.fill(query);
      await page.waitForFunction(
        (count) => {
          const record: unknown = Reflect.get(window, "__searchPerformance");
          const searches: unknown =
            typeof record === "object" && record !== null
              ? Reflect.get(record, "searches")
              : null;
          return Array.isArray(searches) && searches.length > count;
        },
        before,
        { timeout: searchTimeoutMs },
      );
    }
    await input.fill("");
    await input.focus();
    await page.keyboard.type(typedText, { delay: typingDelayMs });
    await page.waitForTimeout(typingDelayMs);
    const record = await readRecord(page);
    const supportsLongTasks = await page.evaluate(() =>
      PerformanceObserver.supportedEntryTypes.includes("longtask"),
    );
    const supportsEvents = await page.evaluate(() =>
      PerformanceObserver.supportedEntryTypes.includes("event"),
    );
    return {
      name: profile.name,
      browser: browser.version(),
      cpuThrottling: profile.cpuThrottling,
      transferredIndexBytes: transferred,
      readyMs: record.ready,
      searchRoundTripMs: summarize(record.searches),
      inputEventsOver16Ms: supportsEvents
        ? summarize(record.events.map((event) => event.duration))
        : unmeasurable,
      longTasksMs: supportsLongTasks
        ? {
            ...summarize(record.longTasks),
            total: record.longTasks.reduce((sum, value) => sum + value, 0),
          }
        : unmeasurable,
      mainThreadHeapBytes: record.heap ?? unmeasurable,
    };
  } finally {
    await context.close();
  }
}

function decodedIndexHeapBytes(decoded: Uint8Array): number {
  setFlagsFromString("--expose-gc");
  const collect: unknown = runInNewContext("gc");
  const gc = (): void => {
    if (typeof collect === "function") collect();
  };
  gc();
  const before = process.memoryUsage().heapUsed;
  const index = decodeSearchIndex(decoded);
  gc();
  const after = process.memoryUsage().heapUsed;
  if (!index.rows.length) throw new Error("The decoded index is empty");
  return after - before;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(commandArgumentOffset),
    allowPositionals: true,
    options: {
      state: { type: "string" },
      output: { type: "string" },
      port: { type: "string" },
    },
  });
  const [bundle, ...extra] = positionals;
  if (!bundle || extra.length)
    throw new Error(
      "Usage: node tools/search-performance.ts BUNDLE [--state DIRECTORY] [--output FILE] [--port PORT]",
    );
  const directory = resolve(bundle);
  const manifestText: unknown = JSON.parse(
    await readFile(join(directory, "manifest.ready.json"), "utf8"),
  );
  const manifest = v.parse(PreparedDatasetManifestSchema, manifestText);
  const decoded = new Uint8Array(
    brotliDecompressSync(await readFile(join(directory, searchIndexFile))),
  );
  const queries = parityQueries(
    decodeSearchIndex(decoded),
    sampleSeed,
    sampleCounts,
  );
  const sample = [...queries.substrings, ...queries.names, ...queries.numbers];
  const port = Number(values.port ?? defaultPort);
  const runtime = await serveBuiltWorker({
    port,
    state: values.state ?? defaultState,
  });
  const origin = `https://${developmentHost}:${port}`;
  const indexPath = `/api/search-index/${manifest.snapshot}/${manifest.searchIndex.sha256}`;
  try {
    const measured: Record<string, unknown>[] = [];
    for (const profile of profiles) {
      const browser = await profile.engine.launch();
      try {
        measured.push(
          await measureProfile(browser, profile, origin, indexPath, sample),
        );
      } finally {
        await browser.close();
      }
    }
    const report = {
      operation: "search-performance",
      snapshot: manifest.snapshot,
      indexBytes: {
        compressed: manifest.searchIndex.bytes,
        decoded: manifest.searchIndex.uncompressedBytes,
      },
      decodedIndexHeapBytesInNode: decodedIndexHeapBytes(decoded),
      queries: sample.length,
      typedText,
      profiles: measured,
      manual: manualMeasurements,
      generatedAt: new Date().toISOString(),
    };
    const output = values.output ?? defaultOutput;
    await writeFile(
      output,
      `${JSON.stringify(report, null, jsonIndentation)}\n`,
    );
    console.info(JSON.stringify({ ...report, output }));
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) await main();
