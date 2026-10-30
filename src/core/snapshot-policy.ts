export type SnapshotAdmission =
  | "accepted"
  | "invalid_query"
  | "snapshot_changed";

export function snapshotAdmission(
  supplied: boolean,
  unambiguous: boolean,
  wellFormed: boolean,
  matches: boolean,
): SnapshotAdmission {
  //@ verify
  //@ ensures (\result === "accepted") === (unambiguous && wellFormed && (!supplied || matches))
  //@ ensures (\result === "invalid_query") === (!unambiguous || !wellFormed)
  //@ ensures (\result === "snapshot_changed") === (unambiguous && wellFormed && supplied && !matches)
  if (!unambiguous || !wellFormed) return "invalid_query";
  if (supplied && !matches) return "snapshot_changed";
  return "accepted";
}
