import { prepareCheckFixture } from "./check-fixture.ts";
import { requireCommand } from "./process.ts";

await requireCommand("npm", ["run", "build"]);
const nativeTools = ["--manifest-path", "tools/ios-check/Cargo.toml"];
await requireCommand("cargo", ["fmt", ...nativeTools, "--check"]);
await requireCommand("cargo", [
  "clippy",
  "--locked",
  ...nativeTools,
  "--all-targets",
  "--",
  "-D",
  "warnings",
]);
await requireCommand("cargo", ["test", "--locked", ...nativeTools]);
for (const action of ["icons --check", "audit"])
  await requireCommand("cargo", [
    "run",
    "--locked",
    ...nativeTools,
    "--",
    ...action.split(" "),
  ]);
await prepareCheckFixture();
await requireCommand("npm", [
  "exec",
  "--no",
  "--",
  "playwright",
  "test",
  "--config=playwright.check.config.ts",
]);
console.info(JSON.stringify({ operation: "check-build", result: "passed" }));
