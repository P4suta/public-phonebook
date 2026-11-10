import {
  type ListingReply,
  listingReply,
  type SnapshotAdmission,
} from "@public-phonebook/directory/snapshot-policy";
import { describe, expect, it } from "vitest";

const admissions: readonly SnapshotAdmission[] = [
  "accepted",
  "invalid_query",
  "snapshot_changed",
];

/** States the reply table directly, so the decision is checked against an independent statement of the contract. */
function expectedReply(
  admission: SnapshotAdmission,
  prepared: boolean,
  validatorMatches: boolean,
): ListingReply {
  if (admission !== "accepted") return admission;
  if (!prepared) return "unavailable";
  return validatorMatches ? "not_modified" : "listing";
}

describe("listing reply", () => {
  it("matches the reply table over every admission, manifest, and validator", () => {
    const seen = new Set<ListingReply>();
    for (const admission of admissions)
      for (const prepared of [false, true])
        for (const validatorMatches of [false, true]) {
          const reply = listingReply(admission, prepared, validatorMatches);
          expect(reply, `${admission} ${prepared} ${validatorMatches}`).toBe(
            expectedReply(admission, prepared, validatorMatches),
          );
          seen.add(reply);
        }
    expect(seen.size).toBe(5);
  });

  it("keeps a stale or malformed pin's failure when the validator matches", () => {
    expect(listingReply("snapshot_changed", true, true)).toBe(
      "snapshot_changed",
    );
    expect(listingReply("invalid_query", true, true)).toBe("invalid_query");
  });
});
