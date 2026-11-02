import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ControlStore,
  fileControlStore,
} from "../../tools/control-store.ts";
import {
  CandidateWithdrawn,
  drillWithdrawal,
  promoteCandidate,
  type ReleasePorts,
  type ReleaseTarget,
  recoverPublication,
  stageCandidate,
  verifiedPredecessor,
  verifyStagedCandidate,
} from "../../tools/release-lifecycle.ts";
import {
  type CloudflareRunner,
  type CloudflareUploader,
  deployAlone,
  deployCandidate,
  deployedVersions,
  restoreVersion,
  uploadVersion,
  verifyVersionBindings,
} from "../../tools/release-provider.ts";
import {
  journalWriter,
  loadRelease,
  releaseHistory,
} from "../../tools/release-store.ts";

const currentId = "11111111-1111-4111-8111-111111111111";
const nextIds = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const previous: ReleaseTarget = {
  releaseId: "44444444-4444-4444-8444-444444444444",
  versionId: currentId,
  sourceTree: "a".repeat(40),
  snapshot: "1".repeat(64),
  databaseSha256: "2".repeat(64),
  databaseId: "55555555-5555-4555-8555-555555555555",
  manifestSha256: "3".repeat(64),
  artifactSha256: "4".repeat(64),
  manifestBinding: "digest",
};
const candidate: ReleaseTarget = {
  ...previous,
  releaseId: "66666666-6666-4666-8666-666666666666",
  versionId: "",
  sourceTree: "b".repeat(40),
  snapshot: "7".repeat(64),
  databaseSha256: "8".repeat(64),
  databaseId: "99999999-9999-4999-8999-999999999999",
  manifestSha256: "9".repeat(64),
};

const TrafficSchema = v.array(
  v.object({ version_id: v.string(), percentage: v.number() }),
);

interface FakeVersion {
  readonly id: string;
  readonly tag: string;
  readonly target: ReleaseTarget;
}

function fakeCloudflare(): {
  run: CloudflareRunner;
  upload: CloudflareUploader;
  traffic: () => readonly { version_id: string; percentage: number }[];
  deployments: () => number;
} {
  const versions: FakeVersion[] = [
    { id: currentId, tag: previous.releaseId, target: previous },
  ];
  let traffic = [{ version_id: currentId, percentage: 100 }];
  let deployments = 0;
  function describe(version: FakeVersion): unknown {
    return {
      id: version.id,
      annotations: { "workers/tag": version.tag },
      assets: { config: { run_worker_first: true } },
      bindings: [
        { name: "DB", type: "d1", id: version.target.databaseId },
        {
          name: "DATASETS",
          type: "r2_bucket",
          bucket_name: "dial-production-datasets",
        },
        { name: "APP_ENV", type: "plain_text", text: "production" },
        {
          name: "PUBLIC_ORIGIN",
          type: "plain_text",
          text: "https://www.dial.page",
        },
        {
          name: "DATASET_MANIFEST_SHA256",
          type: "plain_text",
          text: version.target.manifestSha256,
        },
      ],
    };
  }
  return {
    traffic: () => traffic,
    deployments: () => deployments,
    async upload(args): Promise<void> {
      const tag = args[args.indexOf("--tag") + 1] ?? "";
      const id = nextIds[versions.length - 1];
      if (!id || tag !== candidate.releaseId)
        throw new Error("Unexpected upload");
      versions.push({ id, tag, target: candidate });
    },
    async run(args): Promise<unknown> {
      const [, area, verb, id] = args;
      if (area === "deployments" && verb === "list")
        return { deployments: [{ id: "deployment", versions: traffic }] };
      if (area === "deployments" && verb === "create") {
        deployments += 1;
        traffic = v.parse(
          TrafficSchema,
          JSON.parse(args[args.indexOf("--versions") + 1] ?? "[]"),
        );
        return null;
      }
      const version =
        id === "latest"
          ? versions.at(-1)
          : versions.find((known) => known.id === id);
      if (area === "versions" && verb === "get" && version)
        return describe(version);
      throw new Error(`Unexpected Cloudflare call: ${args.join(" ")}`);
    },
  };
}

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phonebook-drill-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Harness {
  readonly provider: ReturnType<typeof fakeCloudflare>;
  readonly store: ControlStore;
  readonly ports: ReleasePorts;
  readonly checked: string[];
}

async function harness(
  probe: (target: ReleaseTarget) => Promise<void>,
): Promise<Harness> {
  const provider = fakeCloudflare();
  const store = fileControlStore(join(directory, "store"));
  const writer = journalWriter(store, "production", { kind: "local" }, null);
  await writer.save({ candidate: previous, previous: null, phase: "verified" });
  const checked: string[] = [];
  const ports: ReleasePorts = {
    save: (journal) => writer.save(journal),
    deployed: () => deployedVersions("production", provider.run),
    async prepare(): Promise<void> {},
    async stage(target, current): Promise<void> {
      const versionId = await uploadVersion(
        "production",
        target,
        provider.run,
        provider.upload,
      );
      await verifyVersionBindings(
        "production",
        { ...target, versionId },
        provider.run,
      );
      await deployCandidate(
        "production",
        current.versionId,
        versionId,
        provider.run,
      );
    },
    withdraw: (current) =>
      deployAlone("production", current.versionId, provider.run),
    activate: (target) =>
      deployAlone("production", target.versionId, provider.run),
    restore: (target) => restoreVersion("production", target, provider.run),
    async verifyCandidate(target): Promise<void> {
      await verifyVersionBindings("production", target, provider.run);
      checked.push(`override:${target.versionId}`);
      await probe(target);
    },
    async verify(target, evidence): Promise<void> {
      await verifyVersionBindings("production", target, provider.run);
      checked.push(`${evidence}:${target.versionId}`);
    },
  };
  return { provider, store, ports, checked };
}

describe("withdrawal drill through the provider adapter", () => {
  it("deploys the next candidate at 0%, injects a probe failure, and leaves production and the verified predecessor unchanged", async () => {
    const { provider, store, ports, checked } = await harness(async () => {});
    const withdrawn = await drillWithdrawal(candidate, previous, ports);
    expect(withdrawn.phase).toBe("withdrawn");
    expect(provider.traffic()).toEqual([
      { version_id: currentId, percentage: 100 },
    ]);
    expect(provider.deployments()).toBe(2);
    expect(checked).toEqual([`override:${nextIds[0]}`]);
    const head = await loadRelease(store, "production");
    expect(verifiedPredecessor(head?.journal ?? null)).toEqual(previous);
    expect(
      (await releaseHistory(store, "production")).map(
        (journal) => journal.phase,
      ),
    ).toEqual(["verified", "preparing", "staged", "withdrawing", "withdrawn"]);
  });

  it("withdraws a candidate whose probe reports another version", async () => {
    const { provider, ports } = await harness(async () => {
      throw new Error("A public response came from another Worker version");
    });
    const staged = await stageCandidate(candidate, previous, ports);
    expect(provider.traffic()).toEqual([
      { version_id: currentId, percentage: 100 },
      { version_id: nextIds[0], percentage: 0 },
    ]);
    await expect(verifyStagedCandidate(staged, ports)).rejects.toBeInstanceOf(
      CandidateWithdrawn,
    );
    expect(provider.traffic()).toEqual([
      { version_id: currentId, percentage: 100 },
    ]);
  });

  it("promotes in one step and rolls back to the predecessor when the post-release check fails", async () => {
    const { provider, store, ports, checked } = await harness(async () => {});
    const verified = await verifyStagedCandidate(
      await stageCandidate(candidate, previous, ports),
      ports,
    );
    const failing: ReleasePorts = {
      ...ports,
      async verify(target, evidence): Promise<void> {
        await ports.verify(target, evidence);
        if (target.releaseId === candidate.releaseId)
          throw new Error("post-release check failed");
      },
    };
    await expect(
      promoteCandidate(verified, candidate.releaseId, failing),
    ).rejects.toThrow("verified predecessor was restored");
    expect(provider.traffic()).toEqual([
      { version_id: currentId, percentage: 100 },
    ]);
    expect(checked).toEqual([
      `override:${nextIds[0]}`,
      `required:${nextIds[0]}`,
      `optional:${currentId}`,
    ]);
    const head = await loadRelease(store, "production");
    expect(head?.journal.phase).toBe("recovered");
    expect(
      (await recoverPublication(head?.journal ?? verified, ports)).phase,
    ).toBe("recovered");
  });
});
