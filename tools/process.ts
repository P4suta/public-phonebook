import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as v from "valibot";
import { recordProcess } from "./step-timing.ts";

export interface CommandResult {
  readonly code: number;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
}

/** Commands whose work runs outside every process the meter can count. */
const delegatedWork: Readonly<Record<string, string>> = {
  docker: "the container VM",
};

const MeterRecordSchema = v.union([
  v.strictObject({
    instructions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    reapedDescendants: v.boolean(),
  }),
  v.strictObject({
    instructions: v.null(),
    reapedDescendants: v.null(),
    reason: v.string(),
  }),
]);

let meter: string | null = null;

/** Routes later commands through the step meter at `path`, or spawns them directly for `null`. */
export function useMeter(path: string | null): void {
  meter = path;
}

/** Builds the step meter on macOS and returns its path, or `null` where no per-process count exists. */
export async function prepareMeter(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const manifest = "tools/ios-check/Cargo.toml";
  const build = await command(
    "cargo",
    [
      "build",
      "--locked",
      "--quiet",
      "--manifest-path",
      manifest,
      "--package",
      "step-meter",
    ],
    true,
  );
  if (build.code !== 0) {
    console.warn(
      JSON.stringify({
        operation: "step-meter",
        result: "unavailable",
        output: build.output,
      }),
    );
    return null;
  }
  return resolve("tools/ios-check/target/debug/step-meter");
}

/** Parses a meter record into retired instructions and the descendant flag, or `null` for a record without a count. */
export function meterCount(
  text: string,
): { instructions: number; reapedDescendants: boolean } | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = v.safeParse(MeterRecordSchema, decoded);
  if (!parsed.success || parsed.output.instructions === null) return null;
  return {
    instructions: parsed.output.instructions,
    reapedDescendants: parsed.output.reapedDescendants,
  };
}

async function readMeterRecord(
  path: string,
): Promise<ReturnType<typeof meterCount>> {
  try {
    return meterCount(await readFile(path, "utf8"));
  } catch {
    return null;
  } finally {
    await rm(path, { force: true });
  }
}

/** Reads the gate process's own retired instructions through the meter, or `null` without one. */
export async function ownInstructions(): Promise<number | null> {
  if (!meter) return null;
  const child = spawn(meter, ["self", "--pid", String(process.pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    text += chunk;
  });
  const code = await new Promise<number | null>((done) => {
    child.once("error", () => done(null));
    child.once("close", done);
  });
  if (code !== 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = v.safeParse(
    v.strictObject({
      instructions: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
    decoded,
  );
  return parsed.success ? parsed.output.instructions : null;
}

export async function command(
  executable: string,
  args: readonly string[],
  capture = false,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const record = meter
    ? join(tmpdir(), `step-meter-${randomUUID()}.json`)
    : null;
  const child = spawn(
    meter && record ? meter : executable,
    meter && record
      ? ["run", "--record", record, "--", executable, ...args]
      : args,
    {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    },
  );
  let output = "";
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
    stderr += chunk;
  });
  function interrupt(): void {
    child.kill("SIGTERM");
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const [code, signal] = await new Promise<
    [number | null, NodeJS.Signals | null]
  >((done, reject) => {
    child.once("error", reject);
    child.once("close", (...exit) => done(exit));
  }).finally(() => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  });
  const name = basename(executable);
  const count = record ? await readMeterRecord(record) : null;
  recordProcess({
    command: name,
    instructions: count?.instructions ?? null,
    reapedDescendants: count?.reapedDescendants ?? false,
    delegated: delegatedWork[name],
  });
  if (signal) throw new Error(`Command interrupted: ${executable} (${signal})`);
  return { code: code ?? 1, output, stdout, stderr };
}

/** Runs `action` on every item with at most `limit` running at once, and returns the results in input order once every item settles; it rethrows the first failure in input order. */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  action: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("The concurrency limit must be a positive integer");
  const queue = items.entries();
  const settled: PromiseSettledResult<R>[] = [];
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      try {
        settled[index] = { status: "fulfilled", value: await action(item) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

export async function requireCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await command(executable, args, false, cwd, env);
  if (result.code !== 0)
    throw new Error(
      `Command failed (${result.code}): ${executable} ${args.join(" ")}`,
    );
}
