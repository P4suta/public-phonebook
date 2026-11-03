import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mapSearchUrl, mapUrlLimit } from "../../src/core/map-link.ts";

const prefix = "https://www.google.com/maps/search/?api=1&query=";

function query(url: string): string {
  return decodeURIComponent(url.slice(prefix.length));
}

describe("map search link", () => {
  it("searches by the facility name and address in the guide's recommended form", () => {
    expect(mapSearchUrl("高知大学", "高知県高知市曙町2丁目5-1")).toBe(
      `${prefix}${encodeURIComponent("高知大学,高知県高知市曙町2丁目5-1")}`,
    );
    expect(mapSearchUrl("City Hall", "New York, NY")).toBe(
      `${prefix}City%20Hall%2CNew%20York%2C%20NY`,
    );
  });

  it("prefers the name, falls back to the address, and never exceeds the URL limit", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 300, unit: "binary" }),
        fc.string({ minLength: 1, maxLength: 600, unit: "binary" }),
        (name, address) => {
          const url = mapSearchUrl(name, address);
          const named = `${prefix}${encodeURIComponent(`${name},${address}`)}`;
          const bare = `${prefix}${encodeURIComponent(address)}`;
          if (named.length <= mapUrlLimit) expect(url).toBe(named);
          else if (bare.length <= mapUrlLimit) expect(url).toBe(bare);
          else expect(url).toBeNull();
          if (url !== null) {
            expect(url.length).toBeLessThanOrEqual(mapUrlLimit);
            expect([`${name},${address}`, address]).toContain(query(url));
          }
        },
      ),
      { seed: 20261103, numRuns: 500 },
    );
  });
});
