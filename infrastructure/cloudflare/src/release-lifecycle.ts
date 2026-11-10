import {
  type PromotionAdmission,
  promotionAdmission,
  recoveryDecision,
  targetBinding,
  withdrawalDecision,
} from "@public-phonebook/directory/publication-policy";

export interface ReleaseTarget {
  readonly releaseId: string;
  readonly versionId: string;
  readonly sourceTree: string | null;
  readonly snapshot: string;
  readonly databaseSha256: string;
  readonly databaseId: string;
  readonly manifestSha256: string;
  readonly artifactSha256: string | null;
  readonly manifestBinding: "snapshot" | "digest";
}
export const releasePhases = [
  "preparing",
  "staged",
  "candidate-verified",
  "withdrawing",
  "withdrawn",
  "activating",
  "checking",
  "recovering",
  "verified",
  "recovered",
] as const;
export type ReleasePhase = (typeof releasePhases)[number];
export interface ReleaseJournal {
  readonly phase: ReleasePhase;
  readonly candidate: ReleaseTarget;
  readonly previous: ReleaseTarget | null;
}
export interface ActiveVersion {
  readonly versionId: string;
  readonly releaseId: string;
}
export interface DeployedVersions {
  readonly current: ActiveVersion;
  readonly candidate: ActiveVersion | null;
}
export type VersionEvidence = "required" | "optional";
export interface ReleasePorts {
  save(journal: ReleaseJournal): Promise<void>;
  deployed(): Promise<DeployedVersions>;
  prepare(candidate: ReleaseTarget): Promise<void>;
  stage(candidate: ReleaseTarget, current: ReleaseTarget): Promise<void>;
  withdraw(current: ReleaseTarget): Promise<void>;
  activate(candidate: ReleaseTarget): Promise<void>;
  restore(previous: ReleaseTarget): Promise<void>;
  verifyCandidate(candidate: ReleaseTarget): Promise<void>;
  verify(target: ReleaseTarget, evidence: VersionEvidence): Promise<void>;
}

const preTrafficPhases: ReadonlySet<ReleasePhase> = new Set([
  "preparing",
  "staged",
  "candidate-verified",
  "withdrawing",
  "withdrawn",
]);
const terminalPhases: ReadonlySet<ReleasePhase> = new Set([
  "verified",
  "recovered",
  "withdrawn",
]);

/** A candidate in these phases passed the staging preparation, which admits only a database that passed the full verification. */
const preparedPhases: ReadonlySet<ReleasePhase> = new Set([
  "staged",
  "candidate-verified",
  "activating",
  "checking",
  "recovering",
  "verified",
  "recovered",
]);

export interface PublicationBinding {
  readonly bound: boolean;
  readonly verifiedRelease: string | null;
}

/** Lists the targets whose Worker versions the deployment may hold in this phase, predecessor first. */
function deployableTargets(
  journal: ReleaseJournal,
): readonly { readonly target: ReleaseTarget; readonly prepared: boolean }[] {
  const previous = journal.previous
    ? [{ target: journal.previous, prepared: true }]
    : [];
  if (journal.phase === "verified")
    return [{ target: journal.candidate, prepared: true }];
  if (journal.phase === "withdrawn" || journal.phase === "recovered")
    return previous;
  return [
    ...previous,
    { target: journal.candidate, prepared: preparedPhases.has(journal.phase) },
  ];
}

/**
 * Reports whether a deployable version of the journal binds the D1 database with this ID, and names the release whose staging verified exactly this database for this dataset.
 * A target of the same dataset that names another D1 database doesn't bind this one, because a database's name also covers its import transformation.
 * Only a target the release tools staged by digest counts, because the adopted baseline never passed this repository's import verification.
 */
export function publicationBinding(
  journal: ReleaseJournal,
  databaseSha256: string,
  databaseId: string,
): PublicationBinding {
  const bindings = deployableTargets(journal).map(({ target, prepared }) => ({
    releaseId: target.releaseId,
    binding: targetBinding(
      target.databaseId === databaseId,
      target.databaseSha256 === databaseSha256,
      prepared,
      target.manifestBinding === "digest",
    ),
  }));
  return {
    bound: bindings.some(({ binding }) => binding !== "unrelated"),
    verifiedRelease:
      bindings.find(({ binding }) => binding === "vouches")?.releaseId ?? null,
  };
}

export function beforeTraffic(phase: ReleasePhase): boolean {
  return preTrafficPhases.has(phase);
}

export function isTerminal(phase: ReleasePhase): boolean {
  return terminalPhases.has(phase);
}

export class CandidateWithdrawn extends Error {
  readonly journal: ReleaseJournal;
  constructor(journal: ReleaseJournal, cause: unknown) {
    super("The candidate failed before approval and was withdrawn", { cause });
    this.name = "CandidateWithdrawn";
    this.journal = journal;
  }
}

export class PromotionRefused extends Error {
  readonly admission: Exclude<PromotionAdmission, "promote">;
  constructor(admission: Exclude<PromotionAdmission, "promote">) {
    super(`Promotion was refused: ${admission}`);
    this.name = "PromotionRefused";
    this.admission = admission;
  }
}

export class InjectedProbeFailure extends Error {
  constructor() {
    super("The withdrawal drill injected a candidate probe failure");
    this.name = "InjectedProbeFailure";
  }
}

export function verifiedPredecessor(
  journal: ReleaseJournal | null,
): ReleaseTarget | null {
  if (!journal) return null;
  if (journal.phase === "verified") return journal.candidate;
  if (journal.phase === "recovered" || journal.phase === "withdrawn")
    return journal.previous;
  if (journal.phase === "candidate-verified")
    throw new Error(
      "A verified candidate awaits approval; promote or withdraw it before another deployment",
    );
  throw new Error("An incomplete publication requires recovery");
}

async function requireActive(
  target: ReleaseTarget,
  ports: ReleasePorts,
): Promise<void> {
  if ((await ports.deployed()).current.versionId !== target.versionId)
    throw new Error("The active Worker changed during publication");
}

async function requireStaged(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<void> {
  const deployed = await ports.deployed();
  if (
    deployed.current.versionId !== journal.previous?.versionId ||
    deployed.candidate?.versionId !== journal.candidate.versionId
  )
    throw new Error("The deployment changed while the candidate was checked");
}

export async function withdrawCandidate(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  const deployed = await ports.deployed();
  const decision = withdrawalDecision(
    beforeTraffic(journal.phase) && journal.previous !== null,
    deployed.current.versionId === journal.previous?.versionId,
    deployed.candidate !== null,
    deployed.candidate?.releaseId === journal.candidate.releaseId,
  );
  if (decision === "refuse" || !journal.previous)
    throw new Error(
      "Withdrawal requires a candidate that never took traffic, its verified predecessor serving, and no foreign candidate",
    );
  if (journal.phase === "withdrawn" && decision === "already-withdrawn")
    return journal;
  const pending: ReleaseJournal = { ...journal, phase: "withdrawing" };
  await ports.save(pending);
  if (decision === "remove-candidate") await ports.withdraw(journal.previous);
  const after = await ports.deployed();
  if (
    after.current.versionId !== journal.previous.versionId ||
    after.candidate !== null
  )
    throw new Error("The deployment still holds a candidate after withdrawal");
  const result: ReleaseJournal = { ...pending, phase: "withdrawn" };
  await ports.save(result);
  return result;
}

async function withdrawAfter(
  primary: unknown,
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<Error> {
  try {
    return new CandidateWithdrawn(
      await withdrawCandidate(journal, ports),
      primary,
    );
  } catch (withdrawal) {
    return new AggregateError(
      [primary, withdrawal],
      "The candidate failed before approval; its withdrawal remains pending",
    );
  }
}

export async function stageCandidate(
  candidate: ReleaseTarget,
  previous: ReleaseTarget,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  const before = await ports.deployed();
  if (before.current.versionId !== previous.versionId)
    throw new Error("The serving Worker isn't the verified predecessor");
  if (before.candidate)
    throw new Error(
      "A candidate is already deployed at 0%; promote or withdraw it first",
    );
  let journal: ReleaseJournal = { candidate, previous, phase: "preparing" };
  await ports.save(journal);
  try {
    await ports.prepare(candidate);
    await ports.stage(candidate, previous);
    const deployed = await ports.deployed();
    const staged = deployed.candidate;
    if (
      deployed.current.versionId !== previous.versionId ||
      !staged ||
      staged.releaseId !== candidate.releaseId
    )
      throw new Error(
        "The deployment doesn't hold this candidate at 0% beside the verified predecessor",
      );
    journal = {
      ...journal,
      candidate: { ...candidate, versionId: staged.versionId },
      phase: "staged",
    };
    await ports.save(journal);
    return journal;
  } catch (primary) {
    throw await withdrawAfter(primary, journal, ports);
  }
}

export async function verifyStagedCandidate(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  if (journal.phase !== "staged")
    throw new Error("Only a staged candidate can be checked at 0%");
  try {
    await requireStaged(journal, ports);
    await ports.verifyCandidate(journal.candidate);
    await requireStaged(journal, ports);
    const verified: ReleaseJournal = {
      ...journal,
      phase: "candidate-verified",
    };
    await ports.save(verified);
    return verified;
  } catch (primary) {
    throw await withdrawAfter(primary, journal, ports);
  }
}

export async function recoverRelease(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  if (beforeTraffic(journal.phase))
    throw new Error("A candidate that never took traffic is withdrawn");
  const pending: ReleaseJournal = { ...journal, phase: "recovering" };
  await ports.save(pending);
  const deployed = await ports.deployed();
  const active = deployed.current;
  const decision = recoveryDecision(
    journal.previous !== null,
    active.versionId === journal.previous?.versionId,
    active.releaseId === journal.candidate.releaseId &&
      (journal.candidate.versionId === "" ||
        active.versionId === journal.candidate.versionId),
  );
  if (decision === "refuse" || !journal.previous)
    throw new Error(
      "Recovery requires the verified predecessor and an owned active version",
    );
  if (decision === "restore-previous") await ports.restore(journal.previous);
  else if (deployed.candidate?.releaseId === journal.candidate.releaseId)
    await ports.withdraw(journal.previous);
  await requireActive(journal.previous, ports);
  await ports.verify(journal.previous, "optional");
  await requireActive(journal.previous, ports);
  const result: ReleaseJournal = { ...pending, phase: "recovered" };
  await ports.save(result);
  return result;
}

export async function recoverPublication(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  if (journal.phase === "candidate-verified")
    throw new Error(
      "A verified candidate awaits approval; withdraw it explicitly instead",
    );
  return beforeTraffic(journal.phase)
    ? withdrawCandidate(journal, ports)
    : recoverRelease(journal, ports);
}

export async function runRelease(
  verifiedCandidate: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  if (
    verifiedCandidate.phase !== "candidate-verified" ||
    !verifiedCandidate.previous
  )
    throw new Error(
      "Only a candidate verified at 0% beside its verified predecessor can take traffic",
    );
  let journal: ReleaseJournal = { ...verifiedCandidate, phase: "activating" };
  await ports.save(journal);
  try {
    await ports.activate(journal.candidate);
    await requireActive(journal.candidate, ports);
    journal = { ...journal, phase: "checking" };
    await ports.save(journal);
    await ports.verify(journal.candidate, "required");
    await requireActive(journal.candidate, ports);
    const result: ReleaseJournal = { ...journal, phase: "verified" };
    await ports.save(result);
    return result;
  } catch (primary) {
    try {
      await recoverRelease(journal, ports);
    } catch (recovery) {
      throw new AggregateError(
        [primary, recovery],
        "Publication failed; recovery remains pending",
      );
    }
    throw new Error(
      "Publication failed; the verified predecessor was restored",
      { cause: primary },
    );
  }
}

export async function promoteCandidate(
  journal: ReleaseJournal,
  approvedRelease: string,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  if (journal.candidate.releaseId !== approvedRelease)
    throw new Error("The approval names a release other than the candidate");
  const deployed = await ports.deployed();
  const admission = promotionAdmission(
    journal.phase === "candidate-verified",
    journal.candidate.versionId,
    deployed.candidate !== null,
    deployed.candidate?.versionId ?? "",
    journal.previous?.versionId ?? "",
    deployed.current.versionId,
  );
  if (admission !== "promote") throw new PromotionRefused(admission);
  return runRelease(journal, ports);
}

export async function drillWithdrawal(
  candidate: ReleaseTarget,
  previous: ReleaseTarget,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  const staged = await stageCandidate(candidate, previous, ports);
  const failing: ReleasePorts = {
    ...ports,
    async verifyCandidate(target): Promise<void> {
      await ports.verifyCandidate(target);
      throw new InjectedProbeFailure();
    },
  };
  let unexpected: ReleaseJournal;
  try {
    unexpected = await verifyStagedCandidate(staged, failing);
  } catch (error) {
    if (
      !(error instanceof CandidateWithdrawn) ||
      !(error.cause instanceof InjectedProbeFailure)
    )
      throw error;
    const deployed = await ports.deployed();
    if (
      error.journal.phase !== "withdrawn" ||
      deployed.current.versionId !== previous.versionId ||
      deployed.candidate !== null ||
      verifiedPredecessor(error.journal)?.versionId !== previous.versionId
    )
      throw new Error(
        "The drill changed the serving version or the verified predecessor",
        { cause: error },
      );
    return error.journal;
  }
  await withdrawCandidate(unexpected, ports);
  throw new Error("The drill didn't observe its injected probe failure");
}
