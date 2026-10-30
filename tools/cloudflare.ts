import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";
import { command } from "./process.ts";
import type { SqlPort, SqlStatement } from "./remote-statements.ts";

const commandNameParts = 3;
const diagnosticCharacterLimit = 4000;

export async function cloudflare(args: readonly string[]): Promise<unknown> {
  const result = await command(resolve("node_modules/.bin/cf"), args, true);
  if (result.code !== 0)
    throw new Error(
      `Cloudflare ${args.slice(0, commandNameParts).join(" ")} failed: ${result.stderr.slice(-diagnosticCharacterLimit)}`,
    );
  if (result.stdout.trim() === "") return null;
  const value: unknown = JSON.parse(result.stdout);
  return value;
}

const ResultsSchema = v.array(
  v.object({
    success: v.literal(true),
    results: v.array(v.record(v.string(), v.unknown())),
  }),
);

export function remoteSql(databaseId: string, requestFile: string): SqlPort {
  return {
    async execute(
      statements: readonly SqlStatement[],
    ): Promise<readonly Record<string, unknown>[]> {
      await writeFile(requestFile, JSON.stringify(statements));
      const raw = await cloudflare([
        "d1",
        "query",
        databaseId,
        "--batch",
        `@${requestFile}`,
      ]);
      const results = v.parse(ResultsSchema, raw);
      if (results.length !== statements.length)
        throw new Error("Incomplete D1 batch result");
      return results.flatMap((result) => result.results);
    },
  };
}
