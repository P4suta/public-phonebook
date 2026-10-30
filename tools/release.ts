import { resolve } from "node:path";
import { requireCommand } from "./process.ts";
import { loadRelease } from "./release-store.ts";

const commandArgumentOffset = 2;
const maximumArguments = 1;
async function main(args: readonly string[]): Promise<void> {
  if (args.length > maximumArguments)
    throw new Error("Usage: release [BUNDLE]");
  const bundle = resolve(args[0] ?? ".local/phonebook");
  await requireCommand("just", ["test"]);
  for (const environment of ["staging", "production"] as const) {
    await requireCommand("doppler", [
      "run",
      "--project",
      "public-phonebook",
      "--config",
      "prd",
      "--only-secrets",
      "CLOUDFLARE_ACCOUNT_ID",
      "--no-fallback",
      "--",
      process.execPath,
      "tools/remote-data.ts",
      environment,
      bundle,
    ]);
    const existing = await loadRelease(environment);
    const config = environment === "staging" ? "stg" : "prd";
    if (environment === "production" && !existing)
      await requireCommand("doppler", [
        "run",
        "--project",
        "public-phonebook",
        "--config",
        config,
        "--no-fallback",
        "--",
        process.execPath,
        "tools/publish.ts",
        environment,
        resolve(".local/published-phonebook"),
        "--adopt",
      ]);
    await requireCommand("doppler", [
      "run",
      "--project",
      "public-phonebook",
      "--config",
      config,
      "--no-fallback",
      "--",
      process.execPath,
      "tools/publish.ts",
      environment,
      bundle,
      ...(environment === "staging" && !existing ? ["--bootstrap"] : []),
    ]);
  }
}
await main(process.argv.slice(commandArgumentOffset));
