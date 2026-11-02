import { prepareCheckFixture } from "./check-fixture.ts";
import { checkRust } from "./check-rust.ts";
import { requireCommand } from "./process.ts";

await requireCommand("npm", ["run", "build"]);
await checkRust();
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
