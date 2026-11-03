import * as v from "valibot";
import {
  type Declaration,
  type DeclaredPlan,
  declaredPlan,
  type Fields,
} from "./declared-plan.ts";

/** One Cloudflare notification policy, in the field names its API reads and returns. */
export interface AlertPolicy {
  readonly name: string;
  readonly alert_type: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly mechanisms: { readonly email: readonly { readonly id: string }[] };
}

// The command manages only policies with this prefix and leaves the account's other policies alone.
export const managedPrefix = "Public Phonebook ";

// Workers Paid includes these monthly D1 amounts, and each usage policy fires at half of them.
const includedD1RowsRead = 25_000_000_000;
const includedD1RowsWritten = 50_000_000;
const warningShare = 2;

function usageLimit(included: number): string {
  return String(included / warningShare);
}

export function alertPolicies(email: string): AlertPolicy[] {
  const mechanisms = { email: [{ id: email }] };
  const policy = (
    name: string,
    alert_type: string,
    description: string,
    filters: AlertPolicy["filters"] = {},
  ): AlertPolicy => ({
    name: `${managedPrefix}${name}`,
    alert_type,
    description,
    enabled: true,
    filters,
    mechanisms,
  });
  return [
    policy(
      "Worker issues",
      "workers_observability_real_time_issue",
      "Workers Observability found an issue in a Worker of this account.",
    ),
    policy(
      "HTTP DDoS attacks",
      "dos_attack_l7",
      "Cloudflare mitigated an HTTP DDoS attack on a zone of this account.",
    ),
    policy(
      "Universal SSL",
      "universal_ssl_event_type",
      "A Universal SSL certificate of this account changed state.",
    ),
    policy(
      "D1 rows read",
      "billing_usage_alert",
      "D1 read half of the rows that Workers Paid includes this month.",
      { product: ["d1_rows_read"], limit: [usageLimit(includedD1RowsRead)] },
    ),
    policy(
      "D1 rows written",
      "billing_usage_alert",
      "D1 wrote half of the rows that Workers Paid includes this month.",
      {
        product: ["d1_rows_written"],
        limit: [usageLimit(includedD1RowsWritten)],
      },
    ),
  ];
}

export const ExistingPolicy = v.object({
  id: v.string(),
  name: v.string(),
  alert_type: v.string(),
  enabled: v.boolean(),
  description: v.optional(v.nullable(v.string())),
  filters: v.optional(v.nullable(v.record(v.string(), v.array(v.string())))),
  mechanisms: v.optional(
    v.nullable(
      v.record(
        v.string(),
        v.array(v.looseObject({ id: v.optional(v.string()) })),
      ),
    ),
  ),
});
export type ExistingPolicy = v.InferOutput<typeof ExistingPolicy>;

export const PolicyList = v.array(ExistingPolicy);

interface PolicyFields {
  readonly alert_type: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly filters: Readonly<Record<string, readonly string[]>>;
  readonly email: readonly string[];
}

function policyFields(
  policy: Pick<AlertPolicy, "alert_type" | "enabled"> & {
    readonly description?: string | null | undefined;
    readonly filters?:
      | Readonly<Record<string, readonly string[]>>
      | null
      | undefined;
    readonly mechanisms?:
      | Readonly<
          Record<string, readonly { readonly id?: string | undefined }[]>
        >
      | null
      | undefined;
  },
): PolicyFields {
  return {
    alert_type: policy.alert_type,
    description: policy.description ?? "",
    enabled: policy.enabled,
    filters: policy.filters ?? {},
    email: (policy.mechanisms?.email ?? [])
      .flatMap((entry) => (entry.id === undefined ? [] : [entry.id]))
      .sort(),
  };
}

const alertDeclaration: Declaration<AlertPolicy> = {
  name: (policy) => policy.name,
  fields: (policy): Fields => ({ ...policyFields(policy) }),
  noun: "policies",
  service: "Cloudflare",
};

/** Plans the declared policies over the account's policies that carry the managed prefix. */
export function alertPlan(
  declared: readonly AlertPolicy[],
  existing: readonly ExistingPolicy[],
): DeclaredPlan<AlertPolicy> {
  return declaredPlan(
    declared,
    existing
      .filter((policy) => policy.name.startsWith(managedPrefix))
      .map((policy) => ({
        id: policy.id,
        name: policy.name,
        fields: { ...policyFields(policy) },
      })),
    alertDeclaration,
  );
}
