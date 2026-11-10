import { existingChecks, planLines } from "@public-phonebook/cloudflare/uptime";
import {
  checkAction,
  type ExistingCheck,
  type UptimeCheck,
  type UptimePlan,
  uptimeChecks,
  uptimeFields,
  uptimePlan,
} from "@public-phonebook/cloudflare/uptime-plan";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = "https://incidents.betterstack.com/api/v2/monitors";

function existing(id: string, check: UptimeCheck): ExistingCheck {
  return { id, attributes: { ...check } };
}

function planViolations(
  declared: readonly UptimeCheck[],
  current: readonly ExistingCheck[],
  plan: UptimePlan,
): string[] {
  const violations: string[] = [];
  const declaredNames = new Set(
    declared.map((check) => check.pronounceable_name),
  );
  const managedIds = new Set(
    current
      .filter((check) => declaredNames.has(check.attributes.pronounceable_name))
      .map((check) => check.id),
  );
  if (plan.checks.length !== declared.length)
    violations.push("the plan doesn't hold one entry per declared check");
  for (const [index, planned] of plan.checks.entries()) {
    if (planned.check !== declared[index])
      violations.push(`entry ${index} plans another check`);
    if (planned.action === "create") {
      if (
        current.some(
          (check) =>
            check.attributes.pronounceable_name ===
            planned.check.pronounceable_name,
        )
      )
        violations.push(`entry ${index} creates a duplicate`);
      continue;
    }
    if (!managedIds.has(planned.id))
      violations.push(`entry ${index} touches unmanaged check ${planned.id}`);
    const match = current.find((check) => check.id === planned.id);
    const equal = uptimeFields.every(
      (field) => match?.attributes[field] === planned.check[field],
    );
    if (equal !== (planned.action === "keep"))
      violations.push(
        `entry ${index} ${planned.action}s a check whose equality is ${equal}`,
      );
  }
  const unmanagedIds = current
    .filter((check) => !declaredNames.has(check.attributes.pronounceable_name))
    .map((check) => check.id);
  if (
    JSON.stringify(plan.unmanaged.map((check) => check.id)) !==
    JSON.stringify(unmanagedIds)
  )
    violations.push("the plan doesn't list every unmanaged check");
  return violations;
}

const checkArbitrary = fc.record({
  pronounceable_name: fc.constantFrom("a", "b", "c", "d", "e"),
  monitor_type: fc.constant("keyword" as const),
  url: fc.constantFrom(
    "https://www.dial.page/",
    "https://www.dial.page/api/datasets",
  ),
  required_keyword: fc.constantFrom("x", "y"),
  check_frequency: fc.constantFrom(180, 300),
  email: fc.boolean(),
});

const scenario = fc
  .uniqueArray(checkArbitrary, {
    selector: (check) => check.pronounceable_name,
    maxLength: 4,
  })
  .chain((declared) =>
    fc.tuple(
      fc.constant(declared),
      fc
        .uniqueArray(
          fc.oneof(
            checkArbitrary,
            ...(declared.length > 0 ? [fc.constantFrom(...declared)] : []),
          ),
          { selector: (check) => check.pronounceable_name, maxLength: 5 },
        )
        .map((checks) =>
          checks.map((check, index) => existing(`id-${index}`, check)),
        ),
    ),
  );

describe("uptime check plan", () => {
  it("decides the action for every combination of a match and equal settings", () => {
    const table = [
      { found: false, equal: false, action: "create" },
      { found: false, equal: true, action: "create" },
      { found: true, equal: false, action: "update" },
      { found: true, equal: true, action: "keep" },
    ] as const;
    for (const row of table)
      expect(checkAction(row.found, row.equal)).toBe(row.action);
  });

  it("declares three keyword checks of the public site every three minutes", () => {
    expect(uptimeChecks.map((check) => check.pronounceable_name)).toEqual([
      "Public Phonebook top page",
      "Public Phonebook search",
      "Public Phonebook app data index",
    ]);
    for (const check of uptimeChecks) {
      expect(new URL(check.url).origin).toBe("https://www.dial.page");
      expect(check.required_keyword.length).toBeGreaterThan(0);
      expect(check.check_frequency).toBe(180);
      expect(check.email).toBe(true);
    }
    expect(uptimeChecks[1]?.url).toBe(
      "https://www.dial.page/?q=%E6%9D%B1%E4%BA%AC%E9%83%BD%E5%BA%81",
    );
  });

  it("creates every check in an empty account and lists the sign-up check as unmanaged", () => {
    const signUp: ExistingCheck = {
      id: "5176200",
      attributes: {
        pronounceable_name: "dial.page",
        monitor_type: "status",
        url: "https://www.dial.page/",
        required_keyword: null,
        check_frequency: 180,
        email: true,
      },
    };
    const plan = uptimePlan(uptimeChecks, [signUp]);
    expect(plan.checks.map((planned) => planned.action)).toEqual([
      "create",
      "create",
      "create",
    ]);
    expect(plan.unmanaged).toEqual([{ id: "5176200", name: "dial.page" }]);
    expect(planLines(plan)).toEqual([
      "create  Public Phonebook top page",
      "create  Public Phonebook search",
      "create  Public Phonebook app data index",
      "unmanaged  dial.page (id 5176200); this command leaves it as it is",
    ]);
  });

  it("keeps equal checks and updates only the changed fields' checks", () => {
    const [top, search, index] = uptimeChecks;
    if (top === undefined || search === undefined || index === undefined)
      throw new Error("Expected three declared checks.");
    const plan = uptimePlan(uptimeChecks, [
      existing("1", top),
      existing("2", {
        ...search,
        required_keyword: "old",
        check_frequency: 300,
      }),
      existing("3", index),
    ]);
    expect(plan.checks.map((planned) => planned.action)).toEqual([
      "keep",
      "update",
      "keep",
    ]);
    expect(planLines(plan)[1]).toBe(
      "update  Public Phonebook search (required_keyword, check_frequency)",
    );
  });

  it("refuses duplicate names that would make the match ambiguous", () => {
    const [top] = uptimeChecks;
    if (top === undefined) throw new Error("Expected a declared check.");
    expect(() => uptimePlan([top, top], [])).toThrow(
      /declarations hold two checks/,
    );
    expect(() =>
      uptimePlan([top], [existing("1", top), existing("2", top)]),
    ).toThrow(/Better Stack hold two checks/);
  });

  it("touches only declared checks and leaves equal ones unchanged for any account", () => {
    fc.assert(
      fc.property(scenario, ([declared, current]) => {
        expect(
          planViolations(declared, current, uptimePlan(declared, current)),
        ).toEqual([]);
      }),
      { seed: 20261103, numRuns: 500 },
    );
  });

  it("detects a planted plan that updates an equal check or touches an unmanaged one", () => {
    const [top] = uptimeChecks;
    if (top === undefined) throw new Error("Expected a declared check.");
    const current = [
      existing("1", top),
      existing("9", { ...top, pronounceable_name: "dial.page" }),
    ];
    const plan = uptimePlan([top], current);
    const updatesEqual: UptimePlan = {
      ...plan,
      checks: [{ action: "update", id: "1", check: top, changed: [] }],
    };
    const touchesUnmanaged: UptimePlan = {
      ...plan,
      checks: [{ action: "keep", id: "9", check: top }],
    };
    expect(planViolations([top], current, plan)).toEqual([]);
    expect(planViolations([top], current, updatesEqual)).not.toEqual([]);
    expect(planViolations([top], current, touchesUnmanaged)).not.toEqual([]);
  });
});

describe("uptime check list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function page(next: string | null, ids: readonly string[]): Response {
    const [top] = uptimeChecks;
    if (top === undefined) throw new Error("Expected a declared check.");
    return Response.json({
      data: ids.map((id) => existing(id, { ...top, pronounceable_name: id })),
      pagination: { next },
    });
  }

  it("follows pagination within the monitors API", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return url === api ? page(`${api}?page=2`, ["a"]) : page(null, ["b"]);
    });
    const checks = await existingChecks("token");
    expect(checks.map((check) => check.id)).toEqual(["a", "b"]);
    expect(fetched).toEqual([api, `${api}?page=2`]);
  });

  it("refuses a pagination link to another host before sending the token there", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return page("https://example.com/api/v2/monitors?page=2", ["a"]);
    });
    await expect(existingChecks("token")).rejects.toThrow(
      /outside the monitors API/,
    );
    expect(fetched).toEqual([api]);
  });

  it("reports a refused token by its status alone", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 401 }));
    await expect(existingChecks("token")).rejects.toThrow(
      "Better Stack answered 401 to the check list.",
    );
  });
});
