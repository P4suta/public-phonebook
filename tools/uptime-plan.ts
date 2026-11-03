import * as v from "valibot";

/** One Better Stack keyword check, in the field names its monitors API reads and returns. */
export interface UptimeCheck {
  readonly pronounceable_name: string;
  readonly monitor_type: "keyword";
  readonly url: string;
  readonly required_keyword: string;
  readonly check_frequency: number;
  readonly email: boolean;
}

export type UptimeField = keyof UptimeCheck;

export const uptimeFields: readonly UptimeField[] = [
  "pronounceable_name",
  "monitor_type",
  "url",
  "required_keyword",
  "check_frequency",
  "email",
];

const every3Minutes = 180;

// Each keyword appears only on a page that rendered its data, so an error page or a 404 fails the check.
export const uptimeChecks: readonly UptimeCheck[] = [
  {
    pronounceable_name: "Public Phonebook top page",
    monitor_type: "keyword",
    url: "https://www.dial.page/",
    required_keyword: "電話番号をさがす",
    check_frequency: every3Minutes,
    email: true,
  },
  {
    pronounceable_name: "Public Phonebook search",
    monitor_type: "keyword",
    url: `https://www.dial.page/?q=${encodeURIComponent("東京都庁")}`,
    required_keyword: "03-5321-1111",
    check_frequency: every3Minutes,
    email: true,
  },
  {
    pronounceable_name: "Public Phonebook app data index",
    monitor_type: "keyword",
    url: "https://www.dial.page/api/v1",
    required_keyword: '"datasets"',
    check_frequency: every3Minutes,
    email: true,
  },
];

export const ExistingCheck = v.object({
  id: v.string(),
  attributes: v.looseObject({
    pronounceable_name: v.string(),
    monitor_type: v.string(),
    url: v.nullable(v.string()),
    required_keyword: v.nullable(v.string()),
    check_frequency: v.number(),
    email: v.boolean(),
  }),
});
export type ExistingCheck = v.InferOutput<typeof ExistingCheck>;

export const CheckPage = v.object({
  data: v.array(ExistingCheck),
  pagination: v.object({ next: v.nullable(v.string()) }),
});

export type CheckAction = "create" | "update" | "keep";

export function checkAction(found: boolean, equal: boolean): CheckAction {
  if (!found) return "create";
  return equal ? "keep" : "update";
}

export type PlannedCheck =
  | { readonly action: "create"; readonly check: UptimeCheck }
  | {
      readonly action: "update";
      readonly id: string;
      readonly check: UptimeCheck;
      readonly changed: readonly UptimeField[];
    }
  | {
      readonly action: "keep";
      readonly id: string;
      readonly check: UptimeCheck;
    };

export interface UnmanagedCheck {
  readonly id: string;
  readonly name: string;
}

export interface UptimePlan {
  readonly checks: readonly PlannedCheck[];
  readonly unmanaged: readonly UnmanagedCheck[];
}

export function changedFields(
  check: UptimeCheck,
  existing: ExistingCheck,
): UptimeField[] {
  return uptimeFields.filter(
    (field) => existing.attributes[field] !== check[field],
  );
}

function uniqueNames(names: readonly string[], source: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name))
      throw new Error(`${source} hold two checks named "${name}".`);
    seen.add(name);
  }
}

/** Matches declared and existing checks by name; it never plans a deletion. */
export function uptimePlan(
  declared: readonly UptimeCheck[],
  existing: readonly ExistingCheck[],
): UptimePlan {
  uniqueNames(
    declared.map((check) => check.pronounceable_name),
    "The declarations",
  );
  const declaredNames = new Set(
    declared.map((check) => check.pronounceable_name),
  );
  uniqueNames(
    existing
      .map((check) => check.attributes.pronounceable_name)
      .filter((name) => declaredNames.has(name)),
    "Better Stack",
  );
  const byName = new Map(
    existing.map((check) => [check.attributes.pronounceable_name, check]),
  );
  const checks = declared.map((check): PlannedCheck => {
    const match = byName.get(check.pronounceable_name);
    const changed = match === undefined ? [] : changedFields(check, match);
    const action = checkAction(match !== undefined, changed.length === 0);
    if (match === undefined || action === "create")
      return { action: "create", check };
    return action === "keep"
      ? { action, id: match.id, check }
      : { action, id: match.id, check, changed };
  });
  const unmanaged = existing
    .filter((check) => !declaredNames.has(check.attributes.pronounceable_name))
    .map((check) => ({
      id: check.id,
      name: check.attributes.pronounceable_name,
    }));
  return { checks, unmanaged };
}
