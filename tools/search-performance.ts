import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { brotliDecompressSync } from "node:zlib";
import {
  type BrowserContext,
  type BrowserType,
  type CDPSession,
  chromium,
  devices,
  type Page,
  webkit,
} from "@playwright/test";
import * as v from "valibot";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  type LocalMatches,
  type LocalQuery,
  localQuery,
  matchIndex,
} from "../src/core/local-search.ts";
import {
  decodeLiteralSearchIndex,
  decodeSearchIndex,
  type SearchIndex,
  searchIndexFile,
} from "../src/core/search-index.ts";
import { decodeRankingArtifact } from "../src/core/search-ranking-artifact.ts";
import { serveBuiltWorker } from "./built-worker-server.ts";
import { developmentHost } from "./local-data.ts";
import { prepareMeter, requireCommand } from "./process.ts";
import { parityQueries } from "./search-parity.ts";
import {
  type RankingContract,
  RankingContractSchema,
} from "./search-ranking-contract.ts";
import { fileDigest } from "./snapshot.ts";

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
const sampleCounts = {
  substrings: 20,
  names: 10,
  numbers: 10,
  absent: 0,
  places: 10,
};
const median = 0.5;
const tail = 0.95;
const unmeasurable = "not supported by this engine";
const jsonIndentation = 2;
const eventThresholdMs = 16;
const rowIndex = /^(?:0|[1-9]\d*)$/u;
const processInventoryMaxBytes = 8 * 1024 * 1024;
const memorySampleIntervalMs = 250;
const contractRequestStart = 1_000_000;
const contractWarmupCount = 32;
const maximumAdmissionMs = 1500;
const maximumAddedProcessBytes = 400_000_000;
const maximumLiteralP95Ms = 50;
const ModeSchema = v.picklist(["literal", "forgiving"]);
type SearchMode = v.InferOutput<typeof ModeSchema>;

const RecordSchema = v.object({
  failure: v.nullable(v.string()),
  mode: v.nullable(ModeSchema),
  ready: v.nullable(v.number()),
  workerLoad: v.nullable(v.number()),
  artifactsArrived: v.nullable(v.number()),
  admissionAfterArrival: v.nullable(v.number()),
  searches: v.array(v.number()),
  longTasks: v.array(v.number()),
  events: v.array(v.object({ name: v.string(), duration: v.number() })),
  messages: v.object({
    searchesPosted: v.number(),
    resultsReceived: v.number(),
    resultJsonBytes: v.number(),
  }),
  heap: v.nullable(v.number()),
});

interface Profile {
  readonly name: string;
  readonly engine: BrowserType;
  readonly device: (typeof devices)[string];
  readonly cpuThrottling: number | null;
}

export function performanceBudget(
  admissionMs: number | null,
  incrementBytes: number | null,
  p95Ms: number | null,
  baselineP95Ms: number,
): {
  readonly admission: boolean;
  readonly memory: boolean | null;
  readonly latency: boolean | null;
  readonly passed: boolean;
} {
  const admission =
    admissionMs !== null &&
    admissionMs >= 0 &&
    admissionMs <= maximumAdmissionMs;
  const memory =
    incrementBytes === null
      ? null
      : incrementBytes >= 0 && incrementBytes <= maximumAddedProcessBytes;
  const latency = p95Ms === null ? null : p95Ms >= 0 && p95Ms <= baselineP95Ms;
  return {
    admission,
    memory,
    latency,
    passed: admission && memory === true && latency === true,
  };
}

export function performanceLatency(
  mode: SearchMode,
  workerP95Ms: number | null,
  rankingP95Ms: number | null,
  rankingBaselineP95Ms: number,
): {
  readonly metric: "searchRoundTripMs" | "completeRankingRoundTripMs";
  readonly p95Ms: number | null;
  readonly maximumP95Ms: number;
} {
  return mode === "literal"
    ? {
        metric: "searchRoundTripMs",
        p95Ms: workerP95Ms,
        maximumP95Ms: maximumLiteralP95Ms,
      }
    : {
        metric: "completeRankingRoundTripMs",
        p95Ms: rankingP95Ms,
        maximumP95Ms: rankingBaselineP95Ms,
      };
}

const baselineP95: Readonly<Record<string, number>> = {
  chromium: 10.2,
  "chromium-4x-cpu": 11.2,
  webkit: 10,
  "mobile-webkit": 13,
};

const profiles: readonly Profile[] = [
  {
    name: "chromium",
    engine: chromium,
    device: devices["Desktop Chrome"],
    cpuThrottling: null,
  },
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
      "The optional process sampler measures the owned browser process tree, not an isolated Worker heap; the main-thread heap and Node estimate have separate fields.",
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

function counted(values: readonly number[]): ReturnType<typeof summarize> & {
  readonly total: number;
} {
  return {
    ...summarize(values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

/** Counts, per query, the index rows that `match` reads and the rows it matches; the counts depend only on the index, the queries, and `match`. */
export function searchWork(
  index: SearchIndex,
  queries: readonly string[],
  match: (
    searched: SearchIndex,
    query: LocalQuery,
  ) => LocalMatches = matchIndex,
): {
  readonly queries: number;
  readonly rowsScanned: ReturnType<typeof counted>;
  readonly rowsMatched: ReturnType<typeof counted>;
} {
  const scanned: number[] = [];
  const matched: number[] = [];
  for (const input of queries) {
    const query = localQuery(input);
    if (!query.ok) throw new Error(`The sampled query is invalid: ${input}`);
    let reads = 0;
    const rows = new Proxy(index.rows, {
      get(target, property, receiver): unknown {
        if (typeof property === "string" && rowIndex.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    matched.push(match({ ...index, rows }, query.value).total);
    scanned.push(reads);
  }
  return {
    queries: queries.length,
    rowsScanned: counted(scanned),
    rowsMatched: counted(matched),
  };
}

/** Runs in the page before its scripts: times the Worker's search round trips and the moment the index is ready, and counts the search messages and result bytes. */
function installRecorder(eventThreshold: number): void {
  const record: {
    failure: string | null;
    mode: "literal" | "forgiving" | null;
    ready: number | null;
    workerLoad: number | null;
    artifactsArrived: number | null;
    admissionAfterArrival: number | null;
    searches: number[];
    longTasks: number[];
    events: { name: string; duration: number }[];
    messages: {
      searchesPosted: number;
      resultsReceived: number;
      resultJsonBytes: number;
    };
  } = {
    failure: null,
    mode: null,
    ready: null,
    workerLoad: null,
    artifactsArrived: null,
    admissionAfterArrival: null,
    searches: [],
    longTasks: [],
    events: [],
    messages: { searchesPosted: 0, resultsReceived: 0, resultJsonBytes: 0 },
  };
  const utf8 = new TextEncoder();
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
      Reflect.set(window, "__searchPerformanceWorker", this);
      const pending = new Map<number, number>();
      let loadStarted = 0;
      const post: unknown = Reflect.get(this, "postMessage");
      Reflect.set(
        this,
        "postMessage",
        (message: unknown, options?: unknown) => {
          const type: unknown =
            typeof message === "object" && message !== null
              ? Reflect.get(message, "type")
              : null;
          if (type === "load" || type === "load-forgiving") {
            record.mode = type === "load" ? "literal" : "forgiving";
            loadStarted = performance.now();
          }
          if (
            typeof message === "object" &&
            message !== null &&
            Reflect.get(message, "type") === "search"
          ) {
            record.messages.searchesPosted += 1;
            pending.set(Number(Reflect.get(message, "id")), performance.now());
          }
          if (typeof post === "function")
            Reflect.apply(post, this, [message, options]);
        },
      );
      this.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (typeof data !== "object" || data === null) return;
        if (Reflect.get(data, "type") === "unavailable")
          record.failure = `${String(Reflect.get(data, "reason"))}: ${String(Reflect.get(data, "detail"))}`;
        if (
          Reflect.get(data, "type") === "progress" &&
          Reflect.get(data, "received") === Reflect.get(data, "total")
        )
          record.artifactsArrived = performance.now();
        if (
          Reflect.get(data, "type") === "progress" &&
          Reflect.get(data, "received") === Reflect.get(data, "total")
        ) {
          const snapshot: unknown = Reflect.get(
            window,
            "__searchPerformanceArtifactMemory",
          );
          if (typeof snapshot === "function")
            Reflect.apply(snapshot, window, []);
        }
        if (Reflect.get(data, "type") === "ready") {
          record.workerLoad = performance.now() - loadStarted;
          record.admissionAfterArrival =
            record.artifactsArrived === null
              ? null
              : performance.now() - record.artifactsArrived;
        }
        if (Reflect.get(data, "type") === "results") {
          record.messages.resultsReceived += 1;
          record.messages.resultJsonBytes += utf8.encode(
            JSON.stringify(data),
          ).byteLength;
        }
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

const HeapUsageSchema = v.object({
  usedSize: v.number(),
  totalSize: v.number(),
  embedderHeapUsedSize: v.number(),
  backingStorageSize: v.number(),
});

async function workerHeap(
  session: CDPSession,
  targetId: string,
): Promise<v.InferOutput<typeof HeapUsageSchema>> {
  const { sessionId } = await session.send("Target.attachToTarget", {
    targetId,
    flatten: false,
  });
  let receive:
    | ((event: { sessionId: string; message: string }) => void)
    | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<v.InferOutput<typeof HeapUsageSchema>>(
      (resolve, reject) => {
        receive = (event): void => {
          if (event.sessionId !== sessionId) return;
          try {
            const value: unknown = JSON.parse(event.message);
            if (
              typeof value !== "object" ||
              value === null ||
              Reflect.get(value, "id") !== 1
            )
              return;
            resolve(v.parse(HeapUsageSchema, Reflect.get(value, "result")));
          } catch (error) {
            reject(error);
          }
        };
        timeout = setTimeout(
          () => reject(new Error("Worker heap diagnostics timed out")),
          5000,
        );
        session.on("Target.receivedMessageFromTarget", receive);
        void session
          .send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }),
          })
          .catch(reject);
      },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (receive) session.off("Target.receivedMessageFromTarget", receive);
    await session.send("Target.detachFromTarget", { sessionId });
  }
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
  context: BrowserContext,
  profile: Profile,
  artifactPaths: readonly string[],
  queries: readonly string[],
  contract: RankingContract | null,
  memory: {
    readonly root: number;
    readonly tools: string;
    readonly meter: string | null;
  } | null,
): Promise<Record<string, unknown>> {
  const browser = context.browser();
  if (!browser) throw new Error("No measured browser identity");
  let trace: ReturnType<typeof sampleMemory> | null = null;
  let artifactMemory: Record<string, unknown> | null = null;
  try {
    const page = await context.newPage();
    if (memory)
      trace = sampleMemory(
        memory.root,
        memory.tools,
        profile.engine.name(),
        memory.meter,
      );
    await page.exposeFunction("__searchPerformanceArtifactMemory", () => {
      artifactMemory = trace?.checkpoint() ?? null;
    });
    await page.addInitScript(installRecorder, eventThresholdMs);
    if (profile.cpuThrottling !== null) {
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", {
        rate: profile.cpuThrottling,
      });
    }
    const transferred = new Map<string, number>();
    page.on("requestfinished", (request) => {
      const path = new URL(request.url()).pathname;
      if (!artifactPaths.includes(path)) return;
      void request.sizes().then((sizes) => {
        transferred.set(path, sizes.responseBodySize);
      });
    });
    await page.goto("/");
    await page.waitForFunction(
      () => {
        const record: unknown = Reflect.get(window, "__searchPerformance");
        return (
          document.querySelector("search[data-local-search='ready']") !==
            null ||
          (typeof record === "object" &&
            record !== null &&
            Reflect.get(record, "failure") !== null)
        );
      },
      undefined,
      { timeout: readyTimeoutMs },
    );
    const admitted = await readRecord(page);
    if (admitted.failure)
      throw new Error(`${profile.name}: ${admitted.failure}`);
    const mode = admitted.mode;
    if (mode === null) throw new Error("The worker load mode is missing");
    if (contract && mode !== "forgiving")
      throw new Error("A ranking contract needs a forgiving-search build");
    const admissionMemory = trace?.checkpoint() ?? null;
    const input = page.getByRole("searchbox");
    const sampledQueries: {
      readonly query: string;
      readonly ms: number | null;
    }[] = [];
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
      sampledQueries.push({
        query,
        ms: (await readRecord(page)).searches.at(-1) ?? null,
      });
    }
    const sampled = await readRecord(page);
    await input.fill("");
    await input.focus();
    await page.keyboard.type(typedText, { delay: typingDelayMs });
    await page.waitForTimeout(typingDelayMs);
    const record = await readRecord(page);
    const sampledMemory = trace?.checkpoint() ?? null;
    const ranked = contract
      ? await measureRankingContract(page, contract)
      : null;
    const supportsLongTasks = await page.evaluate(() =>
      PerformanceObserver.supportedEntryTypes.includes("longtask"),
    );
    const supportsEvents = await page.evaluate(() =>
      PerformanceObserver.supportedEntryTypes.includes("event"),
    );
    const processMemory = trace?.finish() ?? {
      status: "not-run",
      reason: "No process attribution tools were supplied",
    };
    const rssIncrement: unknown = Reflect.get(
      processMemory,
      "peakIncrementRssBytes",
    );
    const footprint: unknown = Reflect.get(processMemory, "physicalFootprint");
    const memoryIncrement: unknown =
      typeof footprint === "object" &&
      footprint !== null &&
      Reflect.get(footprint, "status") === "measured"
        ? Reflect.get(footprint, "peakIncrementBytes")
        : null;
    const rankingSummary: unknown = ranked?.completeRankingRoundTripMs;
    const rankingP95: unknown =
      typeof rankingSummary === "object" && rankingSummary !== null
        ? Reflect.get(rankingSummary, "p95")
        : null;
    const searchRoundTripMs = summarize(record.searches);
    const latency = performanceLatency(
      mode,
      searchRoundTripMs.p95,
      typeof rankingP95 === "number" ? rankingP95 : null,
      baselineP95[profile.name] ?? 0,
    );
    const chromiumDiagnostics =
      profile.engine.name() === "chromium"
        ? await (async (): Promise<{
            readonly heap: v.InferOutput<typeof HeapUsageSchema>;
            readonly dom: {
              readonly documents: number;
              readonly nodes: number;
              readonly jsEventListeners: number;
            };
            readonly workers: readonly v.InferOutput<typeof HeapUsageSchema>[];
            readonly afterDiagnosticCollection: {
              readonly heap: v.InferOutput<typeof HeapUsageSchema>;
              readonly dom: {
                readonly documents: number;
                readonly nodes: number;
                readonly jsEventListeners: number;
              };
            };
          }> => {
            const session = await context.newCDPSession(page);
            try {
              const heap = await session.send("Runtime.getHeapUsage");
              const dom = await session.send("Memory.getDOMCounters");
              const { targetInfos } = await session.send("Target.getTargets");
              const workers = [];
              for (const target of targetInfos.filter(
                (target) => target.type === "worker",
              ))
                workers.push(await workerHeap(session, target.targetId));
              await session.send("HeapProfiler.collectGarbage");
              const afterDiagnosticCollection = {
                heap: await session.send("Runtime.getHeapUsage"),
                dom: await session.send("Memory.getDOMCounters"),
              };
              return { heap, dom, workers, afterDiagnosticCollection };
            } finally {
              await session.detach();
            }
          })()
        : null;
    return {
      name: profile.name,
      storageContext: "persistent-temporary-profile",
      mode,
      browser: browser.version(),
      cpuThrottling: profile.cpuThrottling,
      transferredArtifactBytes: [...transferred].map(([path, bytes]) => ({
        path,
        bytes,
      })),
      sampledWorkerMessages: sampled.messages,
      readyMs: record.ready,
      workerLoadMs: record.workerLoad,
      admissionAfterArrivalMs: record.admissionAfterArrival,
      budgets: {
        maximumAdmissionMs,
        maximumAddedProcessBytes,
        memoryMetric: "physical-footprint",
        legacyRssMemory: performanceBudget(
          record.admissionAfterArrival,
          typeof rssIncrement === "number" ? rssIncrement : null,
          latency.p95Ms,
          latency.maximumP95Ms,
        ).memory,
        latencyMetric: latency.metric,
        maximumLatencyP95Ms: latency.maximumP95Ms,
        ...performanceBudget(
          record.admissionAfterArrival,
          typeof memoryIncrement === "number" ? memoryIncrement : null,
          latency.p95Ms,
          latency.maximumP95Ms,
        ),
      },
      searchRoundTripMs,
      sampledQueries,
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
      chromiumDiagnostics,
      rankingContract: ranked,
      processMemory,
      admissionMemory,
      artifactMemory,
      sampleMemory: sampledMemory,
    };
  } finally {
    trace?.dispose();
    await context.close();
  }
}

const ProcessSchema = v.object({
  PID: v.number(),
  "Parent PID": v.number(),
  VmRSS: v.number(),
  Command: v.string(),
});

function browserProcessId(directory: string): number {
  const inventory: unknown = JSON.parse(
    execFileSync(
      "procs",
      ["--json", "--insert", "Ppid", "--insert", "VmRss", "--interval", "1"],
      { encoding: "utf8", maxBuffer: processInventoryMaxBytes },
    ),
  );
  const roots = v
    .parse(v.array(ProcessSchema), inventory)
    .filter(
      (processInfo) =>
        processInfo["Parent PID"] === process.pid &&
        processInfo.Command.includes(directory),
    );
  if (roots.length !== 1)
    throw new Error("Ambiguous persistent browser process identity");
  return roots[0]?.PID ?? 0;
}

const FootprintValueSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const FootprintReadingSchema = v.strictObject({
  pid: FootprintValueSchema,
  physicalFootprintBytes: FootprintValueSchema,
  lifetimePeakPhysicalFootprintBytes: FootprintValueSchema,
});

export function processFootprints(
  text: string,
  pids: readonly number[],
): {
  readonly currentBytes: number;
  readonly sumProcessLifetimePeaksBytes: number;
} {
  const parsed = v.parse(v.array(FootprintReadingSchema), JSON.parse(text));
  const expected = new Set(pids);
  const found = new Set(parsed.map((reading) => reading.pid));
  if (
    pids.length === 0 ||
    expected.size !== pids.length ||
    parsed.length !== pids.length ||
    found.size !== pids.length ||
    parsed.some((reading) => !expected.has(reading.pid))
  )
    throw new Error("Incomplete native process footprint inventory");
  const currentBytes = parsed.reduce(
    (sum, reading) => sum + reading.physicalFootprintBytes,
    0,
  );
  const sumProcessLifetimePeaksBytes = parsed.reduce(
    (sum, reading) => sum + reading.lifetimePeakPhysicalFootprintBytes,
    0,
  );
  if (
    !Number.isSafeInteger(currentBytes) ||
    !Number.isSafeInteger(sumProcessLifetimePeaksBytes)
  )
    throw new Error("Unsafe native process footprint total");
  return { currentBytes, sumProcessLifetimePeaksBytes };
}

function sampleMemory(
  root: number,
  tools: string,
  engine: string,
  meter: string | null,
): {
  readonly checkpoint: () => Record<string, unknown>;
  readonly finish: () => Record<string, unknown>;
  readonly dispose: () => void;
} {
  let peak = 0;
  let peakProcesses: {
    pid: number;
    parent: number;
    rssBytes: number;
    executable: string;
  }[] = [];
  let samples = 0;
  let webContent = false;
  let failure: unknown = null;
  let footprintBaseline: number | null = null;
  let footprintCurrent: number | null = null;
  let footprintPeak: number | null = null;
  let lifetimePeakSum: number | null = null;
  let footprintFailure: string | null = meter
    ? null
    : "Native memory counter unavailable";
  function footprint(): Record<string, unknown> {
    if (
      footprintFailure ||
      footprintBaseline === null ||
      footprintCurrent === null ||
      footprintPeak === null
    )
      return {
        status: "not-run",
        reason: footprintFailure ?? "No native memory sample",
      };
    return {
      status: "measured",
      baselineBytes: footprintBaseline,
      currentBytes: footprintCurrent,
      peakBytes: footprintPeak,
      peakIncrementBytes: footprintPeak - footprintBaseline,
      maximumSumProcessLifetimePeaksBytes: lifetimePeakSum,
    };
  }
  function sample(): number {
    const processes = v.parse(
      v.array(ProcessSchema),
      JSON.parse(
        execFileSync(
          "procs",
          [
            "--json",
            "--insert",
            "Ppid",
            "--insert",
            "VmRss",
            "--interval",
            "1",
          ],
          { encoding: "utf8", maxBuffer: processInventoryMaxBytes },
        ),
      ),
    );
    const selected = new Set([root]);
    function descend(): void {
      let previous = 0;
      while (previous !== selected.size) {
        previous = selected.size;
        for (const process of processes)
          if (selected.has(process["Parent PID"])) selected.add(process.PID);
      }
    }
    descend();
    const webkit = processes.filter((process) =>
      /WebKit|Playwright.app/u.test(process.Command),
    );
    if (webkit.length) {
      const owners = execFileSync(
        join(tools, "process-ownership"),
        webkit.map((process) => String(process.PID)),
        { encoding: "utf8" },
      );
      for (const line of owners.trim().split("\n")) {
        if (!/^\d+ -?\d+$/u.test(line))
          throw new Error("Invalid process responsibility record");
        const [pid, owner] = line.split(" ").map(Number);
        if (pid !== undefined && owner !== undefined && selected.has(owner))
          selected.add(pid);
      }
    }
    descend();
    const owned = processes.filter((process) => selected.has(process.PID));
    if (meter && footprintFailure === null) {
      try {
        const pids = owned.map((process) => process.PID);
        const reading = processFootprints(
          execFileSync(meter, ["memory", ...pids.map(String)], {
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: processInventoryMaxBytes,
          }),
          pids,
        );
        footprintCurrent = reading.currentBytes;
        footprintBaseline ??= footprintCurrent;
        footprintPeak = Math.max(
          footprintPeak ?? footprintCurrent,
          footprintCurrent,
        );
        lifetimePeakSum = Math.max(
          lifetimePeakSum ?? reading.sumProcessLifetimePeaksBytes,
          reading.sumProcessLifetimePeaksBytes,
        );
      } catch (error) {
        footprintFailure =
          error instanceof Error ? error.message : String(error);
      }
    }
    if (owned.some((process) => process.Command.includes("WebContent")))
      webContent = true;
    const rss = owned.reduce((sum, process) => sum + process.VmRSS, 0);
    if (rss <= 0) throw new Error("Empty browser process memory inventory");
    if (rss > peak) {
      peak = rss;
      peakProcesses = owned.map((process) => ({
        pid: process.PID,
        parent: process["Parent PID"],
        rssBytes: process.VmRSS,
        executable: process.Command.split(" ")[0] ?? "",
      }));
    }
    samples += 1;
    return rss;
  }
  const baseline = sample();
  if (engine === "webkit" && !webContent)
    throw new Error("WebKit memory needs an attributed WebContent process");
  const timer = setInterval(() => {
    try {
      sample();
    } catch (error) {
      failure = error;
      clearInterval(timer);
    }
  }, memorySampleIntervalMs);
  return {
    checkpoint: (): Record<string, unknown> => {
      if (failure) throw failure;
      return {
        currentRssBytes: sample(),
        physicalFootprint: footprint(),
        peakIncrementRssBytes: peak - baseline,
        samples,
      };
    },
    dispose: (): void => {
      clearInterval(timer);
    },
    finish: (): Record<string, unknown> => {
      clearInterval(timer);
      if (failure) throw failure;
      sample();
      let regionSummary: Record<string, unknown> = {
        status: "not-run",
        reason: "No macOS process map",
      };
      if (process.platform === "darwin") {
        let largest = peakProcesses[0];
        for (const process of peakProcesses)
          if (process.rssBytes > (largest?.rssBytes ?? 0)) largest = process;
        if (largest) {
          try {
            regionSummary = {
              status: "measured",
              pid: largest.pid,
              summary: execFileSync(
                "/usr/bin/vmmap",
                ["-summary", String(largest.pid)],
                { encoding: "utf8", timeout: 5000, maxBuffer: 1_048_576 },
              ),
            };
          } catch (error) {
            regionSummary = {
              status: "not-run",
              reason: error instanceof Error ? error.message : String(error),
            };
          }
        }
      }
      return {
        status: "measured",
        regionSummary,
        physicalFootprint: footprint(),
        baselineRssBytes: baseline,
        peakRssBytes: peak,
        peakProcesses,
        peakIncrementRssBytes: peak - baseline,
        samples,
        intervalMs: memorySampleIntervalMs,
        webContentAttributed: webContent,
      };
    },
  };
}

async function measureRankingContract(
  page: Page,
  contract: RankingContract,
): Promise<Record<string, unknown>> {
  const admitted = contract.queries.filter(
    (entry) => localQuery(entry.query).ok,
  );
  const raw: unknown = await page.evaluate(
    async ({ queries, requestStart, timeoutMs, warmups }) => {
      const candidate: unknown = Reflect.get(
        window,
        "__searchPerformanceWorker",
      );
      if (!(candidate instanceof Worker))
        throw new Error("The production search Worker is missing");
      const worker = candidate;
      let id = requestStart;
      async function ask(
        query: string,
        visible: number,
        category: string,
      ): Promise<unknown> {
        id += 1;
        const requestId = id;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            worker.removeEventListener("message", receive);
            reject(new Error("Worker contract request timed out"));
          }, timeoutMs);
          function receive(event: MessageEvent<unknown>): void {
            const data = event.data;
            if (
              typeof data !== "object" ||
              data === null ||
              Reflect.get(data, "id") !== requestId
            )
              return;
            clearTimeout(timeout);
            worker.removeEventListener("message", receive);
            resolve(data);
          }
          worker.addEventListener("message", receive);
          worker.postMessage(
            visible === 0
              ? { type: "search", id: requestId, query }
              : { type: "continue", id: requestId, query, category, visible },
          );
        });
      }
      function scored(rows: unknown): [number, number][] {
        if (!Array.isArray(rows)) throw new Error("Invalid worker rows");
        return rows.map((row: unknown) => {
          if (typeof row !== "object" || row === null)
            throw new Error("Invalid ranked row");
          const position = Number(Reflect.get(row, "row"));
          const score = Number(Reflect.get(row, "score"));
          if (!Number.isSafeInteger(position) || !Number.isSafeInteger(score))
            throw new Error("Missing integer ranking values");
          return [position, score];
        });
      }
      async function grouped(
        query: string,
      ): Promise<{ category: string; hits: [number, number][] }[]> {
        const reply = await ask(query, 0, "");
        if (typeof reply !== "object" || reply === null)
          throw new Error("Invalid worker reply");
        const groups: unknown = Reflect.get(reply, "groups");
        if (!Array.isArray(groups))
          throw new Error("The worker rejected a contract query");
        const result: { category: string; hits: [number, number][] }[] = [];
        for (const group of groups) {
          const category = String(Reflect.get(group, "category"));
          const total = Number(Reflect.get(group, "total"));
          const hits = scored(Reflect.get(group, "rows"));
          while (hits.length < total) {
            const page = await ask(query, hits.length, category);
            if (typeof page !== "object" || page === null)
              throw new Error("Invalid worker page");
            const more = scored(Reflect.get(page, "rows"));
            if (more.length === 0)
              throw new Error("Worker continuation stopped early");
            hits.push(...more);
          }
          result.push({ category, hits });
        }
        return result;
      }
      for (const query of queries.slice(0, warmups)) await grouped(query);
      const times: number[] = [];
      const answers: { category: string; hits: [number, number][] }[][] = [];
      for (const query of queries) {
        const start = performance.now();
        answers.push(await grouped(query));
        times.push(performance.now() - start);
      }
      return { times, answers };
    },
    {
      queries: admitted.map((entry) => entry.query),
      requestStart: contractRequestStart,
      timeoutMs: searchTimeoutMs,
      warmups: contractWarmupCount,
    },
  );
  const GroupSchema = v.object({
    category: v.string(),
    hits: v.array(v.tuple([v.number(), v.number()])),
  });
  const measured = v.parse(
    v.object({
      times: v.array(v.number()),
      answers: v.array(v.array(GroupSchema)),
    }),
    raw,
  );
  const divergences = admitted.flatMap((entry, i) => {
    const answer = measured.answers[i] ?? [];
    const categoryOf = new Map(
      answer.flatMap((group) =>
        group.hits.map(([row]) => [row, group.category] as const),
      ),
    );
    const expected = new Map<string, [number, number][]>();
    for (const [row, score] of entry.hits) {
      const category = categoryOf.get(row) ?? "";
      expected.set(category, [...(expected.get(category) ?? []), [row, score]]);
    }
    const wanted = [...expected].map(([category, hits]) => ({
      category,
      hits,
    }));
    return JSON.stringify(wanted) === JSON.stringify(answer)
      ? []
      : [entry.query];
  });
  if (measured.answers.length !== admitted.length || divergences.length)
    throw new Error(`Worker ranking differs for ${divergences.length} queries`);
  return {
    compared: admitted.length,
    rejectedByQueryParser: contract.queries.length - admitted.length,
    divergences: 0,
    completeRankingRoundTripMs: summarize(measured.times),
    samplesMs: measured.times,
  };
}

function decodedIndexHeapBytes(
  decoded: Uint8Array,
  decode: (bytes: Uint8Array) => SearchIndex,
): number {
  setFlagsFromString("--expose-gc");
  const collect: unknown = runInNewContext("gc");
  const gc = (): void => {
    if (typeof collect === "function") collect();
  };
  gc();
  const before = process.memoryUsage().heapUsed;
  const index = decode(decoded);
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
      contract: { type: "string" },
      "process-tools": { type: "string" },
      profile: { type: "string" },
    },
  });
  const [bundle, ...extra] = positionals;
  if (!bundle || extra.length)
    throw new Error(
      "Usage: node tools/search-performance.ts BUNDLE [--state DIRECTORY] [--output FILE] [--port PORT] [--contract FILE] [--process-tools DIRECTORY]",
    );
  const directory = resolve(bundle);
  const selectedProfiles = values.profile
    ? profiles.filter((profile) => profile.name === values.profile)
    : profiles;
  if (selectedProfiles.length === 0)
    throw new Error("Unknown browser performance profile");
  const manifestText: unknown = JSON.parse(
    await readFile(join(directory, "manifest.ready.json"), "utf8"),
  );
  const manifest = v.parse(PreparedDatasetManifestSchema, manifestText);
  const decoded = new Uint8Array(
    brotliDecompressSync(await readFile(join(directory, searchIndexFile))),
  );
  const index = decodeSearchIndex(decoded);
  const queries = parityQueries(index, sampleSeed, sampleCounts);
  const sample = [
    ...new Set([
      ...queries.substrings,
      ...queries.names,
      ...queries.numbers,
      ...queries.places,
    ]),
  ];
  const contract = values.contract
    ? v.parse(
        RankingContractSchema,
        JSON.parse(await readFile(values.contract, "utf8")),
      )
    : null;
  const rankingIdentity = manifest.searchRanking
    ? (decodeRankingArtifact(
        brotliDecompressSync(
          await readFile(join(directory, manifest.searchRanking.file)),
        ),
        manifest.snapshot,
        manifest.contacts,
      ).packed?.sourceSha256 ?? manifest.searchRanking.uncompressedSha256)
    : null;
  if (
    contract &&
    (contract.snapshot !== manifest.snapshot ||
      contract.contacts !== manifest.contacts ||
      contract.indexSha256 !== manifest.searchIndex.uncompressedSha256 ||
      contract.rankingSha256 !== rankingIdentity ||
      contract.queries.length === 0)
  )
    throw new Error("The ranking contract differs from the measured snapshot");
  const processTools = values["process-tools"]
    ? resolve(values["process-tools"])
    : null;
  const footprintMeter = processTools ? await prepareMeter() : null;
  const processToolIdentity = processTools
    ? {
        launcherSha256: await fileDigest(join(processTools, "browser-launch")),
        ownershipSha256: await fileDigest(
          join(processTools, "process-ownership"),
        ),
        physicalCounterSha256: footprintMeter
          ? await fileDigest(footprintMeter)
          : null,
        procs: execFileSync("procs", ["--version"], {
          encoding: "utf8",
        }).trim(),
      }
    : null;
  const typed = Array.from(typedText);
  const work = {
    sample: searchWork(index, sample),
    typedPrefixes: searchWork(
      index,
      typed.map((_, end) => typed.slice(0, end + 1).join("")),
    ),
  };
  const port = Number(values.port ?? defaultPort);
  await requireCommand(process.execPath, [
    "tools/build.ts",
    "development",
    ...(contract ? ["--local-forgiving-search"] : []),
  ]);
  const runtime = await serveBuiltWorker({
    port,
    state: values.state ?? defaultState,
  });
  const origin = `https://${developmentHost}:${port}`;
  const assets = ".cloudflare/output/v0/workers/default/assets/assets";
  const [workerScript, ...extraWorkers] = (await readdir(assets)).filter(
    (file) => /^local-search-worker-[\w-]+\.js$/u.test(file),
  );
  if (!workerScript || extraWorkers.length)
    throw new Error("Expected one built search Worker");
  const artifactPaths = [
    `/api/search-index/${manifest.snapshot}/${manifest.searchIndex.sha256}`,
    ...(manifest.searchRanking
      ? [
          `/api/search-ranking/${manifest.snapshot}/${manifest.searchRanking.sha256}`,
        ]
      : []),
  ];
  try {
    const measured: Record<string, unknown>[] = [];
    for (const profile of selectedProfiles) {
      const directory = await mkdtemp(join(tmpdir(), "phonebook-search-"));
      try {
        const context = await profile.engine.launchPersistentContext(
          directory,
          {
            ...profile.device,
            baseURL: origin,
            ignoreHTTPSErrors: true,
            ...(processTools && profile.engine.name() === "webkit"
              ? { executablePath: join(processTools, "browser-launch") }
              : {}),
            env: {
              ...process.env,
              ENGINE_BROWSER_EXECUTABLE: profile.engine.executablePath(),
            },
          },
        );
        try {
          const root = processTools ? browserProcessId(directory) : null;
          if (processTools && !root)
            throw new Error("No browser process identity");
          measured.push(
            await measureProfile(
              context,
              profile,
              artifactPaths,
              sample,
              contract,
              processTools && root
                ? { root, tools: processTools, meter: footprintMeter }
                : null,
            ),
          );
        } finally {
          await context.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    const report = {
      operation: "search-performance",
      snapshot: manifest.snapshot,
      workerScriptSha256: await fileDigest(join(assets, workerScript)),
      measurementSourceSha256: await fileDigest("tools/search-performance.ts"),
      indexBytes: {
        compressed: manifest.searchIndex.bytes,
        decoded: manifest.searchIndex.uncompressedBytes,
      },
      rankingBytes: manifest.searchRanking
        ? {
            compressed: manifest.searchRanking.bytes,
            decoded: manifest.searchRanking.uncompressedBytes,
          }
        : null,
      decodedIndexHeapBytesInNode: decodedIndexHeapBytes(
        decoded,
        decodeLiteralSearchIndex,
      ),
      decodedMaterializedIndexHeapBytesInNode: decodedIndexHeapBytes(
        decoded,
        decodeSearchIndex,
      ),
      queries: sample.length,
      typedText,
      literalReferenceWork: work,
      processToolIdentity,
      profiles: measured,
      manual: manualMeasurements,
      generatedAt: new Date().toISOString(),
    };
    const output = values.output ?? defaultOutput;
    await writeFile(
      output,
      `${JSON.stringify(report, null, jsonIndentation)}\n`,
    );
    console.info(
      JSON.stringify({
        operation: report.operation,
        snapshot: report.snapshot,
        queries: sample.length,
        profiles: measured.length,
        output,
        result: "recorded",
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) await main();
