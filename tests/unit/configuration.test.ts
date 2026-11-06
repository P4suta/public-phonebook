import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAlerts, type PolicyPort } from "../../tools/cloudflare-alerts.ts";
import {
  type AlertPolicy,
  alertPolicies,
  ExistingPolicy,
} from "../../tools/cloudflare-alerts-plan.ts";
import {
  alertPreview,
  applyAlertPreview,
  applyMonitorPreview,
  monitorPreview,
} from "../../tools/configuration.ts";
import { existingChecks, type MonitorPort } from "../../tools/uptime.ts";
import { type ExistingCheck, uptimeChecks } from "../../tools/uptime-plan.ts";

const source = "a".repeat(40);
const account = "b".repeat(32);
const declared = alertPolicies("owner@example.test");
const first = declared[0];
const second = declared[1];
if (!first || !second) throw new Error("Missing declared policy fixtures");
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function journal(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "phonebook-configuration-"));
  directories.push(directory);
  return join(directory, "effects.json");
}

async function admit(expected: string, observed: string): Promise<void> {
  if (expected !== observed) throw new Error("Changed preview");
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => {
    throw new Error("Uninitialized promise");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function existing(id: string, policy: AlertPolicy): ExistingPolicy {
  return v.parse(ExistingPolicy, { ...policy, id });
}

function policies(
  initial: readonly ExistingPolicy[] = [],
  loseResponseAt = 0,
  persist = true,
): {
  readonly port: PolicyPort;
  readonly writes: string[];
} {
  const values = [...initial];
  const writes: string[] = [];
  async function put(policy: AlertPolicy, id: string): Promise<void> {
    writes.push(policy.name);
    const index = values.findIndex((value) => value.id === id);
    if (persist) {
      if (index < 0) values.push(existing(id, policy));
      else values[index] = existing(id, policy);
    }
    if (writes.length === loseResponseAt)
      throw new Error("Accepted write lost its response");
  }
  return {
    writes,
    port: {
      list: async () => values,
      create: (policy) => put(policy, `created-${writes.length}`),
      update: (id, policy) => put(policy, id),
    },
  };
}

describe("configuration preview admission", () => {
  it("fingerprints actual values, account, source, and stable resource order without exposing destinations", () => {
    const observed = declared.map((policy, id) =>
      existing(String(id), { ...policy, enabled: false }),
    );
    const preview = alertPreview(source, account, declared, observed);
    expect(
      alertPreview(source, account, declared, observed.toReversed()).sha256,
    ).toBe(preview.sha256);
    expect(
      alertPreview(source, "c".repeat(32), declared, observed).sha256,
    ).not.toBe(preview.sha256);
    expect(
      alertPreview("c".repeat(40), account, declared, observed).sha256,
    ).not.toBe(preview.sha256);
    const otherDestination = observed.map((policy) => ({
      ...policy,
      mechanisms: { email: [{ id: "changed@example.test" }] },
    }));
    expect(
      alertPreview(source, account, declared, otherDestination).sha256,
    ).not.toBe(preview.sha256);
    expect(JSON.stringify(preview)).not.toContain("owner@example.test");
  });

  it("never writes during preview and waits for asynchronous admission before writing", async () => {
    const memory = policies();
    const reached = deferred();
    const permission = deferred();
    await applyAlerts(memory.port, declared, false, {
      beforeApply: async () => {
        throw new Error("Preview invoked apply");
      },
    });
    expect(memory.writes).toEqual([]);
    const task = applyAlertPreview(
      memory.port,
      source,
      account,
      declared,
      alertPreview(source, account, declared, []),
      await journal(),
      async (expected, observed) => {
        reached.resolve();
        await permission.promise;
        await admit(expected, observed);
      },
    );
    await reached.promise;
    expect(memory.writes).toEqual([]);
    permission.resolve();
    await task;
    expect(memory.writes).toHaveLength(declared.length);
  });

  it("refuses drift and a preview from another source before any provider write", async () => {
    const preview = alertPreview(source, account, declared, []);
    const memory = policies([existing("changed", first)]);
    await expect(
      applyAlertPreview(
        memory.port,
        source,
        account,
        declared,
        preview,
        await journal(),
        admit,
      ),
    ).rejects.toThrow("description changed");
    await expect(
      applyAlertPreview(
        memory.port,
        "c".repeat(40),
        account,
        declared,
        preview,
        await journal(),
        admit,
      ),
    ).rejects.toThrow("another service");
    expect(memory.writes).toEqual([]);
  });

  it("refuses altered review text even when the saved digest is unchanged", async () => {
    const preview = alertPreview(source, account, declared, []);
    const memory = policies();
    await expect(
      applyAlertPreview(
        memory.port,
        source,
        "c".repeat(32),
        declared,
        preview,
        await journal(),
        admit,
      ),
    ).rejects.toThrow("Changed preview");
    await expect(
      applyAlertPreview(
        memory.port,
        source,
        account,
        declared,
        { ...preview, lines: ["keep every managed policy"] },
        await journal(),
        admit,
      ),
    ).rejects.toThrow("description changed");
    expect(memory.writes).toEqual([]);
  });

  it("records a lost response before the call and preserves partial completion without replay", async () => {
    const path = await journal();
    const memory = policies([], 2);
    const preview = alertPreview(source, account, declared, []);
    await expect(
      applyAlertPreview(
        memory.port,
        source,
        account,
        declared,
        preview,
        path,
        admit,
      ),
    ).rejects.toThrow("lost its response");
    const record: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(record).toMatchObject({
      effects: [
        { name: first.name, state: "acknowledged" },
        { name: second.name, state: "unknown" },
      ],
    });
    const original = await readFile(path, "utf8");
    const retry = policies();
    await expect(
      applyAlertPreview(
        retry.port,
        source,
        account,
        declared,
        preview,
        path,
        admit,
      ),
    ).rejects.toThrow();
    expect(retry.writes).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("marks effects verified only after successful readback", async () => {
    for (const persist of [true, false]) {
      const path = await journal();
      const memory = policies([], 0, persist);
      const task = applyAlertPreview(
        memory.port,
        source,
        account,
        declared,
        alertPreview(source, account, declared, []),
        path,
        admit,
      );
      if (persist) await task;
      else await expect(task).rejects.toThrow("still differs");
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      expect(record).toMatchObject({
        effects: declared.map((policy) => ({
          name: policy.name,
          state: persist ? "verified" : "acknowledged",
        })),
      });
    }
  });

  it("does not replace an existing uncertain journal even when it has no effects", async () => {
    const path = await journal();
    await writeFile(path, "preserved evidence");
    const memory = policies();
    await expect(
      applyAlertPreview(
        memory.port,
        source,
        account,
        declared,
        alertPreview(source, account, declared, []),
        path,
        admit,
      ),
    ).rejects.toThrow();
    expect(memory.writes).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("preserved evidence");
  });
});

describe("scoped uptime configuration", () => {
  it("ignores volatile status but binds declared fields and team identity", () => {
    const observed: ExistingCheck[] = uptimeChecks.map((check, id) => ({
      id: String(id),
      attributes: { ...check, team_name: "Phonebook", status: "up" },
    }));
    const preview = monitorPreview(source, "Phonebook", uptimeChecks, observed);
    const later = observed.map((check) => ({
      ...check,
      attributes: { ...check.attributes, status: "down", updated_at: "later" },
    }));
    expect(
      monitorPreview(source, "Phonebook", uptimeChecks, later).sha256,
    ).toBe(preview.sha256);
    expect(
      monitorPreview(source, "Another team", uptimeChecks, later).sha256,
    ).not.toBe(preview.sha256);
    const changed = observed.map((check) => ({
      ...check,
      attributes: { ...check.attributes, check_frequency: 60 },
    }));
    expect(
      monitorPreview(source, "Phonebook", uptimeChecks, changed).sha256,
    ).not.toBe(preview.sha256);
  });

  it("uses the same journal and admission boundary for monitor writes", async () => {
    const values: ExistingCheck[] = [];
    const port: MonitorPort = {
      list: async () => values,
      create: async (check) => {
        values.push({
          id: String(values.length),
          attributes: { ...check, team_name: "Phonebook" },
        });
      },
      update: async () => {
        throw new Error("Unexpected update");
      },
    };
    const path = await journal();
    await applyMonitorPreview(
      port,
      source,
      "Phonebook",
      uptimeChecks,
      monitorPreview(source, "Phonebook", uptimeChecks, []),
      path,
      admit,
    );
    expect(values).toHaveLength(uptimeChecks.length);
    const record: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(record).toMatchObject({
      effects: uptimeChecks.map((check) => ({
        name: check.pronounceable_name,
        state: "verified",
      })),
    });
  });

  it("retains the team filter across pages and refuses foreign pagination before sending its token", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    fetcher.mockResolvedValueOnce(
      Response.json({
        data: [],
        pagination: {
          next: "https://incidents.betterstack.com/api/v2/monitors?page=2",
        },
      }),
    );
    fetcher.mockResolvedValueOnce(
      Response.json({
        data: [],
        pagination: { next: "https://attacker.invalid/monitors?page=3" },
      }),
    );
    await expect(existingChecks("private-token", "Phonebook")).rejects.toThrow(
      "outside the monitors API",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url] of fetcher.mock.calls) {
      if (typeof url !== "string")
        throw new Error("Expected an explicit monitor URL");
      expect(new URL(url).searchParams.get("team_name")).toBe("Phonebook");
    }
  });

  it("refuses wrong-team resources and authentication failures", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    fetcher.mockResolvedValueOnce(
      Response.json({
        data: [
          {
            id: "1",
            attributes: { ...uptimeChecks[0], team_name: "Another team" },
          },
        ],
        pagination: { next: null },
      }),
    );
    await expect(existingChecks("private-token", "Phonebook")).rejects.toThrow(
      "another team",
    );
    fetcher.mockResolvedValueOnce(
      new Response("private provider body", { status: 403 }),
    );
    await expect(existingChecks("private-token", "Phonebook")).rejects.toThrow(
      "403",
    );
  });
});
