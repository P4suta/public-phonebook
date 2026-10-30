export function schoolEvidence(
  namePresent: boolean,
  nameMatches: boolean,
  exactName: boolean,
  addressPresent: boolean,
  addressMatches: boolean,
  postalMatches: boolean,
  explicitCode: boolean,
): boolean {
  //@ verify
  //@ ensures \result === (namePresent && nameMatches && (postalMatches || (addressPresent ? addressMatches : exactName || explicitCode)))
  return (
    namePresent &&
    nameMatches &&
    (postalMatches ||
      (addressPresent ? addressMatches : exactName || explicitCode))
  );
}

export function singleCandidate(count: number): boolean {
  //@ verify
  //@ requires count >= 0 && count <= 4294967295
  //@ ensures \result === (count === 1)
  return count === 1;
}

export function sourceRowsAccounted(
  rows: number,
  accepted: number,
  missing: number,
  invalid: number,
  duplicate: number,
  excluded: number,
): boolean {
  //@ verify
  //@ requires rows >= 0 && rows <= 1000000000
  //@ requires accepted >= 0 && accepted <= 1000000000
  //@ requires missing >= 0 && missing <= 1000000000
  //@ requires invalid >= 0 && invalid <= 1000000000
  //@ requires duplicate >= 0 && duplicate <= 1000000000
  //@ requires excluded >= 0 && excluded <= 1000000000
  //@ ensures \result === (rows === accepted + missing + invalid + duplicate + excluded)
  return rows === accepted + missing + invalid + duplicate + excluded;
}
