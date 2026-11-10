// A delta is published only when its Brotli bytes are at most half of the complete archive's.
const deltaBudgetNumerator = 1;
const deltaBudgetDenominator = 2;
// Preparation starts deltas from the 12 most recently published snapshots, besides every shipped one.
const publishedDeltaBases = 12;

/** Keeps a shipped snapshot as a delta base always, and a published one while fewer than 12 newer published snapshots precede it. */
export function deltaBaseRetained(
  shipped: boolean,
  newerPublished: number,
): boolean {
  //@ verify
  //@ requires newerPublished >= 0
  //@ ensures \result === (shipped || newerPublished < 12)
  //@ ensures shipped ==> \result
  //@ ensures newerPublished >= 12 ==> \result === shipped
  return shipped || newerPublished < publishedDeltaBases;
}

export function deltaPublication(
  deltaBytes: number,
  completeBytes: number,
): boolean {
  //@ verify
  //@ requires deltaBytes >= 1 && completeBytes >= 0
  //@ ensures \result === (deltaBytes * 2 <= completeBytes)
  //@ ensures \result ==> deltaBytes < completeBytes
  return (
    deltaBytes * deltaBudgetDenominator <= completeBytes * deltaBudgetNumerator
  );
}

export function copyAdmission(
  start: number,
  count: number,
  baseRows: number,
): boolean {
  //@ verify
  //@ ensures \result === (start >= 0 && count >= 1 && start + count <= baseRows)
  //@ ensures \result ==> 0 <= start && start < baseRows
  //@ ensures \result ==> start + count - 1 < baseRows
  return start >= 0 && count >= 1 && start + count <= baseRows;
}

export type DeltaAdmission =
  | "apply"
  | "base_mismatch"
  | "malformed"
  | "count_mismatch"
  | "length_mismatch"
  | "digest_mismatch";

export function deltaAdmission(
  baseMatches: boolean,
  wellFormed: boolean,
  rows: number,
  expectedRows: number,
  bytes: number,
  expectedBytes: number,
  digestMatches: boolean,
): DeltaAdmission {
  //@ verify
  //@ ensures (\result === "apply") === (baseMatches && wellFormed && rows === expectedRows && bytes === expectedBytes && digestMatches)
  //@ ensures (\result === "base_mismatch") === !baseMatches
  //@ ensures (\result === "malformed") === (baseMatches && !wellFormed)
  //@ ensures (\result === "count_mismatch") === (baseMatches && wellFormed && rows !== expectedRows)
  //@ ensures (\result === "length_mismatch") === (baseMatches && wellFormed && rows === expectedRows && bytes !== expectedBytes)
  //@ ensures (\result === "digest_mismatch") === (baseMatches && wellFormed && rows === expectedRows && bytes === expectedBytes && !digestMatches)
  if (!baseMatches) return "base_mismatch";
  if (!wellFormed) return "malformed";
  if (rows !== expectedRows) return "count_mismatch";
  if (bytes !== expectedBytes) return "length_mismatch";
  if (!digestMatches) return "digest_mismatch";
  return "apply";
}
