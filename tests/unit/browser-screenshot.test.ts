import { describe, expect, it } from "vitest";
import { matchesViewportFrame } from "../browser/full-page-screenshot.ts";

describe("native viewport frames", () => {
  it("accepts CSS and device-pixel metadata for the same viewport", () => {
    for (const scale of [1, 2, 3]) {
      expect(
        matchesViewportFrame(
          { width: 322, height: 900 },
          322 * scale,
          900 * scale,
        ),
      ).toBe(true);
    }
  });

  it("rejects stale frames from either side of the viewport resize", () => {
    for (const scale of [1, 2, 3]) {
      expect(
        matchesViewportFrame(
          { width: 322, height: 900 },
          320 * scale,
          900 * scale,
        ),
      ).toBe(false);
      expect(
        matchesViewportFrame(
          { width: 320, height: 900 },
          322 * scale,
          900 * scale,
        ),
      ).toBe(false);
    }
  });

  it("rejects missing and invalid frame dimensions", () => {
    for (const [width, height] of [
      [0, 0],
      [320, 0],
      [0, 900],
      [-320, -900],
      [Number.NaN, 900],
    ]) {
      expect(
        matchesViewportFrame(
          { width: 320, height: 900 },
          width ?? 0,
          height ?? 0,
        ),
      ).toBe(false);
    }
  });
});
