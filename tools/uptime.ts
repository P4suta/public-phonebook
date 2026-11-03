import * as v from "valibot";
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

export async function existingChecks(token: string): Promise<ExistingCheck[]> {
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
    const response: Response = await fetch(next, {
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
): Promise<void> {
  const response = await fetch(url, {
    method,
    headers: headers(token),
    body: JSON.stringify(check),
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

async function apply(token: string, plan: UptimePlan): Promise<void> {
  for (const planned of plan.checks) {
    if (planned.action === "create")
      await send(token, "POST", monitorsApi, planned.check);
    if (planned.action === "update")
      await send(token, "PATCH", `${monitorsApi}/${planned.id}`, planned.check);
  }
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
  const plan = uptimePlan(uptimeChecks, await existingChecks(token));
  for (const line of planLines(plan)) console.log(line);
  if (!applying) return;
  await apply(token, plan);
  const after = uptimePlan(uptimeChecks, await existingChecks(token));
  const pending = after.checks.filter((planned) => planned.action !== "keep");
  if (pending.length > 0)
    throw new Error(
      `Better Stack still differs after the update: ${pending.map((planned) => planned.check.pronounceable_name).join(", ")}.`,
    );
  console.log("Better Stack matches the declared checks.");
}

if (import.meta.main) await main(process.argv.slice(firstArgument));
