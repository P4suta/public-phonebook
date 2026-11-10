import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { command } from "../../tools/process.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function checkImports(files: Readonly<Record<string, string>>): Promise<{
  readonly code: number;
  readonly output: string;
}> {
  const parent = resolve(".local");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "dependency-boundaries-"));
  fixtures.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return command(
    resolve("node_modules/.bin/depcruise"),
    ["--config", ".dependency-cruiser.json", root],
    true,
  );
}

describe("runtime dependency boundaries", () => {
  it("allows an app to consume shared directory code", async () => {
    const result = await checkImports({
      "apps/web/src/index.ts":
        'import { value } from "../../../packages/directory/src/value.ts"; export { value };',
      "packages/directory/src/value.ts": "export const value: number = 1;",
    });
    expect(result.code, result.output).toBe(0);
  });

  it.each([
    [
      "directory-node-effects",
      {
        "packages/directory/src/value.ts":
          'export { readFile } from "node:fs/promises";',
      },
    ],
    [
      "directory-dependency-direction",
      {
        "packages/directory/src/value.ts":
          'export { value } from "../../../tools/value.ts";',
        "tools/value.ts": "export const value: number = 1;",
      },
    ],
    [
      "web-preparation-boundary",
      {
        "apps/web/src/index.ts":
          'export { value } from "../../../data/value.ts";',
        "data/value.ts": "export const value: number = 1;",
      },
    ],
  ] as const)(
    "rejects %s through the installed checker",
    async (rule, files) => {
      const result = await checkImports(files);
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain(rule);
    },
  );
});
