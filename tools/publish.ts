import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { databaseResourceName, environments } from "../src/core/environment.ts";
import { CatalogSchema, DigestSchema } from "../src/core/models.ts";
import { canPromote } from "../src/core/publication-policy.ts";
import { checkDataBundle } from "./check-data.ts";
import { acquireLease, type PublicationLease } from "./control-lease.ts";
import {
  type ControlStore,
  controlStoreFromEnvironment,
} from "./control-store.ts";
import { command, requireCommand } from "./process.ts";
import { validatePublicationCoverage } from "./publication-coverage.ts";
import {
  ownsUnverifiedBootstrap,
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
  type JournalWriter,
  journalWriter,
  loadRelease,
  materializeVerificationDataset,
  type RemoteEnvironment,
  RemoteEnvironmentSchema,
  type RunProvenance,
  releaseLock,
  releaseSigner,
  requireCandidateEvidence,
  runProvenance,
  storeVerificationDataset,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import { validateStagingApplication } from "./staging-access.ts";
import { probeStaging } from "./staging-probes.ts";
import { auditVerificationArtifacts } from "./verification-artifacts.ts";
import { requireVerificationReceipt } from "./verification-receipt.ts";

const commandArgumentOffset = 2;
const workerBuildDirectory = ".cloudflare/output/v0/workers/default";
const cf = resolve("node_modules/.bin/cf");
const verificationCache = ".local/control-cache/datasets";
const fetchedDatasets = ".local/datasets";
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

function verificationBundle(
  store: ControlStore,
  target: ReleaseTarget,
): Promise<string> {
  return materializeVerificationDataset(
    store,
    target.manifestSha256,
    resolve(verificationCache),
  );
}

async function verifyTarget(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
  store: ControlStore,
): Promise<void> {
  await verifyVersionBindings(environment, target);
  const bundle = await verificationBundle(store, target);
  const identity = v.parse(
    v.object({ snapshot: DigestSchema, databaseSha256: DigestSchema }),
    JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
  );
  const catalog = v.parse(
    CatalogSchema,
    JSON.parse(await readFile(join(bundle, "catalog.json"), "utf8")),
  );
  if (
    identity.snapshot !== target.snapshot ||
    identity.databaseSha256 !== target.databaseSha256 ||
    catalog.snapshot !== target.snapshot
  )
    throw new Error(
      "The verification bundle differs from its release identity",
    );
  process.env.DIAL_PUBLIC_ORIGIN = environments[environment].origin;
  process.env.DIAL_PUBLIC_BUNDLE = bundle;
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

interface PublicationContext {
  readonly environment: RemoteEnvironment;
  readonly store: ControlStore;
  readonly writer: JournalWriter;
  readonly lease: PublicationLease;
}

function releasePorts(
  { environment, store, writer, lease }: PublicationContext,
  sourceBundle: string,
): ReleasePorts {
  return {
    async save(journal): Promise<void> {
      lease.assertHeld();
      await writer.save(journal);
    },
    active: () => activeVersion(environment),
    async restore(previous): Promise<void> {
      lease.assertHeld();
      await restoreVersion(environment, previous);
    },
    verify: (target) => verifyTarget(environment, target, store),
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
      lease.assertHeld();
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

async function adoptProduction(
  bundle: string,
  context: PublicationContext,
): Promise<void> {
  if (context.writer.current())
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
    manifestSha256: await storeVerificationDataset(context.store, bundle),
    artifactSha256: null,
    manifestBinding: "snapshot",
  };
  await verifyTarget("production", target, context.store);
  if ((await activeVersion("production")).versionId !== target.versionId)
    throw new Error("Production changed during baseline verification");
  context.lease.assertHeld();
  await context.writer.save({
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

const publishActions = [
  "publish",
  "--bootstrap",
  "--recover",
  "--adopt",
  "--status",
  "--rehearse-recovery",
  "--resume-bootstrap",
  "--check-admission",
] as const;
export type PublishAction = (typeof publishActions)[number];
const datasetActions: ReadonlySet<PublishAction> = new Set([
  "publish",
  "--bootstrap",
  "--adopt",
  "--rehearse-recovery",
  "--check-admission",
]);
const effectfulActions: ReadonlySet<PublishAction> = new Set([
  "publish",
  "--bootstrap",
  "--adopt",
  "--rehearse-recovery",
  "--resume-bootstrap",
]);
const publishUsage = `Usage: publish ENVIRONMENT [${publishActions.filter((action) => action !== "publish").join("|")}] [--dataset MANIFEST_SHA256] [--bundle DIRECTORY]`;

export interface PublishArguments {
  readonly environment: RemoteEnvironment;
  readonly action: PublishAction;
  readonly dataset: string;
  readonly bundle: string;
}

export function parsePublishArguments(
  args: readonly string[],
): PublishArguments {
  const [first, ...rest] = args;
  const environment = v.safeParse(RemoteEnvironmentSchema, first);
  if (!environment.success) throw new Error(publishUsage);
  let action: PublishAction = "publish";
  let dataset = "";
  let bundle = "";
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--dataset" && value && !dataset) {
      dataset = v.parse(DigestSchema, value);
      index += 1;
    } else if (flag === "--bundle" && value && !bundle) {
      bundle = resolve(value);
      index += 1;
    } else if (
      action === "publish" &&
      v.is(v.picklist(publishActions), flag) &&
      flag !== "publish"
    )
      action = flag;
    else throw new Error(publishUsage);
  }
  if (datasetActions.has(action) !== (dataset !== ""))
    throw new Error(
      datasetActions.has(action)
        ? `The ${action} action requires an explicit --dataset`
        : `The ${action} action takes no dataset`,
    );
  if (bundle && !dataset) throw new Error(publishUsage);
  return {
    environment: environment.output,
    action,
    dataset,
    bundle: bundle || (dataset ? resolve(fetchedDatasets, dataset) : ""),
  };
}

export function publicationAuthority(
  environment: RemoteEnvironment,
  action: PublishAction,
  provenance: RunProvenance,
): void {
  if (environment !== "production" || !effectfulActions.has(action)) return;
  if (provenance.kind === "local")
    throw new Error(
      "Production publishes only from the release workflow; --recover, --status, and --check-admission stay available locally",
    );
  if (provenance.workflow !== releaseSigner)
    throw new Error(`Production publishes only from ${releaseSigner}`);
}

interface AdmittedCandidate {
  readonly sourceTree: string;
  readonly manifest: Awaited<ReturnType<typeof checkDataBundle>>;
  readonly manifestSha256: string;
  readonly previous: ReleaseTarget | null;
}

async function admitCandidate(
  environment: RemoteEnvironment,
  store: ControlStore,
  options: PublishArguments,
  journal: ReleaseJournal | null,
): Promise<AdmittedCandidate> {
  const sourceTree = await committedTree();
  const manifest = await checkDataBundle(options.bundle);
  const manifestSha256 = await fileDigest(
    join(options.bundle, "manifest.ready.json"),
  );
  if (manifestSha256 !== options.dataset)
    throw new Error("The bundle's manifest differs from the --dataset digest");
  if (environment === "production") {
    await requireCandidateEvidence(store, sourceTree, manifestSha256);
    const staging = (await loadRelease(store, "staging"))?.journal;
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
  } else await requireLocalReceipts(sourceTree);
  const previous = verifiedPredecessor(journal);
  const catalog: unknown = JSON.parse(
    await readFile(join(options.bundle, "catalog.json"), "utf8"),
  );
  const precedingCatalog =
    previous && environment === "production"
      ? v.parse(
          CatalogSchema,
          JSON.parse(
            await readFile(
              join(await verificationBundle(store, previous), "catalog.json"),
              "utf8",
            ),
          ),
        )
      : undefined;
  validatePublicationCoverage(catalog, precedingCatalog);
  return { sourceTree, manifest, manifestSha256, previous };
}

async function requireLocalReceipts(sourceTree: string): Promise<void> {
  await requireVerificationReceipt(sourceTree);
  await requireCommand(process.execPath, ["tools/prove.ts", "--check-receipt"]);
}

async function checkAdmission(
  options: PublishArguments,
  store: ControlStore,
): Promise<void> {
  const journal = (await loadRelease(store, options.environment))?.journal;
  try {
    if (
      journal &&
      journal.phase !== "verified" &&
      journal.phase !== "recovered"
    )
      throw new Error("An incomplete publication requires recovery");
    const admitted = await admitCandidate(
      options.environment,
      store,
      options,
      journal ?? null,
    );
    if (!admitted.previous)
      throw new Error("Publication requires a verified predecessor");
    console.info(
      JSON.stringify({
        operation: "publication.admission",
        environment: options.environment,
        sourceTree: admitted.sourceTree,
        dataset: admitted.manifestSha256,
        result: "admitted",
      }),
    );
  } catch (error) {
    console.info(
      JSON.stringify({
        operation: "publication.admission",
        environment: options.environment,
        dataset: options.dataset,
        result: "refused",
        reason: error instanceof Error ? error.message : "unknown",
      }),
    );
    throw error;
  }
}

async function main(args: readonly string[]): Promise<void> {
  const options = parsePublishArguments(args);
  const { environment, action, bundle } = options;
  const store = controlStoreFromEnvironment();
  const provenance = runProvenance();
  publicationAuthority(environment, action, provenance);
  if (action === "--check-admission") {
    await checkAdmission(options, store);
    return;
  }
  if (action === "--status") {
    const head = await loadRelease(store, environment);
    console.info(
      JSON.stringify({
        operation: "publication.status",
        environment,
        sequence: head?.record.sequence ?? null,
        provenance: head?.record.provenance ?? null,
        journal: head?.journal ?? null,
        active: await activeVersion(environment),
      }),
    );
    return;
  }
  const lease = await acquireLease(store, environment, provenance);
  let buildUnlock: (() => Promise<void>) | null = null;
  async function releaseBuild(): Promise<void> {
    const release = buildUnlock;
    buildUnlock = null;
    await release?.();
  }
  try {
    const context: PublicationContext = {
      environment,
      store,
      lease,
      writer: journalWriter(
        store,
        environment,
        provenance,
        await loadRelease(store, environment),
      ),
    };
    let journal = context.writer.current()?.journal ?? null;
    const ports = releasePorts(context, bundle);
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
    if (action === "--resume-bootstrap") {
      const initialTree = await committedTree();
      await requireLocalReceipts(initialTree);
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
      await adoptProduction(bundle, context);
      return;
    }
    const bootstrap = action === "--bootstrap";
    if (bootstrap) {
      if (
        environment !== "staging" ||
        (journal && !ownsUnverifiedBootstrap(journal, await ports.active()))
      )
        throw new Error(
          "Bootstrap is restricted to an unverified protected staging publication",
        );
      journal = null;
    } else if (
      journal &&
      journal.phase !== "verified" &&
      journal.phase !== "recovered"
    )
      journal = await recoverRelease(journal, ports);
    const { sourceTree, manifest, manifestSha256, previous } =
      await admitCandidate(environment, store, options, journal);
    const exercise = action === "--rehearse-recovery";
    if (exercise && (environment !== "staging" || !previous))
      throw new Error(
        "Recovery exercises require an existing verified staging publication",
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
    if ((await storeVerificationDataset(store, bundle)) !== manifestSha256)
      throw new Error("The verification dataset changed during publication");
    const target: ReleaseTarget = {
      releaseId: randomUUID(),
      versionId: "",
      sourceTree,
      snapshot: manifest.snapshot,
      databaseSha256: manifest.databaseSha256,
      databaseId: prepared.database,
      manifestSha256,
      artifactSha256: await buildDigest(resolve(workerBuildDirectory)),
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
      const recovered = context.writer.current()?.journal;
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
      await lease.release();
    }
  }
}

if (process.argv[1] === resolve("tools/publish.ts"))
  await main(process.argv.slice(commandArgumentOffset));
