import { createHash } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  alertPlanLines,
  applyAlerts,
  cloudflarePolicies,
  type PolicyPort,
} from "@public-phonebook/cloudflare/cloudflare-alerts";
import {
  type AlertPolicy,
  alertPlan,
  alertPolicies,
  type ExistingPolicy,
  managedPrefix,
} from "@public-phonebook/cloudflare/cloudflare-alerts-plan";
import {
  applyMonitors,
  type MonitorPort,
  monitorPort,
  planLines,
} from "@public-phonebook/cloudflare/uptime";
import {
  type ExistingCheck,
  type UptimeCheck,
  uptimeChecks,
  uptimeFields,
  uptimePlan,
} from "@public-phonebook/cloudflare/uptime-plan";
import * as v from "valibot";
import { type ApplyHooks, sameValue } from "./declared-plan.ts";
import { requireCommand } from "./process.ts";

const identity = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const jsonIndent = 2;
const initialArgument = 2;
const revision = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));
const services = v.picklist(["cloudflare-alerts", "monitors"]);
type Service = v.InferOutput<typeof services>;
const PreviewSchema = v.strictObject({
  format: v.literal(1),
  service: services,
  source: revision,
  sha256: identity,
  lines: v.array(v.string()),
});
export type Preview = v.InferOutput<typeof PreviewSchema>;
type Admission = (expected: string, observed: string) => Promise<void>;
interface Effect {
  readonly name: string;
  readonly action: "create" | "update";
  state: "unknown" | "acknowledged" | "verified";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function fingerprint(
  service: Service,
  source: string,
  scope: string,
  declared: unknown,
  observed: readonly { readonly id: string }[],
): string {
  return createHash("sha256")
    .update(
      canonical({
        service,
        source,
        scope,
        declared,
        observed: observed.toSorted((left, right) =>
          left.id.localeCompare(right.id, "en"),
        ),
      }),
    )
    .digest("hex");
}

async function save(
  path: string,
  value: unknown,
  exclusive = false,
): Promise<void> {
  if (exclusive) {
    const file = await open(path, "wx");
    try {
      await file.writeFile(`${JSON.stringify(value, null, jsonIndent)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w");
  try {
    await file.writeFile(`${JSON.stringify(value, null, jsonIndent)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

const admit: Admission = async (expected, observed) => {
  await requireCommand("tools/delivery/target/debug/delivery", [
    "admit",
    expected,
    observed,
  ]);
};

function hooks<Declared, Existing>(
  preview: Preview,
  path: string,
  current: (
    declared: readonly Declared[],
    observed: readonly Existing[],
  ) => Preview,
  admission: Admission,
): {
  readonly hooks: ApplyHooks<Declared, Existing>;
  readonly finish: () => Promise<void>;
} {
  const effects: Effect[] = [];
  const record = (): Promise<void> =>
    save(path, { format: 1, preview, effects });
  return {
    hooks: {
      beforeApply: async (declared, observed) => {
        const actual = current(declared, observed);
        if (!sameValue(preview.lines, actual.lines))
          throw new Error("The reviewed configuration description changed");
        await admission(preview.sha256, actual.sha256);
        await save(path, { format: 1, preview, effects }, true);
      },
      beforeWrite: async (name, action) => {
        effects.push({ name, action, state: "unknown" });
        await record();
      },
      acknowledged: async (name) => {
        const effect = effects.find((entry) => entry.name === name);
        if (!effect) throw new Error("No saved configuration effect");
        effect.state = "acknowledged";
        await record();
      },
    },
    finish: async () => {
      for (const effect of effects) effect.state = "verified";
      await record();
    },
  };
}

export function alertPreview(
  source: string,
  account: string,
  declared: readonly AlertPolicy[],
  observed: readonly ExistingPolicy[],
): Preview {
  return v.parse(PreviewSchema, {
    format: 1,
    service: "cloudflare-alerts",
    source,
    sha256: fingerprint(
      "cloudflare-alerts",
      source,
      account,
      declared,
      observed.filter((policy) => policy.name.startsWith(managedPrefix)),
    ),
    lines: alertPlanLines(alertPlan(declared, observed)),
  });
}

export function monitorPreview(
  source: string,
  team: string,
  declared: readonly UptimeCheck[],
  observed: readonly ExistingCheck[],
): Preview {
  const names = new Set(declared.map((check) => check.pronounceable_name));
  const managed = observed
    .filter((check) => names.has(check.attributes.pronounceable_name))
    .map((check) => ({
      id: check.id,
      team: check.attributes.team_name,
      fields: Object.fromEntries(
        uptimeFields.map((field) => [field, check.attributes[field]]),
      ),
    }));
  return v.parse(PreviewSchema, {
    format: 1,
    service: "monitors",
    source,
    sha256: fingerprint("monitors", source, team, declared, managed),
    lines: planLines(uptimePlan(declared, observed)),
  });
}

export async function applyAlertPreview(
  port: PolicyPort,
  source: string,
  account: string,
  declared: readonly AlertPolicy[],
  preview: Preview,
  journal: string,
  admission: Admission = admit,
): Promise<void> {
  if (preview.service !== "cloudflare-alerts" || preview.source !== source)
    throw new Error("The preview belongs to another service");
  const tracking = hooks(
    preview,
    journal,
    (desired: readonly AlertPolicy[], observed: readonly ExistingPolicy[]) =>
      alertPreview(source, account, desired, observed),
    admission,
  );
  for (const line of await applyAlerts(port, declared, true, tracking.hooks))
    console.info(line);
  await tracking.finish();
}

export async function applyMonitorPreview(
  port: MonitorPort,
  source: string,
  team: string,
  declared: readonly UptimeCheck[],
  preview: Preview,
  journal: string,
  admission: Admission = admit,
): Promise<void> {
  if (preview.service !== "monitors" || preview.source !== source)
    throw new Error("The preview belongs to another service");
  const tracking = hooks(
    preview,
    journal,
    (desired: readonly UptimeCheck[], observed: readonly ExistingCheck[]) =>
      monitorPreview(source, team, desired, observed),
    admission,
  );
  for (const line of await applyMonitors(port, declared, true, tracking.hooks))
    console.info(line);
  await tracking.finish();
}

async function main(args: readonly string[]): Promise<void> {
  const [action, serviceValue, file, ...extra] = args;
  if ((action !== "preview" && action !== "apply") || !file || extra.length)
    throw new Error("Pass preview or apply, a service, and a preview path");
  const service = v.parse(services, serviceValue);
  const source = v.parse(revision, process.env.GITHUB_SHA);
  if (process.env.GITHUB_REF !== "refs/heads/main")
    throw new Error("Configuration operations require protected main");
  const path = resolve(file);
  const preview =
    action === "apply"
      ? v.parse(PreviewSchema, JSON.parse(await readFile(path, "utf8")))
      : undefined;
  if (service === "cloudflare-alerts") {
    const account = v.parse(
      v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u)),
      process.env.CLOUDFLARE_ACCOUNT_ID,
    );
    const email = v.parse(
      v.pipe(v.string(), v.email()),
      process.env.CLOUDFLARE_ALERT_EMAIL,
    );
    const declared = alertPolicies(email);
    if (preview)
      await applyAlertPreview(
        cloudflarePolicies,
        source,
        account,
        declared,
        preview,
        `${path}.journal.json`,
      );
    else {
      const result = alertPreview(
        source,
        account,
        declared,
        await cloudflarePolicies.list(),
      );
      await save(path, result);
      for (const line of result.lines) console.info(line);
    }
  } else {
    const team = v.parse(
      v.pipe(v.string(), v.minLength(1)),
      process.env.BETTER_STACK_TEAM,
    );
    const token = v.parse(
      v.pipe(v.string(), v.minLength(1)),
      process.env.BETTER_STACK_API_TOKEN,
    );
    const port = monitorPort(token, team);
    if (preview)
      await applyMonitorPreview(
        port,
        source,
        team,
        uptimeChecks,
        preview,
        `${path}.journal.json`,
      );
    else {
      const result = monitorPreview(
        source,
        team,
        uptimeChecks,
        await port.list(),
      );
      await save(path, result);
      for (const line of result.lines) console.info(line);
    }
  }
}

if (import.meta.main) await main(process.argv.slice(initialArgument));
