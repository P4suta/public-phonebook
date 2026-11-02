import { describe, expect, it } from "vitest";
import {
  type CloudflareRunner,
  liveWorkerSettings,
} from "../../tools/release-provider.ts";
import {
  candidateWorkerSettings,
  requireUnchangedWorkerSettings,
  runsWorkerFirst,
  type WorkerSettings,
  workerSettingChanges,
} from "../../tools/worker-settings.ts";

const built = {
  name: "dial-production",
  domains: ["www.dial.page"],
  assets: { runWorkerFirst: true },
  workersDev: false,
  previewUrls: false,
  env: {},
};
const live: WorkerSettings = {
  domains: ["www.dial.page"],
  runWorkerFirst: true,
  workersDev: false,
  previewUrls: false,
};

describe("Worker-wide settings", () => {
  it("admits a candidate whose domains, Worker-first routing, and subdomains match the live Worker", () => {
    const candidate = candidateWorkerSettings(built);
    expect(workerSettingChanges(candidate, live)).toEqual([]);
    expect(
      workerSettingChanges(candidate, {
        ...live,
        domains: ["WWW.DIAL.PAGE"],
        runWorkerFirst: ["/*"],
      }),
    ).toEqual([]);
    expect(() => requireUnchangedWorkerSettings(candidate, live)).not.toThrow();
  });

  it("refuses every change that a 0% version can't apply or check", () => {
    for (const [config, expected] of [
      [{ ...built, domains: ["www.dial.page", "dial.page"] }, ["domains"]],
      [{ ...built, assets: { runWorkerFirst: false } }, ["runWorkerFirst"]],
      [
        { ...built, assets: { runWorkerFirst: ["/api/*"] } },
        ["runWorkerFirst"],
      ],
      [{ ...built, assets: {} }, ["runWorkerFirst"]],
      [{ ...built, workersDev: true }, ["workersDev"]],
      [{ ...built, previewUrls: true }, ["previewUrls"]],
      [{ ...built, routes: ["dial.page/*"] }, ["routes"]],
      [{ ...built, triggers: { crons: ["0 0 * * *"] } }, ["crons"]],
    ] as const) {
      const candidate = candidateWorkerSettings(config);
      expect(
        workerSettingChanges(candidate, live),
        JSON.stringify(config),
      ).toEqual(expected);
      expect(() => requireUnchangedWorkerSettings(candidate, live)).toThrow(
        "the owner applies them separately",
      );
    }
    expect(
      workerSettingChanges(candidateWorkerSettings(built), {
        ...live,
        runWorkerFirst: false,
      }),
    ).toEqual(["runWorkerFirst"]);
  });

  it("treats only every path as running the Worker first", () => {
    expect(runsWorkerFirst(true)).toBe(true);
    expect(runsWorkerFirst(["/*"])).toBe(true);
    for (const value of [false, [], ["/api/*"], ["/*", "!/assets/*"]])
      expect(runsWorkerFirst(value), JSON.stringify(value)).toBe(false);
  });

  it("reads the live domains, subdomains, and the serving version's routing from the provider", async () => {
    const calls: string[][] = [];
    const run: CloudflareRunner = async (args) => {
      calls.push([...args]);
      if (args[1] === "get")
        return {
          id: "worker",
          references: {
            domains: [{ id: "domain", hostname: "www.dial.page" }],
          },
          subdomain: { enabled: false, previews_enabled: false },
        };
      return {
        id: "11111111-1111-4111-8111-111111111111",
        assets: { config: { run_worker_first: true } },
        bindings: [],
      };
    };
    expect(
      await liveWorkerSettings(
        "production",
        "11111111-1111-4111-8111-111111111111",
        run,
      ),
    ).toEqual(live);
    expect(calls[0]).toEqual(["workers", "get", "dial-production"]);
    const unreported: CloudflareRunner = async (args) =>
      args[1] === "get"
        ? run(args)
        : { id: "11111111-1111-4111-8111-111111111111", bindings: [] };
    await expect(
      liveWorkerSettings(
        "production",
        "11111111-1111-4111-8111-111111111111",
        unreported,
      ),
    ).rejects.toThrow("reports no Worker-first routing");
    await expect(
      liveWorkerSettings(
        "production",
        "11111111-1111-4111-8111-111111111111",
        async () => ({
          subdomain: {},
        }),
      ),
    ).rejects.toThrow();
  });
});
