import { describe, expect, it } from "vitest";
import {
  fitsSitePage,
  siteRequestAdmission,
} from "../../src/core/site-request-policy.ts";

describe("site request decisions", () => {
  it("exhausts the site admission decision domain", () => {
    for (const siteRoute of [false, true])
      for (const metadataPresent of [false, true])
        for (const sameOrigin of [false, true]) {
          const result = siteRequestAdmission(
            siteRoute,
            metadataPresent,
            sameOrigin,
          );
          expect(result === "admitted").toBe(
            !siteRoute || !metadataPresent || sameOrigin,
          );
          expect(result === "cross_origin").toBe(
            siteRoute && metadataPresent && !sameOrigin,
          );
        }
  });

  it("admits only the page sizes the site requests", () => {
    for (let limit = -2; limit < 104; limit += 1)
      expect(fitsSitePage(limit), String(limit)).toBe(
        limit >= 1 && limit <= 30,
      );
  });
});
