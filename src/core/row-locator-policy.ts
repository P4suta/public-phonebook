export type RowLocatorDecision =
  | "located"
  | "invalid_query"
  | "snapshot_changed"
  | "not_found";

export function rowLocatorDecision(
  wellFormed: boolean,
  current: boolean,
  row: number,
  contacts: number,
): RowLocatorDecision {
  //@ verify
  //@ ensures (\result === "invalid_query") === (!wellFormed || row < 0)
  //@ ensures (\result === "snapshot_changed") === (wellFormed && row >= 0 && !current)
  //@ ensures (\result === "not_found") === (wellFormed && row >= 0 && current && row >= contacts)
  //@ ensures (\result === "located") === (wellFormed && row >= 0 && current && row < contacts)
  //@ ensures \result === "located" ==> 1 <= row + 1 && row + 1 <= contacts
  if (!wellFormed || row < 0) return "invalid_query";
  if (!current) return "snapshot_changed";
  if (row >= contacts) return "not_found";
  return "located";
}
