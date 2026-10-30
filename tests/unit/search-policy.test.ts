import { describe, expect, it } from "vitest";
import {
  boundedLimit,
  canFetchNext,
  compatibleRegion,
  cursorDecision,
  storesSearch,
  totalSource,
} from "../../src/core/search-policy.ts";
import { searchCacheKey } from "../../src/server/search-cache.ts";

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
  it("uses a catalog total only for an exact single-dimension scope", () => {
    for (const queried of [false, true])
      for (const prefecture of [false, true])
        for (const municipality of [false, true])
          for (const category of [false, true]) {
            const scoped = !queried && !municipality;
            expect(
              totalSource(queried, prefecture, municipality, category),
            ).toBe(
              scoped && !prefecture && !category
                ? "directory"
                : scoped && prefecture && !category
                  ? "prefecture"
                  : scoped && !prefecture && category
                    ? "category"
                    : "counted",
            );
          }
  });
  it("stores only successful search responses under a complete dataset key", () => {
    for (let status = 100; status < 600; status += 1)
      expect(storesSearch(status)).toBe(status === 200);
    const digest = "a".repeat(64);
    const version = "11111111-1111-4111-8111-111111111111";
    expect(
      searchCacheKey(
        new Request("https://www.dial.page/api/contacts?q=x"),
        digest,
        version,
      )?.url,
    ).toBe(`https://www.dial.page/${version}/${digest}/api/contacts?q=x`);
    expect(
      searchCacheKey(
        new Request("https://www.dial.page/api/v1/contact-groups", {
          method: "HEAD",
        }),
        digest,
        version,
      )?.method,
    ).toBe("GET");
    for (const [url, method, key, worker] of [
      ["https://www.dial.page/api/contacts", "POST", digest, version],
      ["https://www.dial.page/api/catalog", "GET", digest, version],
      ["https://www.dial.page/api/contacts.vcf", "GET", digest, version],
      ["https://www.dial.page/api/contacts", "GET", "", version],
      ["https://www.dial.page/api/contacts", "GET", "A".repeat(64), version],
      ["https://www.dial.page/api/contacts", "GET", undefined, version],
      ["https://www.dial.page/api/contacts", "GET", digest, ""],
      ["https://www.dial.page/api/contacts", "GET", digest, undefined],
    ] as const)
      expect(
        searchCacheKey(new Request(url, { method }), key, worker),
      ).toBeNull();
  });
});
