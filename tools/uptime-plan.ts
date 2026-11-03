import * as v from "valibot";
import {
  type Declaration,
  declaredPlan,
  type PlanAction,
  planAction,
} from "./declared-plan.ts";

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

export type CheckAction = PlanAction;
export const checkAction = planAction;

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

const uptimeDeclaration: Declaration<UptimeCheck> = {
  name: (check) => check.pronounceable_name,
  fields: (check) =>
    Object.fromEntries(uptimeFields.map((field) => [field, check[field]])),
  noun: "checks",
  service: "Better Stack",
};

function isUptimeField(field: string): field is UptimeField {
  return uptimeFields.some((known) => known === field);
}

/** Matches declared and existing checks by name; it never plans a deletion. */
export function uptimePlan(
  declared: readonly UptimeCheck[],
  existing: readonly ExistingCheck[],
): UptimePlan {
  const plan = declaredPlan(
    declared,
    existing.map((check) => ({
      id: check.id,
      name: check.attributes.pronounceable_name,
      fields: check.attributes,
    })),
    uptimeDeclaration,
  );
  const checks = plan.planned.map((planned): PlannedCheck => {
    if (planned.action === "create")
      return { action: "create", check: planned.declared };
    if (planned.action === "keep")
      return { action: "keep", id: planned.id, check: planned.declared };
    return {
      action: "update",
      id: planned.id,
      check: planned.declared,
      changed: planned.changed.filter(isUptimeField),
    };
  });
  return { checks, unmanaged: plan.unmanaged };
}
