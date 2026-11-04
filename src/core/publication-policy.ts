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

export type DatabaseVerification =
  | "verify"
  | "accept-evidence"
  | "accept-publication"
  | "foreign-evidence"
  | "incomplete-database"
  | "unverified-binding";

/** Scans a remote database in full only while no Worker version binds it, and otherwise requires evidence of an earlier full verification of this exact import identity and resource. */
export function databaseVerification(
  evidencePresent: boolean,
  evidenceIdentity: string,
  identity: string,
  evidenceResource: string,
  resource: string,
  complete: boolean,
  bound: boolean,
  publicationVerified: boolean,
): DatabaseVerification {
  //@ verify
  //@ ensures \result === "verify" ==> !bound
  //@ ensures (\result === "foreign-evidence") === (evidencePresent && (evidenceIdentity !== identity || evidenceResource !== resource))
  //@ ensures (\result === "accept-evidence") === (evidencePresent && evidenceIdentity === identity && evidenceResource === resource && complete)
  //@ ensures (\result === "incomplete-database") === (!complete && ((evidencePresent && evidenceIdentity === identity && evidenceResource === resource) || (!evidencePresent && bound)))
  //@ ensures (\result === "verify") === (!evidencePresent && !bound)
  //@ ensures (\result === "unverified-binding") === (!evidencePresent && bound && complete && !publicationVerified)
  //@ ensures (\result === "accept-publication") === (!evidencePresent && bound && complete && publicationVerified)
  if (
    evidencePresent &&
    (evidenceIdentity !== identity || evidenceResource !== resource)
  )
    return "foreign-evidence";
  if (evidencePresent)
    return complete ? "accept-evidence" : "incomplete-database";
  if (!bound) return "verify";
  if (!complete) return "incomplete-database";
  return publicationVerified ? "accept-publication" : "unverified-binding";
}

export type TargetBinding = "unrelated" | "binds" | "vouches";

/** A deployable release target binds exactly the D1 database its Worker version holds by ID, whatever its dataset, and vouches for that database only after the release tools prepared and staged it for the same dataset. */
export function targetBinding(
  sameDatabase: boolean,
  sameDataset: boolean,
  prepared: boolean,
  digestBound: boolean,
): TargetBinding {
  //@ verify
  //@ ensures (\result === "unrelated") === !sameDatabase
  //@ ensures (\result === "vouches") === (sameDatabase && sameDataset && prepared && digestBound)
  if (!sameDatabase) return "unrelated";
  return sameDataset && prepared && digestBound ? "vouches" : "binds";
}

export type PromotionAdmission =
  | "promote"
  | "unverified"
  | "current-changed"
  | "candidate-missing"
  | "different-version";

export function promotionAdmission(
  verified: boolean,
  verifiedVersion: string,
  candidatePresent: boolean,
  deployedCandidate: string,
  previousVersion: string,
  currentVersion: string,
): PromotionAdmission {
  //@ verify
  //@ ensures (\result === "unverified") === !verified
  //@ ensures (\result === "current-changed") === (verified && currentVersion !== previousVersion)
  //@ ensures (\result === "candidate-missing") === (verified && currentVersion === previousVersion && !candidatePresent)
  //@ ensures (\result === "different-version") === (verified && currentVersion === previousVersion && candidatePresent && deployedCandidate !== verifiedVersion)
  //@ ensures (\result === "promote") === (verified && currentVersion === previousVersion && candidatePresent && deployedCandidate === verifiedVersion)
  if (!verified) return "unverified";
  if (currentVersion !== previousVersion) return "current-changed";
  if (!candidatePresent) return "candidate-missing";
  if (deployedCandidate !== verifiedVersion) return "different-version";
  return "promote";
}

export type WithdrawalDecision =
  | "remove-candidate"
  | "already-withdrawn"
  | "refuse";

export function withdrawalDecision(
  beforeTraffic: boolean,
  currentIsPrevious: boolean,
  candidatePresent: boolean,
  candidateOwned: boolean,
): WithdrawalDecision {
  //@ verify
  //@ ensures (\result === "remove-candidate") === (beforeTraffic && currentIsPrevious && candidatePresent && candidateOwned)
  //@ ensures (\result === "already-withdrawn") === (beforeTraffic && currentIsPrevious && !candidatePresent)
  //@ ensures (\result === "refuse") === (!beforeTraffic || !currentIsPrevious || (candidatePresent && !candidateOwned))
  if (!beforeTraffic || !currentIsPrevious) return "refuse";
  if (!candidatePresent) return "already-withdrawn";
  return candidateOwned ? "remove-candidate" : "refuse";
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

/** How long a refused public check request waits for the oldest request in its window to age out; the checks' timeouts rely on this bound. */
export function probeHold(
  oldestMs: number,
  nowMs: number,
  windowMs: number,
): number {
  //@ verify
  //@ requires windowMs > 0 && windowMs <= 3600000
  //@ requires nowMs >= 0 && nowMs <= 9007199254740991
  //@ requires oldestMs > nowMs - windowMs && oldestMs <= nowMs
  //@ ensures \result > 0 && \result <= windowMs
  return oldestMs + windowMs - nowMs;
}

export type LeaseAdmission =
  | "acquire"
  | "renew"
  | "takeover"
  | "refuse"
  | "lost";

export function leaseAdmission(
  present: boolean,
  held: boolean,
  serverTimeMs: number,
  expiresAtMs: number,
): LeaseAdmission {
  //@ verify
  //@ requires serverTimeMs >= 0 && serverTimeMs <= 9007199254740991
  //@ requires expiresAtMs >= 0 && expiresAtMs <= 9007199254740991
  //@ ensures (\result === "acquire") === !present
  //@ ensures (\result === "renew") === (present && held && serverTimeMs < expiresAtMs)
  //@ ensures (\result === "takeover") === (present && !held && serverTimeMs >= expiresAtMs)
  //@ ensures (\result === "refuse") === (present && !held && serverTimeMs < expiresAtMs)
  //@ ensures (\result === "lost") === (present && held && serverTimeMs >= expiresAtMs)
  if (!present) return "acquire";
  if (serverTimeMs >= expiresAtMs) return held ? "lost" : "takeover";
  return held ? "renew" : "refuse";
}

export type EvidenceAdmission =
  | "admit"
  | "missing-stage"
  | "stale-inputs"
  | "different-manifest"
  | "different-signer"
  | "failed-stage";

/** Admits a stage's evidence only for the exact digest of the files it reads, its dataset, an accepted signer, and a pass. */
export function evidenceAdmission(
  present: boolean,
  inputs: string,
  expectedInputs: string,
  manifest: string,
  expectedManifest: string,
  signer: string,
  expectedSigner: string,
  passed: boolean,
): EvidenceAdmission {
  //@ verify
  //@ ensures (\result === "missing-stage") === !present
  //@ ensures (\result === "stale-inputs") === (present && inputs !== expectedInputs)
  //@ ensures (\result === "different-manifest") === (present && inputs === expectedInputs && manifest !== expectedManifest)
  //@ ensures (\result === "different-signer") === (present && inputs === expectedInputs && manifest === expectedManifest && signer !== expectedSigner)
  //@ ensures (\result === "failed-stage") === (present && inputs === expectedInputs && manifest === expectedManifest && signer === expectedSigner && !passed)
  //@ ensures (\result === "admit") === (present && inputs === expectedInputs && manifest === expectedManifest && signer === expectedSigner && passed)
  if (!present) return "missing-stage";
  if (inputs !== expectedInputs) return "stale-inputs";
  if (manifest !== expectedManifest) return "different-manifest";
  if (signer !== expectedSigner) return "different-signer";
  if (!passed) return "failed-stage";
  return "admit";
}

export type ReleasePreflight =
  | "dirty-tree"
  | "not-release-head"
  | "different-dataset"
  | "run-stages"
  | "dispatch";

/** Dispatches a release only from a clean checkout of the release branch head, for the bundle's own dataset, once no candidate stage lacks a local pass. */
export function releasePreflight(
  clean: boolean,
  head: string,
  releaseHead: string,
  bundleManifest: string,
  dataset: string,
  missingStages: number,
): ReleasePreflight {
  //@ verify
  //@ requires missingStages >= 0
  //@ ensures (\result === "dirty-tree") === !clean
  //@ ensures (\result === "not-release-head") === (clean && head !== releaseHead)
  //@ ensures (\result === "different-dataset") === (clean && head === releaseHead && bundleManifest !== dataset)
  //@ ensures (\result === "run-stages") === (clean && head === releaseHead && bundleManifest === dataset && missingStages > 0)
  //@ ensures (\result === "dispatch") === (clean && head === releaseHead && bundleManifest === dataset && missingStages === 0)
  if (!clean) return "dirty-tree";
  if (head !== releaseHead) return "not-release-head";
  if (bundleManifest !== dataset) return "different-dataset";
  if (missingStages > 0) return "run-stages";
  return "dispatch";
}
