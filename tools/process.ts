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
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    cwd,
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

export async function requireCommand(
  executable: string,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  const result = await command(executable, args, false, cwd);
  if (result.code !== 0)
    throw new Error(
      `Command failed (${result.code}): ${executable} ${args.join(" ")}`,
    );
}
