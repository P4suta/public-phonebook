import { cloudflare } from "@public-phonebook/cloudflare/cloudflare";
import {
  type AlertPolicy,
  alertPlan,
  alertPolicies,
  type ExistingPolicy,
  PolicyList,
} from "@public-phonebook/cloudflare/cloudflare-alerts-plan";
import * as v from "valibot";
import type { ApplyHooks, DeclaredPlan } from "../../../tools/declared-plan.ts";

// Pads the action to the width of "update", so the names line up.
const actionWidth = "update".length;
// Skips the node executable and the script path.
const firstArgument = 2;

export interface PolicyPort {
  list(): Promise<ExistingPolicy[]>;
  create(policy: AlertPolicy): Promise<void>;
  update(id: string, policy: AlertPolicy): Promise<void>;
}

export const cloudflarePolicies: PolicyPort = {
  async list() {
    return v.parse(
      PolicyList,
      await cloudflare(["alerting", "policies", "list"]),
    );
  },
  async create(policy) {
    await cloudflare([
      "alerting",
      "policies",
      "create",
      "--body",
      JSON.stringify(policy),
    ]);
  },
  async update(id, policy) {
    await cloudflare([
      "alerting",
      "policies",
      "update",
      id,
      "--body",
      JSON.stringify(policy),
    ]);
  },
};

/** Lists names and changed field names only, so no destination address reaches the output. */
export function alertPlanLines(plan: DeclaredPlan<AlertPolicy>): string[] {
  const lines = plan.planned.map((planned) =>
    planned.action === "update"
      ? `update  ${planned.declared.name} (${planned.changed.join(", ")})`
      : `${planned.action.padEnd(actionWidth)}  ${planned.declared.name}`,
  );
  for (const policy of plan.unmanaged)
    lines.push(
      `unmanaged  ${policy.name} (id ${policy.id}); this command leaves it as it is`,
    );
  return lines;
}

export async function applyAlerts(
  port: PolicyPort,
  declared: readonly AlertPolicy[],
  applying: boolean,
  hooks: ApplyHooks<AlertPolicy, ExistingPolicy> = {},
): Promise<string[]> {
  const existing = await port.list();
  const plan = alertPlan(declared, existing);
  const lines = alertPlanLines(plan);
  if (!applying) return lines;
  await hooks.beforeApply?.(declared, existing);
  for (const planned of plan.planned) {
    if (planned.action === "keep") continue;
    await hooks.beforeWrite?.(planned.declared.name, planned.action);
    if (planned.action === "create") await port.create(planned.declared);
    if (planned.action === "update")
      await port.update(planned.id, planned.declared);
    await hooks.acknowledged?.(planned.declared.name);
  }
  const after = alertPlan(declared, await port.list());
  const pending = after.planned.filter((planned) => planned.action !== "keep");
  if (pending.length > 0)
    throw new Error(
      `Cloudflare still differs after the update: ${pending.map((planned) => planned.declared.name).join(", ")}.`,
    );
  return [...lines, "Cloudflare matches the declared policies."];
}

async function main(argv: readonly string[]): Promise<void> {
  const applying = argv.length === 1 && argv[0] === "--apply";
  if (argv.length > 0 && !applying)
    throw new Error(
      "Usage: node infrastructure/cloudflare/src/cloudflare-alerts.ts [--apply]",
    );
  const email = process.env.CLOUDFLARE_ALERT_EMAIL ?? "";
  if (!email.includes("@"))
    throw new Error(
      "Store CLOUDFLARE_ALERT_EMAIL in the Doppler prd config, and run this through `just cloudflare-alerts`.",
    );
  const lines = await applyAlerts(
    cloudflarePolicies,
    alertPolicies(email),
    applying,
  );
  for (const line of lines) console.log(line);
}

if (import.meta.main) await main(process.argv.slice(firstArgument));
