import { describe, expect, it } from "vitest";
import {
  activeVersion,
  type CloudflareRunner,
  deployedVersions,
  deploymentTraffic,
} from "../../tools/release-provider.ts";

const current = "11111111-1111-4111-8111-111111111111";
const candidate = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";

function provider(versions: unknown): {
  run: CloudflareRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    async run(args): Promise<unknown> {
      calls.push([...args]);
      if (args[1] === "deployments")
        return { deployments: [{ id: "deployment", versions }] };
      const id = args[3];
      return {
        id,
        annotations: { "workers/tag": `release-${id}` },
        bindings: [],
      };
    },
  };
}

describe("deployment traffic", () => {
  it("reads the current version at 100% and an optional candidate at 0% in either order", () => {
    expect(
      deploymentTraffic([{ version_id: current, percentage: 100 }]),
    ).toEqual({ current, candidate: null });
    expect(
      deploymentTraffic([
        { version_id: candidate, percentage: 0 },
        { version_id: current, percentage: 100 },
      ]),
    ).toEqual({ current, candidate });
  });

  it("refuses intermediate splits, extra candidates, and deployments without one full version", () => {
    for (const versions of [
      [],
      [
        { version_id: current, percentage: 50 },
        { version_id: candidate, percentage: 50 },
      ],
      [
        { version_id: current, percentage: 100 },
        { version_id: candidate, percentage: 0 },
        { version_id: other, percentage: 0 },
      ],
      [{ version_id: candidate, percentage: 0 }],
      [
        { version_id: current, percentage: 100 },
        { version_id: current, percentage: 0 },
      ],
      [{ version_id: "not-a-uuid", percentage: 100 }],
    ])
      expect(
        () => deploymentTraffic(versions),
        JSON.stringify(versions),
      ).toThrow();
  });
});

describe("deployed versions", () => {
  it("exposes both versions of a 0% candidate deployment with their release tags", async () => {
    const fake = provider([
      { version_id: current, percentage: 100 },
      { version_id: candidate, percentage: 0 },
    ]);
    expect(await deployedVersions("production", fake.run)).toEqual({
      current: { versionId: current, releaseId: `release-${current}` },
      candidate: { versionId: candidate, releaseId: `release-${candidate}` },
    });
    expect(fake.calls[0]).toEqual([
      "workers",
      "deployments",
      "list",
      "--worker",
      "dial-production",
      "--per-page",
      "1",
    ]);
    expect(await activeVersion("production", fake.run)).toEqual({
      versionId: current,
      releaseId: `release-${current}`,
    });
  });

  it("reports no candidate for a single version and refuses an empty deployment list", async () => {
    expect(
      (
        await deployedVersions(
          "production",
          provider([{ version_id: current, percentage: 100 }]).run,
        )
      ).candidate,
    ).toBeNull();
    await expect(
      deployedVersions("production", async () => ({ deployments: [] })),
    ).rejects.toThrow("no active deployment");
  });
});
