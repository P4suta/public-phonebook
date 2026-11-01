import { describe, expect, it } from "vitest";
import { rowLocatorDecision } from "../../src/core/row-locator-policy.ts";

const contactCounts = [0, 1, 3];
const rows = [-2, -1, 0, 1, 2, 3, 4];

describe("row locator decision", () => {
  it("exhausts validation, snapshot identity, and range over small directories", () => {
    for (const wellFormed of [false, true])
      for (const current of [false, true])
        for (const contacts of contactCounts)
          for (const row of rows) {
            const result = rowLocatorDecision(
              wellFormed,
              current,
              row,
              contacts,
            );
            const admitted = wellFormed && row >= 0;
            expect(result === "invalid_query").toBe(!admitted);
            expect(result === "snapshot_changed").toBe(admitted && !current);
            expect(result === "not_found").toBe(
              admitted && current && row >= contacts,
            );
            expect(result === "located").toBe(
              admitted && current && row < contacts,
            );
            if (result === "located") {
              expect(row + 1).toBeGreaterThanOrEqual(1);
              expect(row + 1).toBeLessThanOrEqual(contacts);
            }
          }
  });

  it("reports a stale snapshot before a row that the current snapshot lacks", () => {
    expect(rowLocatorDecision(true, false, 10, 3)).toBe("snapshot_changed");
    expect(rowLocatorDecision(false, false, 10, 3)).toBe("invalid_query");
    expect(rowLocatorDecision(true, true, 3, 3)).toBe("not_found");
    expect(rowLocatorDecision(true, true, 2, 3)).toBe("located");
  });
});
