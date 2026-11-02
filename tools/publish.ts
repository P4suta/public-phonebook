import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { databaseResourceName, environments } from "../src/core/environment.ts";
import { CatalogSchema, DigestSchema } from "../src/core/models.ts";
import { checkDataBundle } from "./check-data.ts";
import { acquireLease, type PublicationLease } from "./control-lease.ts";
import {
  type ControlStore,
  controlStoreFromEnvironment,
} from "./control-store.ts";
import { command, requireCommand } from "./process.ts";
import {
  awaitExpectedVersion,
  publicAccess,
  type VersionMode,
} from "./public-request.ts";
import { validatePublicationCoverage } from "./publication-coverage.ts";
import {
  beforeTraffic,
  type DeployedVersions,
  drillWithdrawal,
  isTerminal,
  promoteCandidate,
  type ReleaseJournal,
  type ReleasePorts,
  type ReleaseTarget,
  recoverPublication,
  stageCandidate,
  verifiedPredecessor,
  verifyStagedCandidate,
  withdrawCandidate,
} from "./release-lifecycle.ts";
import {
  activeDatabaseId,
  deployAlone,
  deployCandidate,
  deployedVersions,
  liveWorkerSettings,
  restoreVersion,
  uploadVersion,
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
import { auditVerificationArtifacts } from "./verification-artifacts.ts";
import {
  readCandidateWorkerSettings,
  requireUnchangedWorkerSettings,
} from "./worker-settings.ts";

const commandArgumentOffset = 2;
const workerBuildDirectory = ".cloudflare/output/v0/workers/default";
const verificationCache = ".local/control-cache/datasets";
const fetchedDatasets = ".local/datasets";
const probeLedgers = ".local/probe-ledgers";
const treeSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u));
const ReleaseIdSchema = v.pipe(v.string(), v.uuid());
const actionsMask = "::add-mask::";
export const maskedVersion = "masked";

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

export function maskVersion(
  versionId: string,
  provenance: RunProvenance,
  write: (line: string) => void = console.info,
): void {
  if (versionId && provenance.kind === "github-actions")
    write(`${actionsMask}${versionId}`);
}

export function maskCandidate(
  journal: ReleaseJournal | null,
  provenance: RunProvenance,
  write: (line: string) => void = console.info,
): void {
  if (journal && beforeTraffic(journal.phase))
    maskVersion(journal.candidate.versionId, provenance, write);
}

export function publicJournal(
  journal: ReleaseJournal | null,
): ReleaseJournal | null {
  if (!journal || !beforeTraffic(journal.phase) || !journal.candidate.versionId)
    return journal;
  return {
    ...journal,
    candidate: { ...journal.candidate, versionId: maskedVersion },
  };
}

export function publicDeployment(deployed: DeployedVersions): DeployedVersions {
  return {
    current: deployed.current,
    candidate: deployed.candidate
      ? { ...deployed.candidate, versionId: maskedVersion }
      : null,
  };
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
  mode: VersionMode,
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
  process.env.DIAL_PUBLIC_VERSION = target.versionId;
  process.env.DIAL_PUBLIC_VERSION_MODE = mode;
  process.env.DIAL_PROBE_LEDGER ??= resolve(
    probeLedgers,
    `${randomUUID()}.json`,
  );
  await awaitExpectedVersion(publicAccess());
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
      mode === "override" ? [target.versionId] : [],
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "Public verification did not pass");
}

interface PublicationContext {
  readonly environment: RemoteEnvironment;
  readonly store: ControlStore;
  readonly writer: JournalWriter;
  readonly lease: PublicationLease;
  readonly provenance: RunProvenance;
}

function releasePorts(
  { environment, store, writer, lease, provenance }: PublicationContext,
  sourceBundle: string,
): ReleasePorts {
  return {
    async save(journal): Promise<void> {
      lease.assertHeld();
      await writer.save(journal);
    },
    deployed: () => deployedVersions(environment),
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
        throw new Error("The prepared candidate changed before its upload");
      const current = (await deployedVersions(environment)).current;
      requireUnchangedWorkerSettings(
        await readCandidateWorkerSettings(),
        await liveWorkerSettings(environment, current.versionId),
      );
    },
    async stage(target, current): Promise<void> {
      lease.assertHeld();
      const versionId = await uploadVersion(environment, target);
      maskVersion(versionId, provenance);
      if (
        (await buildDigest(resolve(workerBuildDirectory))) !==
        target.artifactSha256
      )
        throw new Error("The upload changed the verified Worker or assets");
      await verifyVersionBindings(environment, { ...target, versionId });
      lease.assertHeld();
      await deployCandidate(environment, current.versionId, versionId);
    },
    async withdraw(current): Promise<void> {
      lease.assertHeld();
      await deployAlone(environment, current.versionId);
    },
    async activate(candidate): Promise<void> {
      lease.assertHeld();
      await deployAlone(environment, candidate.versionId);
    },
    async restore(previous): Promise<void> {
      lease.assertHeld();
      await restoreVersion(environment, previous);
    },
    verifyCandidate: (target) =>
      verifyTarget(environment, target, store, "override"),
    verify: (target, evidence) =>
      verifyTarget(environment, target, store, evidence),
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

async function adoptProduction(
  bundle: string,
  context: PublicationContext,
): Promise<void> {
  if (context.writer.current())
    throw new Error("Production already has a publication journal");
  const manifest = await checkDataBundle(bundle, "retained");
  const active = (await deployedVersions("production")).current;
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
  await verifyTarget("production", target, context.store, "optional");
  if (
    (await deployedVersions("production")).current.versionId !==
    target.versionId
  )
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
  "--stage",
  "--verify-candidate",
  "--promote",
  "--withdraw",
  "--recover",
  "--status",
  "--check-admission",
  "--drill",
  "--adopt",
] as const;
export type PublishAction = (typeof publishActions)[number];
const datasetActions: ReadonlySet<PublishAction> = new Set([
  "publish",
  "--stage",
  "--drill",
  "--adopt",
  "--check-admission",
]);
const effectfulActions: ReadonlySet<PublishAction> = new Set([
  "publish",
  "--stage",
  "--verify-candidate",
  "--promote",
  "--drill",
  "--adopt",
]);
const publishUsage = `Usage: publish ENVIRONMENT [${publishActions.filter((action) => action !== "publish").join("|")}] [--dataset MANIFEST_SHA256] [--bundle DIRECTORY] [--release RELEASE_ID]`;

export interface PublishArguments {
  readonly environment: RemoteEnvironment;
  readonly action: PublishAction;
  readonly dataset: string;
  readonly bundle: string;
  readonly release: string;
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
  let release = "";
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === "--dataset" && value && !dataset) {
      dataset = v.parse(DigestSchema, value);
      index += 1;
    } else if (flag === "--bundle" && value && !bundle) {
      bundle = resolve(value);
      index += 1;
    } else if (flag === "--release" && value && !release) {
      release = v.parse(ReleaseIdSchema, value);
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
  if ((action === "--promote") !== (release !== ""))
    throw new Error(
      action === "--promote"
        ? "Promotion requires the approved --release"
        : `The ${action} action takes no release`,
    );
  if (bundle && !dataset) throw new Error(publishUsage);
  return {
    environment: environment.output,
    action,
    dataset,
    bundle: bundle || (dataset ? resolve(fetchedDatasets, dataset) : ""),
    release,
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
      "Production publishes only from the release workflow; --withdraw, --recover, --status, and --check-admission stay available locally",
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
  await requireCandidateEvidence(store, sourceTree, manifestSha256);
  const previous = verifiedPredecessor(journal);
  const catalog: unknown = JSON.parse(
    await readFile(join(options.bundle, "catalog.json"), "utf8"),
  );
  const precedingCatalog = previous
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

async function checkAdmission(
  options: PublishArguments,
  store: ControlStore,
  journal: ReleaseJournal | null,
): Promise<void> {
  try {
    const admitted = await admitCandidate(store, options, journal);
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

function requireJournal(
  journal: ReleaseJournal | null,
  action: PublishAction,
): ReleaseJournal {
  if (!journal)
    throw new Error(`There is no publication journal for ${action}`);
  return journal;
}

function report(
  operation: string,
  environment: RemoteEnvironment,
  journal: ReleaseJournal,
): void {
  console.info(
    JSON.stringify({
      operation,
      environment,
      releaseId: journal.candidate.releaseId,
      snapshot: journal.candidate.snapshot,
      phase: journal.phase,
      versionId: publicJournal(journal)?.candidate.versionId,
    }),
  );
}

async function main(args: readonly string[]): Promise<void> {
  const options = parsePublishArguments(args);
  const { environment, action, bundle } = options;
  const store = controlStoreFromEnvironment();
  const provenance = runProvenance();
  publicationAuthority(environment, action, provenance);
  const head = await loadRelease(store, environment);
  maskCandidate(head?.journal ?? null, provenance);
  if (action === "--check-admission") {
    await checkAdmission(options, store, head?.journal ?? null);
    return;
  }
  if (action === "--status") {
    console.info(
      JSON.stringify({
        operation: "publication.status",
        environment,
        sequence: head?.record.sequence ?? null,
        provenance: head?.record.provenance ?? null,
        journal: publicJournal(head?.journal ?? null),
        deployed: publicDeployment(await deployedVersions(environment)),
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
      provenance,
      writer: journalWriter(store, environment, provenance, head),
    };
    let journal = head?.journal ?? null;
    const ports = releasePorts(context, bundle);
    if (action === "--recover") {
      const recovered = await recoverPublication(
        requireJournal(journal, action),
        ports,
      );
      report("publication.recover", environment, recovered);
      return;
    }
    if (action === "--withdraw") {
      const withdrawn = await withdrawCandidate(
        requireJournal(journal, action),
        ports,
      );
      report("publication.withdraw", environment, withdrawn);
      return;
    }
    if (action === "--verify-candidate") {
      const verified = await verifyStagedCandidate(
        requireJournal(journal, action),
        ports,
      );
      report("publication.candidate", environment, verified);
      return;
    }
    if (action === "--promote") {
      const promoted = await promoteCandidate(
        requireJournal(journal, action),
        options.release,
        ports,
      );
      report("publication", environment, promoted);
      return;
    }
    if (action === "--adopt") {
      await adoptProduction(bundle, context);
      return;
    }
    if (journal && !isTerminal(journal.phase))
      journal = await recoverPublication(journal, ports);
    const { sourceTree, manifest, manifestSha256, previous } =
      await admitCandidate(store, options, journal);
    if (!previous)
      throw new Error("Publication requires a verified predecessor");
    process.env.DIAL_DATABASE_SHA256 = manifest.databaseSha256;
    process.env.DIAL_MANIFEST_SHA256 = manifestSha256;
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
      async stage(candidate, current): Promise<void> {
        try {
          await ports.stage(candidate, current);
        } finally {
          await releaseBuild();
        }
      },
    };
    if (action === "--drill") {
      const withdrawn = await drillWithdrawal(target, previous, guardedPorts);
      report("publication.drill", environment, withdrawn);
      return;
    }
    const staged = await stageCandidate(target, previous, guardedPorts);
    report("publication.stage", environment, staged);
    if (action === "--stage") return;
    const verified = await verifyStagedCandidate(staged, guardedPorts);
    report("publication.candidate", environment, verified);
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
