const coverageScale = 10;
const coverageRetained = 9;

export type ImportDecision = "start" | "resume" | "conflict";

export function importDecision(
  current: string,
  requested: string,
): ImportDecision {
  //@ verify
  //@ ensures (\result === "start") === (current === "")
  //@ ensures (\result === "resume") === (current !== "" && current === requested)
  //@ ensures (\result === "conflict") === (current !== "" && current !== requested)
  if (current === "") return "start";
  if (current === requested) return "resume";
  return "conflict";
}

export function canPromote(
  candidate: string,
  checkedCandidate: string,
  snapshot: string,
  checkedSnapshot: string,
  stagingPassed: boolean,
  database: string,
  checkedDatabase: string,
  manifest: string,
  checkedManifest: string,
): boolean {
  //@ verify
  //@ ensures \result === (stagingPassed && candidate === checkedCandidate && snapshot === checkedSnapshot && database === checkedDatabase && manifest === checkedManifest)
  return (
    stagingPassed &&
    candidate === checkedCandidate &&
    snapshot === checkedSnapshot &&
    database === checkedDatabase &&
    manifest === checkedManifest
  );
}

export type RecoveryDecision =
  | "already-previous"
  | "restore-previous"
  | "refuse";

export function recoveryDecision(
  previousPresent: boolean,
  activeIsPrevious: boolean,
  activeIsCandidate: boolean,
): RecoveryDecision {
  //@ verify
  //@ ensures (\result === "already-previous") === (previousPresent && activeIsPrevious)
  //@ ensures (\result === "restore-previous") === (previousPresent && !activeIsPrevious && activeIsCandidate)
  //@ ensures (\result === "refuse") === (!previousPresent || (!activeIsPrevious && !activeIsCandidate))
  if (!previousPresent) return "refuse";
  if (activeIsPrevious) return "already-previous";
  if (activeIsCandidate) return "restore-previous";
  return "refuse";
}

export function canRetireResource(
  owned: boolean,
  active: boolean,
  rollback: boolean,
  pending: boolean,
): boolean {
  //@ verify
  //@ ensures \result === (owned && !active && !rollback && !pending)
  return owned && !active && !rollback && !pending;
}

export function retainsCoverage(candidate: number, previous: number): boolean {
  //@ verify
  //@ requires candidate >= 0 && candidate <= 10000000
  //@ requires previous >= 0 && previous <= 10000000
  //@ ensures \result === (candidate * 10 >= previous * 9)
  return candidate * coverageScale >= previous * coverageRetained;
}

export function bootstrapAdmission(
  previousPresent: boolean,
  terminal: boolean,
  owned: boolean,
  versionMatches: boolean,
): boolean {
  //@ verify
  //@ ensures \result === (!previousPresent && !terminal && owned && versionMatches)
  return !previousPresent && !terminal && owned && versionMatches;
}
