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

export type ListingReply =
  | "invalid_query"
  | "snapshot_changed"
  | "unavailable"
  | "not_modified"
  | "listing";

/** Decides a listing reply, so a stale or malformed pin keeps its failure even when the client's validator matches. */
export function listingReply(
  admission: SnapshotAdmission,
  prepared: boolean,
  validatorMatches: boolean,
): ListingReply {
  //@ verify
  //@ ensures (\result === "invalid_query") === (admission === "invalid_query")
  //@ ensures (\result === "snapshot_changed") === (admission === "snapshot_changed")
  //@ ensures (\result === "unavailable") === (admission === "accepted" && !prepared)
  //@ ensures (\result === "not_modified") === (admission === "accepted" && prepared && validatorMatches)
  //@ ensures (\result === "listing") === (admission === "accepted" && prepared && !validatorMatches)
  if (admission === "invalid_query") return "invalid_query";
  if (admission === "snapshot_changed") return "snapshot_changed";
  if (!prepared) return "unavailable";
  return validatorMatches ? "not_modified" : "listing";
}
