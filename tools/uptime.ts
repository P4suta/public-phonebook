import * as v from "valibot";
import type { ApplyHooks } from "./declared-plan.ts";
import {
  CheckPage,
  type ExistingCheck,
  type UptimeCheck,
  type UptimePlan,
  uptimeChecks,
  uptimePlan,
} from "./uptime-plan.ts";

const monitorsApi = "https://incidents.betterstack.com/api/v2/monitors";
const pageLimit = 50;
const requestTimeoutMs = 30_000;
// Pads the action to the width of "update", so the names line up.
const actionWidth = "update".length;
// Skips the node executable and the script path.
const firstArgument = 2;

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

export async function existingChecks(
  token: string,
  team?: string,
): Promise<ExistingCheck[]> {
  const checks: ExistingCheck[] = [];
  let next: string | null = monitorsApi;
  for (let page = 0; next !== null; page += 1) {
    if (page === pageLimit)
      throw new Error(
        `Better Stack listed more than ${pageLimit} pages of checks.`,
      );
    // The token goes only to the monitors API, even when a pagination link names another host.
    if (!next.startsWith(`${monitorsApi}?`) && next !== monitorsApi)
      throw new Error(
        "Better Stack sent a pagination link outside the monitors API.",
      );
    const url = new URL(next);
    if (team !== undefined) url.searchParams.set("team_name", team);
    const response: Response = await fetch(url.href, {
      headers: headers(token),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok)
      throw new Error(
        `Better Stack answered ${response.status} to the check list.`,
      );
    const body: v.InferOutput<typeof CheckPage> = v.parse(
      CheckPage,
      await response.json(),
    );
    if (
      team !== undefined &&
      body.data.some((check) => check.attributes.team_name !== team)
    )
      throw new Error("Better Stack returned monitors from another team");
    checks.push(...body.data);
    next = body.pagination.next;
  }
  return checks;
}

async function send(
  token: string,
  method: "POST" | "PATCH",
  url: string,
  check: UptimeCheck,
  team?: string,
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: headers(token),
    body: JSON.stringify(
      team === undefined ? check : { ...check, team_name: team },
    ),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok)
    throw new Error(
      `Better Stack answered ${response.status} to ${method} for "${check.pronounceable_name}": ${await response.text()}`,
    );
}

export function planLines(plan: UptimePlan): string[] {
  const lines = plan.checks.map((planned) =>
    planned.action === "update"
      ? `update  ${planned.check.pronounceable_name} (${planned.changed.join(", ")})`
      : `${planned.action.padEnd(actionWidth)}  ${planned.check.pronounceable_name}`,
  );
  for (const check of plan.unmanaged)
    lines.push(
      `unmanaged  ${check.name} (id ${check.id}); this command leaves it as it is`,
    );
  return lines;
}

export interface MonitorPort {
  list(): Promise<ExistingCheck[]>;
  create(check: UptimeCheck): Promise<void>;
  update(id: string, check: UptimeCheck): Promise<void>;
}

export function monitorPort(token: string, team?: string): MonitorPort {
  return {
    list: () => existingChecks(token, team),
    create: (check) => send(token, "POST", monitorsApi, check, team),
    update: (id, check) =>
      send(token, "PATCH", `${monitorsApi}/${id}`, check, team),
  };
}

export async function applyMonitors(
  port: MonitorPort,
  declared: readonly UptimeCheck[],
  applying: boolean,
  hooks: ApplyHooks<UptimeCheck, ExistingCheck> = {},
): Promise<string[]> {
  const existing = await port.list();
  const plan = uptimePlan(declared, existing);
  const lines = planLines(plan);
  if (!applying) return lines;
  await hooks.beforeApply?.(declared, existing);
  for (const planned of plan.checks) {
    if (planned.action === "keep") continue;
    await hooks.beforeWrite?.(planned.check.pronounceable_name, planned.action);
    if (planned.action === "create") await port.create(planned.check);
    else await port.update(planned.id, planned.check);
    await hooks.acknowledged?.(planned.check.pronounceable_name);
  }
  const after = uptimePlan(declared, await port.list());
  const pending = after.checks.filter((planned) => planned.action !== "keep");
  if (pending.length > 0)
    throw new Error(
      `Better Stack still differs after the update: ${pending.map((planned) => planned.check.pronounceable_name).join(", ")}.`,
    );
  return [...lines, "Better Stack matches the declared checks."];
}

async function main(argv: readonly string[]): Promise<void> {
  const applying = argv.length === 1 && argv[0] === "--apply";
  if (argv.length > 0 && !applying)
    throw new Error("Usage: node tools/uptime.ts [--apply]");
  const token = process.env.BETTER_STACK_API_TOKEN ?? "";
  if (token.length === 0)
    throw new Error(
      "Store BETTER_STACK_API_TOKEN in the Doppler prd config, and run this through `just monitors`.",
    );
  for (const line of await applyMonitors(
    monitorPort(token, process.env.BETTER_STACK_TEAM),
    uptimeChecks,
    applying,
  ))
    console.log(line);
}

if (import.meta.main) await main(process.argv.slice(firstArgument));
