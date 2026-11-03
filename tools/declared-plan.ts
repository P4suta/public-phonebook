export type PlanAction = "create" | "update" | "keep";

export function planAction(found: boolean, equal: boolean): PlanAction {
  if (!found) return "create";
  return equal ? "keep" : "update";
}

export type Fields = Readonly<Record<string, unknown>>;

export interface RemoteResource {
  readonly id: string;
  readonly name: string;
  readonly fields: Fields;
}

export type Planned<T> =
  | { readonly action: "create"; readonly declared: T }
  | {
      readonly action: "update";
      readonly id: string;
      readonly declared: T;
      readonly changed: readonly string[];
    }
  | { readonly action: "keep"; readonly id: string; readonly declared: T };

export interface UnmanagedResource {
  readonly id: string;
  readonly name: string;
}

export interface DeclaredPlan<T> {
  readonly planned: readonly Planned<T>[];
  readonly unmanaged: readonly UnmanagedResource[];
}

/** Names a declared resource, picks the settings to compare, and words duplicate-name errors. */
export interface Declaration<T> {
  readonly name: (declared: T) => string;
  readonly fields: (declared: T) => Fields;
  readonly noun: string;
  readonly service: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

/** Compares JSON values structurally, so object key order never counts as a change. */
export function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function uniqueNames(
  names: readonly string[],
  owner: string,
  noun: string,
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name))
      throw new Error(`${owner} hold two ${noun} named "${name}".`);
    seen.add(name);
  }
}

/** Matches declared and remote resources by name; it never plans a deletion. */
export function declaredPlan<T>(
  declared: readonly T[],
  remote: readonly RemoteResource[],
  declaration: Declaration<T>,
): DeclaredPlan<T> {
  const names = declared.map(declaration.name);
  uniqueNames(names, "The declarations", declaration.noun);
  const declaredNames = new Set(names);
  uniqueNames(
    remote
      .map((resource) => resource.name)
      .filter((name) => declaredNames.has(name)),
    declaration.service,
    declaration.noun,
  );
  const byName = new Map(remote.map((resource) => [resource.name, resource]));
  const planned = declared.map((item): Planned<T> => {
    const match = byName.get(declaration.name(item));
    if (match === undefined) return { action: "create", declared: item };
    const changed = Object.entries(declaration.fields(item))
      .filter(([field, value]) => !sameValue(value, match.fields[field]))
      .map(([field]) => field);
    const action = planAction(true, changed.length === 0);
    return action === "keep"
      ? { action, id: match.id, declared: item }
      : { action: "update", id: match.id, declared: item, changed };
  });
  const unmanaged = remote
    .filter((resource) => !declaredNames.has(resource.name))
    .map(({ id, name }) => ({ id, name }));
  return { planned, unmanaged };
}
