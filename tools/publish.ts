import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { environments } from "../src/core/environment.ts";
import { DatasetManifestSchema } from "../src/core/models.ts";
import { canPromote } from "../src/core/publication-policy.ts";
import { cloudflare } from "./cloudflare.ts";
import { command, requireCommand } from "./process.ts";
import { fileDigest } from "./snapshot.ts";

const commandArgumentOffset = 2;
const maximumPublishArguments = 2;
const jsonIndentation = 2;

async function buildDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string, prefix: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((first, second) =>
      first.name < second.name ? -1 : first.name === second.name ? 0 : 1,
    );
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full, `${relative}/`);
      else if (entry.isFile())
        hash.update(`${relative}\0${await fileDigest(full)}\n`);
      else throw new Error("Unsupported build output entry");
    }
  }
  await visit(directory, "");
  return hash.digest("hex");
}

async function main(args: readonly string[]): Promise<void> {
  const environment = v.parse(v.picklist(["staging", "production"]), args[0]);
  const bundle = resolve(args[1] ?? ".local/phonebook");
  if (args.length > maximumPublishArguments)
    throw new Error("Usage: publish ENVIRONMENT BUNDLE");
  v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/u)),
    process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  const status = await command("git", ["status", "--porcelain"], true);
  if (status.code !== 0 || status.stdout.trim() !== "")
    throw new Error("Publication requires a clean committed source tree");
  const commit = await command("git", ["rev-parse", "HEAD"], true);
  const tree = await command("git", ["rev-parse", "HEAD^{tree}"], true);
  if (commit.code !== 0 || tree.code !== 0)
    throw new Error("Cannot identify the candidate source");
  const sourceCommit = v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
    commit.stdout.trim(),
  );
  const candidate = v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
    tree.stdout.trim(),
  );
  const manifest = v.parse(
    DatasetManifestSchema,
    JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
  );
  const prepared = v.parse(
    v.object({
      environment: v.literal(environment),
      snapshot: v.literal(manifest.snapshot),
      databaseSha256: v.literal(manifest.databaseSha256),
      result: v.literal("verified"),
    }),
    JSON.parse(
      await readFile(`.local/remote-data/${environment}.json`, "utf8"),
    ),
  );
  const directory = resolve(".local/releases");
  await mkdir(directory, { recursive: true });
  if (environment === "production") {
    const staging = v.parse(
      v.object({
        environment: v.literal("staging"),
        origin: v.literal(environments.staging.origin),
        candidate: v.string(),
        snapshot: v.string(),
        result: v.literal("verified"),
      }),
      JSON.parse(await readFile(join(directory, "staging.json"), "utf8")),
    );
    if (
      !canPromote(
        candidate,
        staging.candidate,
        manifest.snapshot,
        staging.snapshot,
        staging.result === "verified",
      )
    )
      throw new Error(
        "Production requires a checked staging candidate with the same source tree and publication",
      );
  }
  await requireCommand("npm", ["run", "build", "--", environment]);
  const artifactSha256 = await buildDigest(resolve(".cloudflare/output"));
  await writeFile(
    join(directory, `${environment}-candidate.json`),
    `${JSON.stringify({ environment, candidate, sourceCommit, snapshot: prepared.snapshot, artifactSha256 }, null, jsonIndentation)}\n`,
  );
  await cloudflare([
    "deploy",
    "--prebuilt",
    "--mode",
    environment,
    "--tag",
    sourceCommit,
  ]);
  process.env.DIAL_PUBLIC_ORIGIN = environments[environment].origin;
  process.env.DIAL_PUBLIC_BUNDLE = bundle;
  await requireCommand("npm", [
    "exec",
    "--no",
    "--",
    "playwright",
    "test",
    "--config",
    "tests/public/playwright.config.ts",
  ]);
  await writeFile(
    join(directory, `${environment}.json`),
    `${JSON.stringify({ environment, origin: environments[environment].origin, candidate, sourceCommit, snapshot: manifest.snapshot, artifactSha256, deployedArtifactSha256: await buildDigest(resolve(".cloudflare/output")), result: "verified" }, null, jsonIndentation)}\n`,
  );
  console.info(
    JSON.stringify({
      operation: "publication",
      environment,
      origin: environments[environment].origin,
      sourceCommit,
      candidate,
      snapshot: manifest.snapshot,
      result: "verified",
    }),
  );
}

await main(process.argv.slice(commandArgumentOffset));
