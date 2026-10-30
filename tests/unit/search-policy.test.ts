import { describe, expect, it } from "vitest";
import {
  boundedLimit,
  canFetchNext,
  compatibleRegion,
  cursorDecision,
} from "../../src/core/search-policy.ts";

describe("directory decisions", () => {
  it("only continues a ready feed with another page", () => {
    for (const more of [false, true])
      for (const pending of [false, true])
        for (const failed of [false, true]) {
          expect(canFetchNext(more, pending, failed)).toBe(
            more && !pending && !failed,
          );
        }
  });
  it("rejects changed snapshots before cursor query mismatches", () => {
    expect(cursorDecision(false, false)).toBe("snapshot_changed");
    expect(cursorDecision(false, true)).toBe("snapshot_changed");
    expect(cursorDecision(true, false)).toBe("invalid_cursor");
    expect(cursorDecision(true, true)).toBe("accepted");
  });
  it("checks region relationships and finite response limits", () => {
    expect(compatibleRegion("13", "13101")).toBe(true);
    expect(compatibleRegion("13", "14101")).toBe(false);
    expect(compatibleRegion("", "13101")).toBe(true);
    expect(compatibleRegion("13", "")).toBe(true);
    for (let limit = -2; limit < 104; limit += 1)
      expect(boundedLimit(limit)).toBe(limit >= 1 && limit <= 100);
  });
});
