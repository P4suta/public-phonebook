import { expect, it } from "vitest";
import { confirmsNavigation } from "../../src/core/navigation-policy.ts";

it("confirms only a plain primary activation of a new-tab link to another site", () => {
  const flags = [false, true] as const;
  for (const newTab of flags)
    for (const otherSite of flags)
      for (const primaryButton of flags)
        for (const modified of flags)
          for (const prevented of flags)
            expect(
              confirmsNavigation(
                newTab,
                otherSite,
                primaryButton,
                modified,
                prevented,
              ),
            ).toBe(
              newTab && otherSite && primaryButton && !modified && !prevented,
            );
});
