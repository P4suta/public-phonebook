import {
  bootstrapAdmission,
  recoveryDecision,
} from "../src/core/publication-policy.ts";

export interface ReleaseTarget {
  readonly releaseId: string;
  readonly versionId: string;
  readonly sourceTree: string | null;
  readonly snapshot: string;
  readonly databaseSha256: string;
  readonly databaseId: string;
  readonly manifestSha256: string;
  readonly artifactSha256: string | null;
  readonly bundle: string;
  readonly manifestBinding: "snapshot" | "digest";
}
export type ReleasePhase =
  | "preparing"
  | "activating"
  | "checking"
  | "recovering"
  | "verified"
  | "recovered";
export interface ReleaseJournal {
  readonly phase: ReleasePhase;
  readonly candidate: ReleaseTarget;
  readonly previous: ReleaseTarget | null;
}
export interface ActiveVersion {
  readonly versionId: string;
  readonly releaseId: string;
}
export interface ReleasePorts {
  save(journal: ReleaseJournal): Promise<void>;
  prepare(candidate: ReleaseTarget): Promise<void>;
  active(): Promise<ActiveVersion>;
  activate(candidate: ReleaseTarget): Promise<void>;
  restore(previous: ReleaseTarget): Promise<void>;
  verify(target: ReleaseTarget): Promise<void>;
}

async function requireActive(
  target: ReleaseTarget,
  ports: ReleasePorts,
): Promise<void> {
  if ((await ports.active()).versionId !== target.versionId)
    throw new Error("The active Worker changed during publication");
}

export async function recoverRelease(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  const pending: ReleaseJournal = { ...journal, phase: "recovering" };
  await ports.save(pending);
  const active = await ports.active();
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
  await requireActive(journal.previous, ports);
  await ports.verify(journal.previous);
  await requireActive(journal.previous, ports);
  const result: ReleaseJournal = { ...pending, phase: "recovered" };
  await ports.save(result);
  return result;
}

export async function resumeBootstrap(
  journal: ReleaseJournal,
  ports: ReleasePorts,
): Promise<ReleaseJournal> {
  const active = await ports.active();
  if (
    !bootstrapAdmission(
      journal.previous !== null,
      journal.phase === "verified" || journal.phase === "recovered",
      active.releaseId === journal.candidate.releaseId,
      journal.candidate.versionId === "" ||
        active.versionId === journal.candidate.versionId,
    )
  )
    throw new Error(
      "Only the owned active initial staging candidate can resume verification",
    );
  const checking: ReleaseJournal = {
    ...journal,
    candidate: { ...journal.candidate, versionId: active.versionId },
    phase: "checking",
  };
  await ports.save(checking);
  await ports.verify(checking.candidate);
  await requireActive(checking.candidate, ports);
  const verified: ReleaseJournal = { ...checking, phase: "verified" };
  await ports.save(verified);
  return verified;
}

export async function runRelease(
  candidate: ReleaseTarget,
  previous: ReleaseTarget | null,
  ports: ReleasePorts,
  bootstrap = false,
): Promise<ReleaseJournal> {
  if (!previous && !bootstrap)
    throw new Error("Publication requires a verified predecessor");
  let journal: ReleaseJournal = { candidate, previous, phase: "preparing" };
  await ports.save(journal);
  try {
    if (previous) await requireActive(previous, ports);
    await ports.prepare(candidate);
    if (previous) await requireActive(previous, ports);
    journal = { ...journal, phase: "activating" };
    await ports.save(journal);
    await ports.activate(candidate);
    const active = await ports.active();
    if (active.releaseId !== candidate.releaseId)
      throw new Error("The deployment does not belong to this candidate");
    journal = {
      ...journal,
      candidate: { ...candidate, versionId: active.versionId },
      phase: "checking",
    };
    await ports.save(journal);
    await ports.verify(journal.candidate);
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
