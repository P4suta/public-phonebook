import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { expect, it } from "vitest";
import { foundation } from "../../src/ui/foundations.ts";

it("keeps the implemented hierarchy aligned with the retained Figma specification", async () => {
  const raw: unknown = JSON.parse(
    await readFile("docs/design-system.json", "utf8"),
  );
  const spec = v.parse(
    v.object({
      roles: v.record(
        v.string(),
        v.object({
          size: v.number(),
          lineHeight: v.number(),
          weight: v.number(),
        }),
      ),
      variables: v.array(
        v.object({
          name: v.string(),
          scopes: v.array(v.string()),
          syntax: v.string(),
        }),
      ),
    }),
    raw,
  );
  expect(Object.keys(spec.roles).sort()).toEqual(
    Object.keys(foundation.font).sort(),
  );
  for (const [role, type] of Object.entries(foundation.font)) {
    expect(spec.roles[role], role).toEqual(type);
    expect(type.size, role).toBeGreaterThanOrEqual(14);
    expect(type.size, role).toBeLessThanOrEqual(32);
    expect(type.lineHeight / type.size, role).toBeGreaterThanOrEqual(1.25);
  }
  expect(
    foundation.font.phone.size / foundation.font.facility.size,
  ).toBeLessThanOrEqual(1.6);
  expect(foundation.control.height).toBeGreaterThanOrEqual(44);
  expect(new Set(spec.variables.map((variable) => variable.name)).size).toBe(
    spec.variables.length,
  );
  for (const variable of spec.variables) {
    expect(variable.scopes, variable.name).not.toContain("ALL_SCOPES");
    expect(variable.syntax, variable.name).toBe(
      `var(--dial-${variable.name.replaceAll("/", "-")})`,
    );
  }
});
