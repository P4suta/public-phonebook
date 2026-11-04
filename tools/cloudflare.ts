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

/** D1 refuses work past a database's 10-second resource window, and its error list recommends spreading the load over time. */
const overloadedPattern = /\[7429\]|D1 DB is overloaded/u;
const overloadPauseMs = 15_000;
export const overloadAttempts = 4;
const readOnlyPattern = /^\s*(?:select|with|pragma\s+foreign_key_check)\b/iu;

/** A batch is safe to send again when every statement only reads. */
export function readOnlyBatch(statements: readonly SqlStatement[]): boolean {
  return (
    statements.length > 0 &&
    statements.every((statement) => readOnlyPattern.test(statement.sql))
  );
}

export function overloaded(error: unknown): boolean {
  return error instanceof Error && overloadedPattern.test(error.message);
}

export interface RemoteSqlOptions {
  readonly run?: (args: readonly string[]) => Promise<unknown>;
  readonly pause?: (milliseconds: number) => Promise<void>;
  /** Sending reads again adds load, so only a database that no Worker version binds takes it. */
  readonly retryOverloadedReads?: boolean;
}

export function remoteSql(
  databaseId: string,
  requestFile: string,
  options: RemoteSqlOptions = {},
): SqlPort {
  const run = options.run ?? cloudflare;
  const pause =
    options.pause ??
    ((milliseconds: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async execute(
      statements: readonly SqlStatement[],
    ): Promise<readonly Record<string, unknown>[]> {
      await writeFile(requestFile, JSON.stringify(statements));
      const args = ["d1", "query", databaseId, "--batch", `@${requestFile}`];
      const retryable =
        options.retryOverloadedReads === true && readOnlyBatch(statements);
      let raw: unknown;
      for (let attempt = 1; ; attempt += 1) {
        try {
          raw = await run(args);
          break;
        } catch (error) {
          // Writes resume from the import checkpoint instead, so only reads of an unbound database repeat here.
          if (!retryable || !overloaded(error) || attempt >= overloadAttempts)
            throw error;
          await pause(overloadPauseMs * attempt);
        }
      }
      const results = v.parse(ResultsSchema, raw);
      if (results.length !== statements.length)
        throw new Error("Incomplete D1 batch result");
      return results.flatMap((result) => result.results);
    },
  };
}
