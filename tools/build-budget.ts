import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";
import * as v from "valibot";

const buildOutput = "apps/web/.cloudflare/output/v0/workers/default";
const bytesPerKibibyte = 1024;
const searchWorkerChunk = /^local-search-worker-[\w-]+\.js$/u;
const noDestinations = v.array(v.never());
const RuntimePrivacySchema = v.object({
  logpush: v.literal(false),
  tailConsumers: noDestinations,
  observability: v.strictObject({
    enabled: v.literal(false),
    redactQueryString: v.literal(true),
    issues: v.strictObject({ enabled: v.literal(false) }),
    logs: v.strictObject({
      enabled: v.literal(false),
      invocationLogs: v.literal(false),
      persist: v.literal(false),
      destinations: noDestinations,
    }),
    traces: v.strictObject({
      enabled: v.literal(false),
      persist: v.literal(false),
      destinations: noDestinations,
    }),
  }),
});

/**
 * Size limits for the build, checked after every build.
 * The Worker limit stays well below Cloudflare's compressed upload limit, so an accidental bundle, such as a dataset, fails here first.
 */
export const buildBudgets = {
  workerCompressedBytes: 1024 * bytesPerKibibyte,
  searchWorkerBytes: 72 * bytesPerKibibyte,
} as const;

const budgetNames = ["workerCompressedBytes", "searchWorkerBytes"] as const;

export type BuildSizes = Record<(typeof budgetNames)[number], number>;

export function budgetViolations(
  sizes: BuildSizes,
  budgets: BuildSizes = buildBudgets,
): string[] {
  return budgetNames.flatMap((name) =>
    sizes[name] > budgets[name]
      ? [`${name}: ${sizes[name]} bytes exceeds ${budgets[name]}`]
      : [],
  );
}

async function files(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Measures the gzip size of the Worker's modules and the raw size of the search Worker script. */
export async function measureBuild(root = "."): Promise<BuildSizes> {
  const configuration: unknown = JSON.parse(
    await readFile(join(root, buildOutput, "worker.config.json"), "utf8"),
  );
  if (!v.safeParse(RuntimePrivacySchema, configuration).success)
    throw new Error("The built Worker violates the collection policy");
  let workerCompressedBytes = 0;
  for (const path of await files(join(root, buildOutput, "bundle")))
    if ([".js", ".mjs"].includes(extname(path)))
      workerCompressedBytes += gzipSync(await readFile(path)).byteLength;
  const assets = await files(join(root, buildOutput, "assets"));
  for (const path of assets) {
    if (![".js", ".mjs"].includes(extname(path))) continue;
    const source = await readFile(path, "utf8");
    if (
      path.includes("/forgiving-search-loader-") ||
      source.includes("Invalid packed ranking format metadata")
    )
      throw new Error(`The build includes forgiving search: ${path}`);
  }
  const chunks = assets.filter((path) =>
    searchWorkerChunk.test(path.split("/").at(-1) ?? ""),
  );
  const [chunk, ...extra] = chunks;
  if (!chunk || extra.length)
    throw new Error("The build must emit exactly one search Worker script");
  return {
    workerCompressedBytes,
    searchWorkerBytes: (await readFile(chunk)).byteLength,
  };
}

export async function requireBuildBudget(root = "."): Promise<void> {
  const sizes = await measureBuild(root);
  const violations = budgetViolations(sizes);
  console.info(
    JSON.stringify({
      operation: "build-budget",
      sizes,
      budgets: buildBudgets,
      result: violations.length ? "failed" : "passed",
    }),
  );
  if (violations.length)
    throw new Error(`The build exceeds its budget: ${violations.join("; ")}`);
}

if (import.meta.main) await requireBuildBudget();
