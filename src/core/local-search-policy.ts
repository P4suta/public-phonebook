const unmatchedRank = -1;
const exactRank = 0;
const prefixRank = 1;
const substringRank = 2;
const continuationPage = 30;

export function nameRankAt(
  at: number,
  nameLength: number,
  queryLength: number,
): number {
  //@ verify
  //@ requires queryLength >= 1 && at >= -1
  //@ requires at === -1 || at + queryLength <= nameLength
  //@ ensures (\result === -1) === (at === -1)
  //@ ensures (\result === 0) === (at === 0 && nameLength === queryLength)
  //@ ensures (\result === 1) === (at === 0 && nameLength > queryLength)
  //@ ensures (\result === 2) === (at > 0)
  if (at < 0) return unmatchedRank;
  if (at > 0) return substringRank;
  return nameLength === queryLength ? exactRank : prefixRank;
}

export function groupPrecedes(
  rank: number,
  row: number,
  otherRank: number,
  otherRow: number,
): boolean {
  //@ verify
  //@ ensures \result === (rank < otherRank || (rank === otherRank && row < otherRow))
  //@ ensures \result ==> !(otherRank < rank || (otherRank === rank && otherRow < row))
  //@ ensures rank === otherRank && row === otherRow ==> !\result
  return rank < otherRank || (rank === otherRank && row < otherRow);
}

export type IndexReadiness = "loading" | "ready" | "unavailable";
export type SearchSource = "wait" | "local" | "server";

export function searchSource(
  queried: boolean,
  composing: boolean,
  index: IndexReadiness,
): SearchSource {
  //@ verify
  //@ ensures composing ==> \result === "wait"
  //@ ensures !queried ==> \result === "wait"
  //@ ensures (\result === "local") === (queried && !composing && index === "ready")
  //@ ensures (\result === "server") === (queried && !composing && index !== "ready")
  if (composing || !queried) return "wait";
  return index === "ready" ? "local" : "server";
}

export function nextVisible(visible: number, total: number): number {
  //@ verify
  //@ requires visible >= 0 && visible <= total
  //@ ensures \result >= visible && \result <= total
  //@ ensures \result === (visible + 30 < total ? visible + 30 : total)
  //@ ensures visible < total ==> \result > visible
  return visible + continuationPage < total
    ? visible + continuationPage
    : total;
}

export type IndexAdmission =
  | "admitted"
  | "length_mismatch"
  | "digest_mismatch"
  | "signature_mismatch"
  | "malformed"
  | "snapshot_mismatch";

export function indexAdmission(
  decodedBytes: number,
  expectedBytes: number,
  digestMatches: boolean,
  signatureMatches: boolean,
  wellFormed: boolean,
  snapshotMatches: boolean,
): IndexAdmission {
  //@ verify
  //@ ensures (\result === "admitted") === (decodedBytes === expectedBytes && digestMatches && signatureMatches && wellFormed && snapshotMatches)
  //@ ensures (\result === "length_mismatch") === (decodedBytes !== expectedBytes)
  //@ ensures (\result === "digest_mismatch") === (decodedBytes === expectedBytes && !digestMatches)
  //@ ensures (\result === "signature_mismatch") === (decodedBytes === expectedBytes && digestMatches && !signatureMatches)
  //@ ensures (\result === "malformed") === (decodedBytes === expectedBytes && digestMatches && signatureMatches && !wellFormed)
  //@ ensures (\result === "snapshot_mismatch") === (decodedBytes === expectedBytes && digestMatches && signatureMatches && wellFormed && !snapshotMatches)
  if (decodedBytes !== expectedBytes) return "length_mismatch";
  if (!digestMatches) return "digest_mismatch";
  if (!signatureMatches) return "signature_mismatch";
  if (!wellFormed) return "malformed";
  if (!snapshotMatches) return "snapshot_mismatch";
  return "admitted";
}
