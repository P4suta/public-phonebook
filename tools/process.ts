import { spawn } from "node:child_process";

export interface CommandResult {
  readonly code: number;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
}

export async function command(
  executable: string,
  args: readonly string[],
  capture = false,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
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
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      if (signal)
        reject(new Error(`Command interrupted: ${executable} (${signal})`));
      else resolve({ code: code ?? 1, output, stdout, stderr });
    });
  });
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
