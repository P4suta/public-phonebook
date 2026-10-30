import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { databaseResourceName, environments } from "../src/core/environment.ts";
import { CatalogSchema, DatasetManifestSchema } from "../src/core/models.ts";
import { canPromote } from "../src/core/publication-policy.ts";
import { checkDataBundle } from "./check-data.ts";
import { command, requireCommand } from "./process.ts";
import { validatePublicationCoverage } from "./publication-coverage.ts";
import {
  type ReleaseJournal,
  type ReleasePorts,
  type ReleaseTarget,
  recoverRelease,
  resumeBootstrap,
  runRelease,
} from "./release-lifecycle.ts";
import {
  activeDatabaseId,
  activeVersion,
  restoreVersion,
  verifyVersionBindings,
} from "./release-provider.ts";
import {
  loadRelease,
  type RemoteEnvironment,
  releaseLock,
  saveRelease,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import { validateStagingApplication } from "./staging-access.ts";
import { probeStaging } from "./staging-probes.ts";
import { auditVerificationArtifacts } from "./verification-artifacts.ts";
import { requireVerificationReceipt } from "./verification-receipt.ts";

const commandArgumentOffset = 2;
const actionArgumentOffset = 2;
const maximumArguments = 3;
const workerBuildDirectory = ".cloudflare/output/v0/workers/default";
const cf = resolve("node_modules/.bin/cf");
const treeSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u));

class RecoveryExerciseFailure extends Error {
  constructor() {
    super("The staging recovery exercise rejected a checked candidate");
    this.name = "RecoveryExerciseFailure";
  }
}

export async function buildDigest(directory: string): Promise<string> {
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
  for (const part of ["bundle", "assets"])
    await visit(join(directory, part), `${part}/`);
  return hash.digest("hex");
}

async function verificationBundle(bundle: string): Promise<string> {
  const manifestPath = resolve(bundle, "manifest.ready.json");
  const digest = await fileDigest(manifestPath);
  const destination = resolve(".local/releases/bundles", digest);
  await mkdir(destination, { recursive: true });
  for (const name of ["manifest.ready.json", "catalog.json"]) {
    const source = resolve(bundle, name);
    const target = join(destination, name);
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    if ((await fileDigest(source)) !== (await fileDigest(target)))
      throw new Error("A preserved verification bundle has conflicting bytes");
  }
  return destination;
}

async function verifyTarget(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
): Promise<void> {
  await verifyVersionBindings(environment, target);
  const manifest = v.parse(
    DatasetManifestSchema,
    JSON.parse(
      await readFile(join(target.bundle, "manifest.ready.json"), "utf8"),
    ),
  );
  const catalog = v.parse(
    CatalogSchema,
    JSON.parse(await readFile(join(target.bundle, "catalog.json"), "utf8")),
  );
  if (
    manifest.snapshot !== target.snapshot ||
    manifest.databaseSha256 !== target.databaseSha256 ||
    catalog.snapshot !== target.snapshot ||
    (await fileDigest(join(target.bundle, "manifest.ready.json"))) !==
      target.manifestSha256
  )
    throw new Error(
      "The verification bundle differs from its release identity",
    );
  process.env.DIAL_PUBLIC_ORIGIN = environments[environment].origin;
  process.env.DIAL_PUBLIC_BUNDLE = target.bundle;
  const failures: unknown[] = [];
  try {
    await requireCommand("npm", [
      "exec",
      "--no",
      "--",
      "playwright",
      "test",
      "--config",
      "tests/public/playwright.config.ts",
    ]);
  } catch (error) {
    failures.push(error);
  }
  try {
    await auditVerificationArtifacts(
      [
        resolve(`test-results/public-${environment}.json`),
        resolve(`test-results/public-${environment}`),
      ],
      environment === "staging"
        ? [
            process.env.ACCESS_SERVICE_CLIENT_ID ?? "",
            process.env.ACCESS_SERVICE_CLIENT_SECRET ?? "",
          ]
        : [],
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "Public verification did not pass");
  if (environment === "staging") {
    await validateStagingApplication();
    await probeStaging();
  }
}

function releasePorts(
  environment: RemoteEnvironment,
  sourceBundle: string,
): ReleasePorts {
  return {
    save: (journal) => saveRelease(environment, journal),
    active: () => activeVersion(environment),
    restore: (previous) => restoreVersion(environment, previous),
    verify: (target) => verifyTarget(environment, target),
    async prepare(target): Promise<void> {
      const manifest = await checkDataBundle(sourceBundle);
      const prepared = v.parse(
        v.object({
          environment: v.literal(environment),
          snapshot: v.literal(target.snapshot),
          databaseSha256: v.literal(target.databaseSha256),
          manifestSha256: v.literal(target.manifestSha256),
          database: v.literal(target.databaseId),
          databaseName: v.literal(
            databaseResourceName(environment, target.databaseSha256),
          ),
          bucket: v.literal(environments[environment].bucket),
          result: v.literal("verified"),
        }),
        JSON.parse(
          await readFile(`.local/remote-data/${environment}.json`, "utf8"),
        ),
      );
      if (
        manifest.snapshot !== prepared.snapshot ||
        (await fileDigest(join(sourceBundle, "manifest.ready.json"))) !==
          target.manifestSha256 ||
        (await buildDigest(resolve(workerBuildDirectory))) !==
          target.artifactSha256 ||
        (await committedTree()) !== target.sourceTree
      )
        throw new Error("The prepared candidate changed before activation");
      if (environment === "staging") await validateStagingApplication();
    },
    async activate(target): Promise<void> {
      const deployed = await command(
        cf,
        [
          "deploy",
          "--prebuilt",
          "--mode",
          environment,
          "--tag",
          target.releaseId,
          "--message",
          target.sourceTree ?? "",
        ],
        true,
      );
      if (deployed.code !== 0)
        throw new Error("Cloudflare candidate activation did not complete");
      if (
        (await buildDigest(resolve(workerBuildDirectory))) !==
        target.artifactSha256
      )
        throw new Error("Deployment changed the verified Worker or assets");
    },
  };
}

async function committedTree(): Promise<string> {
  const status = await command("git", ["status", "--porcelain"], true);
  if (status.code !== 0 || status.stdout.trim())
    throw new Error("Publication requires a clean committed source tree");
  const tree = await command("git", ["rev-parse", "HEAD^{tree}"], true);
  if (tree.code !== 0)
    throw new Error("Cannot identify the candidate source tree");
  return v.parse(treeSchema, tree.stdout.trim());
}

function verifiedPredecessor(
  journal: ReleaseJournal | null,
): ReleaseTarget | null {
  if (!journal) return null;
  if (journal.phase === "verified") return journal.candidate;
  if (journal.phase === "recovered") return journal.previous;
  throw new Error("An incomplete publication requires recovery");
}

async function adoptProduction(bundle: string): Promise<void> {
  if (await loadRelease("production"))
    throw new Error("Production already has a publication journal");
  const manifest = await checkDataBundle(bundle, "retained");
  const active = await activeVersion("production");
  const target: ReleaseTarget = {
    releaseId: active.versionId,
    versionId: active.versionId,
    sourceTree: null,
    snapshot: manifest.snapshot,
    databaseSha256: manifest.databaseSha256,
    databaseId: await activeDatabaseId("production", active.versionId),
    manifestSha256: await fileDigest(join(bundle, "manifest.ready.json")),
    artifactSha256: null,
    bundle: await verificationBundle(bundle),
    manifestBinding: "snapshot",
  };
  await verifyTarget("production", target);
  if ((await activeVersion("production")).versionId !== target.versionId)
    throw new Error("Production changed during baseline verification");
  await saveRelease("production", {
    candidate: target,
    previous: null,
    phase: "verified",
  });
  console.info(
    JSON.stringify({
      operation: "publication.adopt",
      environment: "production",
      versionId: target.versionId,
      snapshot: target.snapshot,
      result: "verified",
    }),
  );
}

async function main(args: readonly string[]): Promise<void> {
  const environment = v.parse(v.picklist(["staging", "production"]), args[0]);
  const bundle = resolve(args[1] ?? ".local/phonebook");
  const action = v.parse(
    v.picklist([
      "publish",
      "--bootstrap",
      "--recover",
      "--adopt",
      "--status",
      "--rehearse-recovery",
      "--resume-bootstrap",
    ]),
    args[actionArgumentOffset] ?? "publish",
  );
  if (args.length > maximumArguments)
    throw new Error(
      "Usage: publish ENVIRONMENT BUNDLE [--bootstrap|--resume-bootstrap|--recover|--adopt|--status|--rehearse-recovery]",
    );
  const unlock = await releaseLock(environment);
  let buildUnlock: (() => Promise<void>) | null = null;
  async function releaseBuild(): Promise<void> {
    const release = buildUnlock;
    buildUnlock = null;
    await release?.();
  }
  try {
    let journal = await loadRelease(environment);
    const ports = releasePorts(environment, bundle);
    if (action === "--status") {
      console.info(
        JSON.stringify({
          operation: "publication.status",
          environment,
          journal,
          active: await activeVersion(environment),
        }),
      );
      return;
    }
    if (action === "--recover") {
      if (!journal)
        throw new Error("There is no publication journal to recover");
      const recovered = await recoverRelease(journal, ports);
      console.info(
        JSON.stringify({
          operation: "publication.recover",
          environment,
          phase: recovered.phase,
          result: "verified",
        }),
      );
      return;
    }
    const initialTree = await committedTree();
    await requireVerificationReceipt(initialTree);
    await requireCommand(process.execPath, [
      "tools/prove.ts",
      "--check-receipt",
    ]);
    if (action === "--resume-bootstrap") {
      if (
        environment !== "staging" ||
        !journal ||
        journal.candidate.sourceTree !== initialTree
      )
        throw new Error(
          "Initial verification requires its original committed staging source",
        );
      const completed = await resumeBootstrap(journal, ports);
      console.info(
        JSON.stringify({
          operation: "publication.bootstrap.resume",
          phase: completed.phase,
          result: "verified",
        }),
      );
      return;
    }
    if (action === "--adopt") {
      if (environment !== "production")
        throw new Error(
          "Only the existing public production baseline can be adopted",
        );
      await adoptProduction(bundle);
      return;
    }
    if (
      journal &&
      journal.phase !== "verified" &&
      journal.phase !== "recovered"
    )
      journal = await recoverRelease(journal, ports);
    const sourceTree = await committedTree();
    const manifest = await checkDataBundle(bundle);
    const manifestSha256 = await fileDigest(
      join(bundle, "manifest.ready.json"),
    );
    if (environment === "production") {
      const staging = await loadRelease("staging");
      const checked = staging?.phase === "verified" ? staging.candidate : null;
      if (
        !checked ||
        !canPromote(
          sourceTree,
          checked.sourceTree ?? "",
          manifest.snapshot,
          checked.snapshot,
          true,
          manifest.databaseSha256,
          checked.databaseSha256,
          manifestSha256,
          checked.manifestSha256,
        ) ||
        (await activeVersion("staging")).versionId !== checked.versionId
      )
        throw new Error(
          "Production requires the identical active verified staging source and dataset artifacts",
        );
    }
    const previous = verifiedPredecessor(journal);
    const catalog: unknown = JSON.parse(
      await readFile(join(bundle, "catalog.json"), "utf8"),
    );
    const precedingCatalog =
      previous && environment === "production"
        ? v.parse(
            CatalogSchema,
            JSON.parse(
              await readFile(join(previous.bundle, "catalog.json"), "utf8"),
            ),
          )
        : undefined;
    validatePublicationCoverage(catalog, precedingCatalog);
    if (environment === "production")
      await requireVerificationReceipt(sourceTree, manifestSha256);
    const bootstrap = action === "--bootstrap";
    const exercise = action === "--rehearse-recovery";
    if (exercise && (environment !== "staging" || !previous))
      throw new Error(
        "Recovery exercises require an existing verified staging publication",
      );
    if (bootstrap && (environment !== "staging" || journal !== null))
      throw new Error(
        "Bootstrap is restricted to the first protected staging publication",
      );
    if (!previous && !bootstrap)
      throw new Error("Publication requires a verified predecessor");
    process.env.DIAL_DATABASE_SHA256 = manifest.databaseSha256;
    process.env.DIAL_MANIFEST_SHA256 = manifestSha256;
    if (environment === "staging") await validateStagingApplication();
    buildUnlock = await releaseLock("build");
    await requireCommand("npm", ["run", "build", "--", environment]);
    const prepared = v.parse(
      v.object({ database: v.pipe(v.string(), v.uuid()) }),
      JSON.parse(
        await readFile(`.local/remote-data/${environment}.json`, "utf8"),
      ),
    );
    const target: ReleaseTarget = {
      releaseId: randomUUID(),
      versionId: "",
      sourceTree,
      snapshot: manifest.snapshot,
      databaseSha256: manifest.databaseSha256,
      databaseId: prepared.database,
      manifestSha256,
      artifactSha256: await buildDigest(resolve(workerBuildDirectory)),
      bundle: await verificationBundle(bundle),
      manifestBinding: "digest",
    };
    const guardedPorts: ReleasePorts = {
      ...ports,
      async activate(candidate): Promise<void> {
        try {
          await ports.activate(candidate);
        } finally {
          await releaseBuild();
        }
      },
      async verify(candidate): Promise<void> {
        await ports.verify(candidate);
        if (exercise && candidate.releaseId === target.releaseId)
          throw new RecoveryExerciseFailure();
      },
    };
    let result: ReleaseJournal;
    try {
      result = await runRelease(target, previous, guardedPorts, bootstrap);
    } catch (error) {
      const recovered = await loadRelease(environment);
      if (
        exercise &&
        error instanceof Error &&
        error.cause instanceof RecoveryExerciseFailure &&
        recovered?.phase === "recovered" &&
        recovered.candidate.releaseId === target.releaseId &&
        recovered.previous?.versionId === previous?.versionId
      ) {
        console.info(
          JSON.stringify({
            operation: "publication.rehearsal",
            environment,
            rejectedSnapshot: target.snapshot,
            restoredSnapshot: previous?.snapshot,
            result: "recovered",
          }),
        );
        return;
      }
      throw error;
    }
    if (exercise) {
      await recoverRelease(result, ports);
      throw new Error(
        "The recovery exercise did not observe its expected failure",
      );
    }
    console.info(
      JSON.stringify({
        operation: "publication",
        environment,
        sourceTree,
        snapshot: target.snapshot,
        versionId: result.candidate.versionId,
        result: "verified",
      }),
    );
  } finally {
    try {
      await releaseBuild();
    } finally {
      await unlock();
    }
  }
}

if (process.argv[1] === resolve("tools/publish.ts"))
  await main(process.argv.slice(commandArgumentOffset));
