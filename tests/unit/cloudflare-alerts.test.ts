import { describe, expect, it } from "vitest";
import {
  alertPlanLines,
  applyAlerts,
  type PolicyPort,
} from "../../tools/cloudflare-alerts.ts";
import {
  type AlertPolicy,
  alertPlan,
  alertPolicies,
  type ExistingPolicy,
  managedPrefix,
} from "../../tools/cloudflare-alerts-plan.ts";

const email = "owner@example.test";

function existing(id: string, policy: AlertPolicy): ExistingPolicy {
  return {
    id,
    ...policy,
    filters: Object.fromEntries(
      Object.entries(policy.filters).map(([key, values]) => [key, [...values]]),
    ),
    mechanisms: { email: [...policy.mechanisms.email] },
  };
}

function memoryPort(
  initial: readonly ExistingPolicy[],
  persist = true,
): { readonly port: PolicyPort; readonly writes: string[] } {
  const policies = [...initial];
  const writes: string[] = [];
  const port: PolicyPort = {
    async list() {
      return policies.map((policy) => ({ ...policy }));
    },
    async create(policy) {
      writes.push(`create ${policy.name}`);
      if (persist) policies.push(existing(`new-${writes.length}`, policy));
    },
    async update(id, policy) {
      writes.push(`update ${id}`);
      const index = policies.findIndex((current) => current.id === id);
      if (persist && index >= 0) policies[index] = existing(id, policy);
    },
  };
  return { port, writes };
}

const unrelated: ExistingPolicy = {
  id: "blog",
  name: "Blog health check",
  alert_type: "health_check_status_notification",
  enabled: true,
  mechanisms: { email: [{ id: "someone@example.test" }] },
};

describe("Cloudflare notification policies", () => {
  it("declares five prefixed policies that mail the stored destination", () => {
    const policies = alertPolicies(email);
    expect(policies.map((policy) => policy.name)).toEqual([
      "Public Phonebook Worker issues",
      "Public Phonebook HTTP DDoS attacks",
      "Public Phonebook Universal SSL",
      "Public Phonebook D1 rows read",
      "Public Phonebook D1 rows written",
    ]);
    for (const policy of policies) {
      expect(policy.name.startsWith(managedPrefix)).toBe(true);
      expect(policy.enabled).toBe(true);
      expect(policy.mechanisms).toEqual({ email: [{ id: email }] });
    }
    expect(policies[3]?.filters).toEqual({
      product: ["d1_rows_read"],
      limit: ["12500000000"],
    });
    expect(policies[4]?.filters).toEqual({
      product: ["d1_rows_written"],
      limit: ["25000000"],
    });
  });

  it("ignores the account's other policies and treats missing filters as empty", () => {
    const [issues] = alertPolicies(email);
    if (issues === undefined) throw new Error("Expected a declared policy.");
    const plan = alertPlan(
      [issues],
      [
        unrelated,
        {
          ...existing("1", issues),
          filters: null,
          description: issues.description,
        },
      ],
    );
    expect(plan.planned).toEqual([
      { action: "keep", id: "1", declared: issues },
    ]);
    expect(plan.unmanaged).toEqual([]);
  });

  it("updates a changed limit and lists a prefixed policy it doesn't declare", () => {
    const policies = alertPolicies(email);
    const read = policies[3];
    if (read === undefined) throw new Error("Expected the rows read policy.");
    const plan = alertPlan(
      [read],
      [
        existing("1", {
          ...read,
          filters: { product: ["d1_rows_read"], limit: ["1"] },
        }),
        existing("2", { ...read, name: `${managedPrefix}Old` }),
      ],
    );
    expect(alertPlanLines(plan)).toEqual([
      "update  Public Phonebook D1 rows read (filters)",
      "unmanaged  Public Phonebook Old (id 2); this command leaves it as it is",
    ]);
  });

  it("prints no destination address", () => {
    const plan = alertPlan(alertPolicies(email), []);
    expect(alertPlanLines(plan).join("\n")).not.toContain(email);
  });

  it("writes nothing when it only plans", async () => {
    const { port, writes } = memoryPort([unrelated]);
    const lines = await applyAlerts(port, alertPolicies(email), false);
    expect(lines).toHaveLength(5);
    expect(writes).toEqual([]);
  });

  it("creates and updates declared policies and then matches", async () => {
    const policies = alertPolicies(email);
    const issues = policies[0];
    if (issues === undefined) throw new Error("Expected a declared policy.");
    const { port, writes } = memoryPort([
      unrelated,
      existing("1", { ...issues, enabled: false }),
    ]);
    const lines = await applyAlerts(port, policies, true);
    expect(writes).toEqual([
      "update 1",
      "create Public Phonebook HTTP DDoS attacks",
      "create Public Phonebook Universal SSL",
      "create Public Phonebook D1 rows read",
      "create Public Phonebook D1 rows written",
    ]);
    expect(lines.at(-1)).toBe("Cloudflare matches the declared policies.");
  });

  it("fails when Cloudflare still differs after the writes", async () => {
    const { port } = memoryPort([], false);
    await expect(applyAlerts(port, alertPolicies(email), true)).rejects.toThrow(
      /still differs after the update/,
    );
  });
});
