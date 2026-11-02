import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import * as v from "valibot";
import { releaseControl } from "../src/core/environment.ts";
import { DigestSchema } from "../src/core/models.ts";
import { evidenceAdmission } from "../src/core/publication-policy.ts";
import {
  type ControlStore,
  controlKeys,
  isConflict,
  type RemoteEnvironment,
  readObject,
  SequenceSchema,
  sha256Hex,
  writeOnce,
} from "./control-store.ts";
import {
  type ReleaseJournal,
  type ReleasePhase,
  type ReleaseTarget,
  releasePhases,
} from "./release-lifecycle.ts";

export type { RemoteEnvironment } from "./control-store.ts";

const sourceTree = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u));
const nonempty = v.pipe(v.string(), v.minLength(1));
const jsonIndentation = 2;
const leaseStaleMs = 60000;
const leaseUpdateMs = 10000;
const legacyJournalFormat = 1;
const journalFormat = 2;
const evidenceFormat = 1;
const legacyPhases = [
  "preparing",
  "activating",
  "checking",
  "recovering",
  "verified",
  "recovered",
] as const satisfies readonly ReleasePhase[];
const versionedPhases: ReadonlySet<ReleasePhase> = new Set([
  "staged",
  "candidate-verified",
  "verified",
]);
const predecessorPhases: ReadonlySet<ReleasePhase> = new Set([
  "staged",
  "candidate-verified",
  "withdrawing",
  "withdrawn",
  "recovered",
]);
export const RemoteEnvironmentSchema = v.picklist(["production"]);

export const RunProvenanceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("github-actions"),
    repository: v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/u)),
    workflow: v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+\/\S+@\S+$/u)),
    runId: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/u)),
    runAttempt: v.pipe(v.number(), v.integer(), v.minValue(1)),
    commit: sourceTree,
    actor: nonempty,
  }),
  v.strictObject({ kind: v.literal("local") }),
]);
export type RunProvenance = v.InferOutput<typeof RunProvenanceSchema>;

export function runProvenance(
  variables: NodeJS.ProcessEnv = process.env,
): RunProvenance {
  if (variables.GITHUB_ACTIONS !== "true") return { kind: "local" };
  return v.parse(RunProvenanceSchema, {
    kind: "github-actions",
    repository: variables.GITHUB_REPOSITORY,
    workflow: variables.GITHUB_WORKFLOW_REF,
    runId: variables.GITHUB_RUN_ID,
    runAttempt: Number(variables.GITHUB_RUN_ATTEMPT),
    commit: variables.GITHUB_SHA,
    actor: variables.GITHUB_ACTOR,
  });
}

export function provenanceSigner(provenance: RunProvenance): string {
  return provenance.kind === "local" ? "local" : provenance.workflow;
}

export const candidateSigner = `${releaseControl.repository}/${releaseControl.candidateWorkflow}@refs/heads/${releaseControl.releaseBranch}`;
export const releaseSigner = `${releaseControl.repository}/.github/workflows/${releaseControl.releaseWorkflow}@refs/heads/${releaseControl.releaseBranch}`;
const controlsWorkflow = "pipeline-controls.yml";
export const controlsSigner = `${releaseControl.repository}/.github/workflows/${controlsWorkflow}@refs/heads/${releaseControl.releaseBranch}`;
export const evidenceSigners: readonly string[] = [
  candidateSigner,
  releaseSigner,
];

const targetEntries = {
  releaseId: v.pipe(v.string(), v.uuid()),
  versionId: v.union([v.literal(""), v.pipe(v.string(), v.uuid())]),
  sourceTree: v.nullable(sourceTree),
  snapshot: DigestSchema,
  databaseSha256: DigestSchema,
  databaseId: v.pipe(v.string(), v.uuid()),
  manifestSha256: DigestSchema,
  artifactSha256: v.nullable(DigestSchema),
  manifestBinding: v.picklist(["snapshot", "digest"]),
};
function boundTarget(target: {
  readonly manifestBinding: "snapshot" | "digest";
  readonly sourceTree: string | null;
  readonly artifactSha256: string | null;
}): boolean {
  return (
    target.manifestBinding === "snapshot" ||
    (target.sourceTree !== null && target.artifactSha256 !== null)
  );
}
function consistentJournal(journal: {
  readonly phase: ReleasePhase;
  readonly candidate: { readonly versionId: string };
  readonly previous: { readonly versionId: string } | null;
}): boolean {
  return (
    (!versionedPhases.has(journal.phase) ||
      journal.candidate.versionId !== "") &&
    (!predecessorPhases.has(journal.phase) || journal.previous !== null) &&
    (!journal.previous || journal.previous.versionId !== "")
  );
}
export const ReleaseTargetSchema = v.pipe(
  v.strictObject(targetEntries),
  v.check((target) => boundTarget(target)),
);
export const JournalRecordSchema = v.pipe(
  v.strictObject({
    formatVersion: v.literal(journalFormat),
    environment: RemoteEnvironmentSchema,
    sequence: SequenceSchema,
    phase: v.picklist(releasePhases),
    candidate: ReleaseTargetSchema,
    previous: v.nullable(ReleaseTargetSchema),
    provenance: RunProvenanceSchema,
  }),
  v.check((journal) => consistentJournal(journal)),
);
export type JournalRecord = v.InferOutput<typeof JournalRecordSchema>;

const LegacyTargetSchema = v.pipe(
  v.strictObject({ ...targetEntries, bundle: nonempty }),
  v.check((target) => boundTarget(target)),
);
export const LegacyJournalSchema = v.pipe(
  v.strictObject({
    formatVersion: v.literal(legacyJournalFormat),
    phase: v.picklist(legacyPhases),
    candidate: LegacyTargetSchema,
    previous: v.nullable(LegacyTargetSchema),
  }),
  v.check((journal) => consistentJournal(journal)),
);

export interface LegacyJournalSource {
  readonly environment: RemoteEnvironment;
  readonly fileName: string;
  readonly record: unknown;
  readonly manifestDigest: (bundleName: string) => string | undefined;
}

export function legacyBundleName(bundle: string): string {
  return bundle.split("/").at(-1) ?? "";
}

export function convertLegacyJournal(
  source: LegacyJournalSource,
): ReleaseJournal {
  const legacy = v.parse(LegacyJournalSchema, source.record);
  if (
    source.fileName !== `${source.environment}-journal.json` &&
    source.fileName !==
      `${source.environment}-${legacy.candidate.releaseId}.json`
  )
    throw new Error(
      `A format 1 journal name doesn't match its release: ${source.fileName}`,
    );
  function convert(
    target: v.InferOutput<typeof LegacyTargetSchema>,
  ): ReleaseTarget {
    const name = legacyBundleName(target.bundle);
    if (name !== target.manifestSha256)
      throw new Error(
        `A format 1 bundle name differs from its manifest digest: ${source.fileName}`,
      );
    if (source.manifestDigest(name) !== target.manifestSha256)
      throw new Error(
        `A format 1 bundle manifest differs from its recorded digest: ${source.fileName}`,
      );
    const { bundle: _bundle, ...converted } = target;
    return converted;
  }
  return {
    phase: legacy.phase,
    candidate: convert(legacy.candidate),
    previous: legacy.previous ? convert(legacy.previous) : null,
  };
}

export function journalRecord(
  environment: RemoteEnvironment,
  sequence: number,
  journal: ReleaseJournal,
  provenance: RunProvenance,
): JournalRecord {
  return v.parse(JournalRecordSchema, {
    formatVersion: journalFormat,
    environment,
    sequence,
    phase: journal.phase,
    candidate: journal.candidate,
    previous: journal.previous,
    provenance,
  });
}

export function encodeRecord(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify(value, null, jsonIndentation)}\n`,
  );
}

function decodeRecord(
  environment: RemoteEnvironment,
  bytes: Uint8Array,
): JournalRecord {
  const record = v.parse(
    JournalRecordSchema,
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (record.environment !== environment)
    throw new Error("A publication journal belongs to another environment");
  return record;
}

function journalOf(record: JournalRecord): ReleaseJournal {
  return {
    phase: record.phase,
    candidate: record.candidate,
    previous: record.previous,
  };
}

export interface JournalHead {
  readonly journal: ReleaseJournal;
  readonly record: JournalRecord;
  readonly bytes: Uint8Array;
  readonly etag: string;
}

export async function loadRelease(
  store: ControlStore,
  environment: RemoteEnvironment,
): Promise<JournalHead | null> {
  const object = await readObject(store, controlKeys.journalHead(environment));
  if (!object) return null;
  const record = decodeRecord(environment, object.body);
  return {
    journal: journalOf(record),
    record,
    bytes: object.body,
    etag: object.etag,
  };
}

async function appendHistory(
  store: ControlStore,
  environment: RemoteEnvironment,
  sequence: number,
  bytes: Uint8Array,
): Promise<void> {
  const key = controlKeys.journalHistory(environment, sequence);
  const present = await store.head(key);
  if (present) {
    const stored = await readObject(store, key);
    if (stored && sha256Hex(stored.body) === sha256Hex(bytes)) return;
    throw new Error(`The publication history diverged at ${key}`);
  }
  await writeOnce(store, key, bytes);
}

export async function saveRelease(
  store: ControlStore,
  environment: RemoteEnvironment,
  journal: ReleaseJournal,
  provenance: RunProvenance,
  head: JournalHead | null,
): Promise<JournalHead> {
  if (head)
    await appendHistory(store, environment, head.record.sequence, head.bytes);
  const record = journalRecord(
    environment,
    (head?.record.sequence ?? 0) + 1,
    journal,
    provenance,
  );
  const bytes = encodeRecord(record);
  const written = await store.write(
    controlKeys.journalHead(environment),
    bytes,
    head ? { kind: "replace", etag: head.etag } : { kind: "create" },
  );
  await appendHistory(store, environment, record.sequence, bytes);
  return { journal: journalOf(record), record, bytes, etag: written.etag };
}

export interface JournalWriter {
  current(): JournalHead | null;
  save(journal: ReleaseJournal): Promise<void>;
}

export function journalWriter(
  store: ControlStore,
  environment: RemoteEnvironment,
  provenance: RunProvenance,
  initial: JournalHead | null,
): JournalWriter {
  let head = initial;
  return {
    current: (): JournalHead | null => head,
    async save(journal): Promise<void> {
      head = await saveRelease(store, environment, journal, provenance, head);
    },
  };
}

export async function releaseHistory(
  store: ControlStore,
  environment: RemoteEnvironment,
): Promise<readonly ReleaseJournal[]> {
  const head = await loadRelease(store, environment);
  if (!head) return [];
  const journals: ReleaseJournal[] = [];
  for (let sequence = 1; sequence < head.record.sequence; sequence += 1) {
    const object = await readObject(
      store,
      controlKeys.journalHistory(environment, sequence),
    );
    if (!object)
      throw new Error(`The publication history is missing record ${sequence}`);
    const record = decodeRecord(environment, object.body);
    if (record.sequence !== sequence)
      throw new Error(`The publication history is out of order at ${sequence}`);
    journals.push(journalOf(record));
  }
  journals.push(head.journal);
  return journals;
}

export const datasetFiles = ["manifest.ready.json", "catalog.json"] as const;

export async function storeVerificationDataset(
  store: ControlStore,
  bundle: string,
): Promise<string> {
  const manifest = new Uint8Array(
    await readFile(join(bundle, "manifest.ready.json")),
  );
  const manifestSha256 = sha256Hex(manifest);
  for (const file of datasetFiles)
    await writeOnce(
      store,
      controlKeys.dataset(manifestSha256, file),
      file === "manifest.ready.json"
        ? manifest
        : new Uint8Array(await readFile(join(bundle, file))),
    );
  return manifestSha256;
}

export async function materializeVerificationDataset(
  store: ControlStore,
  manifestSha256: string,
  directory: string,
): Promise<string> {
  const destination = join(directory, v.parse(DigestSchema, manifestSha256));
  await mkdir(destination, { recursive: true });
  for (const file of datasetFiles) {
    const object = await readObject(
      store,
      controlKeys.dataset(manifestSha256, file),
    );
    if (!object) throw new Error(`The verification dataset is missing ${file}`);
    if (
      file === "manifest.ready.json" &&
      sha256Hex(object.body) !== manifestSha256
    )
      throw new Error("The stored manifest differs from its digest");
    await writeFile(join(destination, file), object.body, { flush: true });
  }
  return destination;
}

export const candidateStages = [
  "check",
  "data",
  "phones",
  "prove",
  "e2e",
] as const;
export type CandidateStage = (typeof candidateStages)[number];
export const CandidateEvidenceSchema = v.strictObject({
  formatVersion: v.literal(evidenceFormat),
  stage: v.picklist(candidateStages),
  sourceTree,
  manifestSha256: DigestSchema,
  result: v.picklist(["passed", "failed"]),
  provenance: RunProvenanceSchema,
});
export type CandidateEvidence = v.InferOutput<typeof CandidateEvidenceSchema>;

export async function recordCandidateEvidence(
  store: ControlStore,
  evidence: CandidateEvidence,
): Promise<"created" | "unchanged"> {
  const record = v.parse(CandidateEvidenceSchema, evidence);
  if (record.result !== "passed")
    throw new Error("Only a passing stage becomes candidate evidence");
  const key = controlKeys.candidate(
    record.sourceTree,
    record.manifestSha256,
    record.stage,
  );
  try {
    await store.write(key, encodeRecord(record), { kind: "create" });
    return "created";
  } catch (error) {
    if (!isConflict(error)) throw error;
    const existing = await readObject(store, key);
    const stored = existing
      ? v.safeParse(
          CandidateEvidenceSchema,
          JSON.parse(new TextDecoder().decode(existing.body)),
        )
      : null;
    if (
      stored?.success &&
      stored.output.stage === record.stage &&
      stored.output.sourceTree === record.sourceTree &&
      stored.output.manifestSha256 === record.manifestSha256 &&
      stored.output.result === "passed" &&
      provenanceSigner(stored.output.provenance) ===
        provenanceSigner(record.provenance)
    )
      return "unchanged";
    throw new Error(`Different candidate evidence already exists: ${key}`, {
      cause: error,
    });
  }
}

export interface StageAdmission {
  readonly stage: CandidateStage;
  readonly decision: ReturnType<typeof evidenceAdmission>;
}

export async function candidateEvidenceAdmission(
  store: ControlStore,
  expectedTree: string,
  expectedManifest: string,
  expectedSigners: readonly string[] = evidenceSigners,
): Promise<readonly StageAdmission[]> {
  const admissions: StageAdmission[] = [];
  for (const stage of candidateStages) {
    const object = await readObject(
      store,
      controlKeys.candidate(expectedTree, expectedManifest, stage),
    );
    const parsed = object
      ? v.safeParse(
          CandidateEvidenceSchema,
          JSON.parse(new TextDecoder().decode(object.body)),
        )
      : null;
    const evidence =
      parsed?.success && parsed.output.stage === stage ? parsed.output : null;
    if (parsed && !evidence)
      throw new Error(`Candidate evidence for ${stage} is malformed`);
    const signer = evidence ? provenanceSigner(evidence.provenance) : "";
    admissions.push({
      stage,
      decision: evidenceAdmission(
        evidence !== null,
        evidence?.sourceTree ?? "",
        expectedTree,
        evidence?.manifestSha256 ?? "",
        expectedManifest,
        signer,
        expectedSigners.includes(signer) ? signer : (expectedSigners[0] ?? ""),
        evidence?.result === "passed",
      ),
    });
  }
  return admissions;
}

export async function requireCandidateEvidence(
  store: ControlStore,
  expectedTree: string,
  expectedManifest: string,
  expectedSigners: readonly string[] = evidenceSigners,
): Promise<void> {
  const refused = (
    await candidateEvidenceAdmission(
      store,
      expectedTree,
      expectedManifest,
      expectedSigners,
    )
  ).filter((admission) => admission.decision !== "admit");
  if (refused.length)
    throw new Error(
      `Candidate evidence was refused: ${refused.map((admission) => `${admission.stage} ${admission.decision}`).join(", ")}`,
    );
}

export async function releaseLock(
  name: "build",
  directory = join(homedir(), ".local/state/public-phonebook/locks"),
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  return lock(join(directory, name), {
    realpath: false,
    stale: leaseStaleMs,
    update: leaseUpdateMs,
    retries: 0,
  });
}
