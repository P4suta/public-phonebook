import { requireCommand } from "./process.ts";

const nativeTools = ["--manifest-path", "tools/ios-check/Cargo.toml"];
const androidTools = ["--manifest-path", "tools/android-check/Cargo.toml"];

export async function checkRust(): Promise<void> {
  const delivery = ["--manifest-path", "tools/delivery/Cargo.toml"];
  await requireCommand("cargo", ["fmt", ...delivery, "--all", "--check"]);
  await requireCommand("cargo", [
    "clippy",
    "--locked",
    ...delivery,
    "--workspace",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  await requireCommand("cargo", [
    "test",
    "--locked",
    ...delivery,
    "--workspace",
  ]);
  await requireCommand("cargo", [
    "audit",
    "--file",
    "tools/delivery/Cargo.lock",
  ]);
  await requireCommand("cargo", [
    "audit",
    "--file",
    "tools/delivery/fuzz/Cargo.lock",
  ]);
  await requireCommand("cargo", ["fmt", ...androidTools, "--check"]);
  await requireCommand("cargo", [
    "clippy",
    "--locked",
    ...androidTools,
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ]);
  await requireCommand("cargo", ["test", "--locked", ...androidTools]);
  await requireCommand("cargo", [
    "audit",
    "--file",
    "tools/android-check/Cargo.lock",
  ]);
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
