import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePublishArguments,
  publicationAuthority,
} from "../../tools/publish.ts";
import {
  dispatchArguments,
  dispatchedRun,
  releaseWorkflow,
  runListArguments,
  watchArguments,
} from "../../tools/release.ts";
import {
  candidateSigner,
  type RunProvenance,
  releaseSigner,
} from "../../tools/release-store.ts";

const dataset = "a".repeat(64);
const releaseRun: RunProvenance = {
  kind: "github-actions",
  repository: "P4suta/public-phonebook",
  workflow: releaseSigner,
  runId: "42",
  runAttempt: 1,
  commit: "b".repeat(40),
  actor: "P4suta",
};

describe("publish arguments", () => {
  it("requires an explicit dataset for every publication and binds the bundle to it", () => {
    expect(parsePublishArguments(["production", "--dataset", dataset])).toEqual(
      {
        environment: "production",
        action: "publish",
        dataset,
        bundle: resolve(".local/datasets", dataset),
      },
    );
    expect(
      parsePublishArguments([
        "staging",
        "--check-admission",
        "--dataset",
        dataset,
        "--bundle",
        "fixture",
      ]),
    ).toEqual({
      environment: "staging",
      action: "--check-admission",
      dataset,
      bundle: resolve("fixture"),
    });
    for (const action of [
      "publish",
      "--bootstrap",
      "--adopt",
      "--rehearse-recovery",
      "--check-admission",
    ])
      expect(() =>
        parsePublishArguments(
          action === "publish" ? ["staging"] : ["staging", action],
        ),
      ).toThrow("explicit --dataset");
  });

  it("keeps recovery and status free of dataset inputs and rejects unknown or repeated flags", () => {
    expect(parsePublishArguments(["production", "--recover"])).toMatchObject({
      action: "--recover",
      dataset: "",
      bundle: "",
    });
    expect(parsePublishArguments(["staging", "--status"]).action).toBe(
      "--status",
    );
    for (const args of [
      ["production", "--recover", "--dataset", dataset],
      ["development", "--dataset", dataset],
      ["staging", "--dataset", "short"],
      ["staging", "--dataset", dataset, "--dataset", dataset],
      ["staging", "--recover", "--status"],
      ["staging", "--bundle", "fixture"],
      ["staging", ".local/phonebook"],
      [],
    ])
      expect(() => parsePublishArguments(args), args.join(" ")).toThrow();
  });
});

describe("publication authority", () => {
  it("refuses local production publication while keeping local recovery, status, and admission checks", () => {
    for (const action of [
      "publish",
      "--bootstrap",
      "--adopt",
      "--rehearse-recovery",
      "--resume-bootstrap",
    ] as const)
      expect(() =>
        publicationAuthority("production", action, { kind: "local" }),
      ).toThrow("only from the release workflow");
    for (const action of [
      "--recover",
      "--status",
      "--check-admission",
    ] as const)
      expect(() =>
        publicationAuthority("production", action, { kind: "local" }),
      ).not.toThrow();
    expect(() =>
      publicationAuthority("staging", "publish", { kind: "local" }),
    ).not.toThrow();
  });

  it("accepts production only from the release workflow on main", () => {
    expect(() =>
      publicationAuthority("production", "publish", releaseRun),
    ).not.toThrow();
    for (const workflow of [
      candidateSigner,
      "P4suta/public-phonebook/.github/workflows/release.yml@refs/heads/feature",
      "someone/fork/.github/workflows/release.yml@refs/heads/main",
    ])
      expect(() =>
        publicationAuthority("production", "publish", {
          ...releaseRun,
          workflow,
        }),
      ).toThrow(releaseSigner);
  });
});

describe("release dispatch", () => {
  it("dispatches the named release workflow on main with the dataset input", () => {
    expect(releaseWorkflow).toBe("release.yml");
    expect(dispatchArguments(dataset)).toEqual([
      "workflow",
      "run",
      "release.yml",
      "--repo",
      "P4suta/public-phonebook",
      "--ref",
      "main",
      "-f",
      `dataset=${dataset}`,
    ]);
    expect(() => dispatchArguments("main")).toThrow();
    expect(runListArguments("P4suta")).toEqual([
      "run",
      "list",
      "--repo",
      "P4suta/public-phonebook",
      "--workflow",
      "release.yml",
      "--branch",
      "main",
      "--event",
      "workflow_dispatch",
      "--user",
      "P4suta",
      "--limit",
      "20",
      "--json",
      "databaseId,createdAt,url",
    ]);
    expect(watchArguments(7)).toEqual([
      "run",
      "watch",
      "7",
      "--repo",
      "P4suta/public-phonebook",
      "--exit-status",
      "--interval",
      "30",
    ]);
  });

  it("selects the earliest run created after the dispatch and ignores older runs", () => {
    const dispatchedAt = Date.parse("2026-11-01T10:00:00Z");
    const runs = [
      {
        databaseId: 3,
        createdAt: "2026-11-01T10:00:20Z",
        url: "https://github.com/x/y/actions/runs/3",
      },
      {
        databaseId: 2,
        createdAt: "2026-11-01T10:00:05Z",
        url: "https://github.com/x/y/actions/runs/2",
      },
      {
        databaseId: 1,
        createdAt: "2026-11-01T09:30:00Z",
        url: "https://github.com/x/y/actions/runs/1",
      },
    ];
    expect(dispatchedRun(runs, dispatchedAt)?.databaseId).toBe(2);
    expect(dispatchedRun(runs.slice(2), dispatchedAt)).toBeNull();
    expect(() => dispatchedRun([{ databaseId: "x" }], dispatchedAt)).toThrow();
  });
});
