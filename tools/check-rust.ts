import { requireCommand } from "./process.ts";

const nativeTools = ["--manifest-path", "tools/ios-check/Cargo.toml"];

export async function checkRust(): Promise<void> {
  await requireCommand("cargo", ["fmt", ...nativeTools, "--all", "--check"]);
  await requireCommand("cargo", [
    "clippy",
    "--locked",
    ...nativeTools,
    "--workspace",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  await requireCommand("cargo", [
    "test",
    "--locked",
    ...nativeTools,
    "--workspace",
  ]);
  for (const action of ["icons --check", "audit"])
    await requireCommand("cargo", [
      "run",
      "--locked",
      ...nativeTools,
      "--",
      ...action.split(" "),
    ]);
}

if (import.meta.main) {
  await checkRust();
  console.info(JSON.stringify({ operation: "check-rust", result: "passed" }));
}
