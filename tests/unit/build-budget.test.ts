import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  budgetViolations,
  buildBudgets,
  measureBuild,
} from "../../tools/build-budget.ts";

const output = ".cloudflare/output/v0/workers/default";
const roots: string[] = [];

async function build(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "build-budget-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, output, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("build budget", () => {
  it("rejects a forgiving scorer in any built client asset", async () => {
    const root = await build({
      "bundle/index.js": "export {};",
      "assets/assets/local-search-worker-A.js": "self.onmessage=()=>{};",
      "assets/assets/extra-A.js":
        "throw Error('Invalid packed ranking format metadata');",
    });
    await expect(measureBuild(root)).rejects.toThrow(/forgiving search/u);
  });

  it("measures compressed Worker modules and the search Worker script", async () => {
    const root = await build({
      "bundle/index.js": "export default {};\n".repeat(50),
      "bundle/assets/chunk.js": "export const value = 1;\n",
      "bundle/assets/chunk.js.map": "x".repeat(100_000),
      "assets/assets/local-search-worker-AbC_1-2.js": "self.onmessage=()=>{};",
      "assets/assets/index-AbC.js": "y".repeat(100_000),
    });
    const sizes = await measureBuild(root);
    expect(sizes.searchWorkerBytes).toBe(22);
    expect(sizes.workerCompressedBytes).toBeGreaterThan(0);
    expect(sizes.workerCompressedBytes).toBeLessThan(200);
    expect(budgetViolations(sizes)).toEqual([]);
  });

  it("requires exactly one search Worker script", async () => {
    await expect(
      measureBuild(
        await build({
          "bundle/index.js": "export {};",
          "assets/assets/index-A.js": "a",
        }),
      ),
    ).rejects.toThrow(/exactly one search Worker/u);
    await expect(
      measureBuild(
        await build({
          "bundle/index.js": "export {};",
          "assets/assets/local-search-worker-A.js": "a",
          "assets/assets/local-search-worker-B.js": "b",
        }),
      ),
    ).rejects.toThrow(/exactly one search Worker/u);
  });

  it("names each size above its limit", () => {
    expect(
      budgetViolations({
        workerCompressedBytes: buildBudgets.workerCompressedBytes + 1,
        searchWorkerBytes: buildBudgets.searchWorkerBytes,
      }),
    ).toEqual([
      `workerCompressedBytes: ${buildBudgets.workerCompressedBytes + 1} bytes exceeds ${buildBudgets.workerCompressedBytes}`,
    ]);
  });
});
