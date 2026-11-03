import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Declaration,
  type DeclaredPlan,
  declaredPlan,
  planAction,
  type RemoteResource,
  sameValue,
} from "../../tools/declared-plan.ts";

interface Item {
  readonly name: string;
  readonly limit: number;
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

const declaration: Declaration<Item> = {
  name: (item) => item.name,
  fields: (item) => ({ limit: item.limit, filters: item.filters }),
  noun: "items",
  service: "The service",
};

function remote(id: string, item: Item): RemoteResource {
  return {
    id,
    name: item.name,
    fields: { limit: item.limit, filters: item.filters },
  };
}

function planViolations(
  declared: readonly Item[],
  current: readonly RemoteResource[],
  plan: DeclaredPlan<Item>,
): string[] {
  const violations: string[] = [];
  const names = new Set(declared.map((item) => item.name));
  const managed = new Map(
    current
      .filter((resource) => names.has(resource.name))
      .map((resource) => [resource.id, resource]),
  );
  if (plan.planned.length !== declared.length)
    violations.push("the plan doesn't hold one entry per declaration");
  for (const [index, planned] of plan.planned.entries()) {
    if (planned.declared !== declared[index])
      violations.push(`entry ${index} plans another item`);
    if (planned.action === "create") {
      if (current.some((resource) => resource.name === planned.declared.name))
        violations.push(`entry ${index} creates a duplicate`);
      continue;
    }
    const match = managed.get(planned.id);
    if (match === undefined) {
      violations.push(
        `entry ${index} touches unmanaged resource ${planned.id}`,
      );
      continue;
    }
    const equal = sameValue(declaration.fields(planned.declared), match.fields);
    if (equal !== (planned.action === "keep"))
      violations.push(
        `entry ${index} ${planned.action}s a resource whose equality is ${equal}`,
      );
  }
  const unmanaged = current
    .filter((resource) => !names.has(resource.name))
    .map((resource) => resource.id);
  if (
    !sameValue(
      plan.unmanaged.map((resource) => resource.id),
      unmanaged,
    )
  )
    violations.push("the plan doesn't list every unmanaged resource");
  return violations;
}

const itemArbitrary = fc.record({
  name: fc.constantFrom("a", "b", "c", "d", "e"),
  limit: fc.constantFrom(1, 2),
  filters: fc.oneof(
    fc.constant({}),
    fc.record({ product: fc.constantFrom(["x"], ["y"], ["x", "y"]) }),
  ),
});

const scenario = fc
  .uniqueArray(itemArbitrary, { selector: (item) => item.name, maxLength: 4 })
  .chain((declared) =>
    fc.tuple(
      fc.constant(declared),
      fc
        .uniqueArray(
          fc.oneof(
            itemArbitrary,
            ...(declared.length > 0 ? [fc.constantFrom(...declared)] : []),
          ),
          { selector: (item) => item.name, maxLength: 5 },
        )
        .map((items) =>
          items.map((item, index) => remote(`id-${index}`, item)),
        ),
    ),
  );

describe("declared plan", () => {
  it("decides the action for every combination of a match and equal settings", () => {
    const table = [
      { found: false, equal: false, action: "create" },
      { found: false, equal: true, action: "create" },
      { found: true, equal: false, action: "update" },
      { found: true, equal: true, action: "keep" },
    ] as const;
    for (const row of table)
      expect(planAction(row.found, row.equal)).toBe(row.action);
  });

  it("compares objects regardless of key order and arrays in order", () => {
    expect(
      sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }),
    ).toBe(true);
    expect(sameValue({ c: [1, 2] }, { c: [2, 1] })).toBe(false);
    expect(sameValue({}, undefined)).toBe(false);
  });

  it("names the changed fields and lists undeclared resources", () => {
    const item: Item = { name: "a", limit: 1, filters: { product: ["x"] } };
    const plan = declaredPlan(
      [item],
      [
        remote("1", { ...item, filters: { product: ["y"] } }),
        remote("2", { ...item, name: "z" }),
      ],
      declaration,
    );
    expect(plan.planned).toEqual([
      { action: "update", id: "1", declared: item, changed: ["filters"] },
    ]);
    expect(plan.unmanaged).toEqual([{ id: "2", name: "z" }]);
  });

  it("refuses duplicate names in its own words", () => {
    const item: Item = { name: "a", limit: 1, filters: {} };
    expect(() => declaredPlan([item, item], [], declaration)).toThrow(
      'The declarations hold two items named "a".',
    );
    expect(() =>
      declaredPlan([item], [remote("1", item), remote("2", item)], declaration),
    ).toThrow('The service hold two items named "a".');
  });

  it("touches only declared resources and keeps equal ones for any remote state", () => {
    fc.assert(
      fc.property(scenario, ([declared, current]) => {
        expect(
          planViolations(
            declared,
            current,
            declaredPlan(declared, current, declaration),
          ),
        ).toEqual([]);
      }),
      { seed: 20261104, numRuns: 500 },
    );
  });

  it("detects planted plans that update an equal resource or touch an unmanaged one", () => {
    const item: Item = { name: "a", limit: 1, filters: {} };
    const current = [
      remote("1", item),
      remote("9", { ...item, name: "other" }),
    ];
    const plan = declaredPlan([item], current, declaration);
    expect(planViolations([item], current, plan)).toEqual([]);
    expect(
      planViolations([item], current, {
        ...plan,
        planned: [{ action: "update", id: "1", declared: item, changed: [] }],
      }),
    ).not.toEqual([]);
    expect(
      planViolations([item], current, {
        ...plan,
        planned: [{ action: "keep", id: "9", declared: item }],
      }),
    ).not.toEqual([]);
  });
});
