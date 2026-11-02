import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const buildOutput = ".cloudflare/output/v0/workers/default";
const bytesPerKibibyte = 1024;
const searchWorkerChunk = /^local-search-worker-[\w-]+\.js$/u;

/**
 * Size limits for the build, checked after every build.
 * The Worker limit stays well below Cloudflare's compressed upload limit, so an accidental bundle, such as the API reference or a dataset, fails here first.
 */
export const buildBudgets = {
  workerCompressedBytes: 1024 * bytesPerKibibyte,
  searchWorkerBytes: 34 * bytesPerKibibyte,
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
  let workerCompressedBytes = 0;
  for (const path of await files(join(root, buildOutput, "bundle")))
    if ([".js", ".mjs"].includes(extname(path)))
      workerCompressedBytes += gzipSync(await readFile(path)).byteLength;
  const chunks = (await files(join(root, buildOutput, "assets"))).filter(
    (path) => searchWorkerChunk.test(path.split("/").at(-1) ?? ""),
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
