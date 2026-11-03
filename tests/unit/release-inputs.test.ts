import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileControlStore } from "../../tools/control-store.ts";
import {
  exportOutputs,
  maskCandidate,
  parsePublishArguments,
  publicationAuthority,
  publicDeployment,
  publicJournal,
} from "../../tools/publish.ts";
import {
  dispatchArguments,
  dispatchedRun,
  releaseWorkflow,
  runListArguments,
  watchArguments,
} from "../../tools/release.ts";
import type { ReleaseJournal } from "../../tools/release-lifecycle.ts";
import {
  candidateEvidenceAdmission,
  candidateSigner,
  candidateStages,
  controlsSigner,
  evidenceSigners,
  type RunProvenance,
  recordCandidateEvidence,
  releaseSigner,
  requireCandidateEvidence,
} from "../../tools/release-store.ts";
import { expectedStages, passingEvidence } from "./stage-evidence-fixture.ts";

const dataset = "a".repeat(64);
const release = "11111111-1111-4111-8111-111111111111";
const candidateVersion = "22222222-2222-4222-8222-222222222222";
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
        release: "",
        artifact: "",
      },
    );
    expect(
      parsePublishArguments([
        "production",
        "--check-admission",
        "--dataset",
        dataset,
        "--bundle",
        "fixture",
      ]),
    ).toEqual({
      environment: "production",
      action: "--check-admission",
      dataset,
      bundle: resolve("fixture"),
      release: "",
      artifact: "",
    });
    for (const action of [
      "publish",
      "--stage",
      "--drill",
      "--adopt",
      "--check-admission",
      "--check-evidence",
    ])
      expect(() =>
        parsePublishArguments(
          action === "publish" ? ["production"] : ["production", action],
        ),
      ).toThrow("explicit --dataset");
  });

  it("binds promotion to the approved release and keeps the other steps free of dataset inputs", () => {
    expect(
      parsePublishArguments(["production", "--promote", "--release", release]),
    ).toMatchObject({ action: "--promote", release, dataset: "" });
    expect(() => parsePublishArguments(["production", "--promote"])).toThrow(
      "approved --release",
    );
    for (const action of [
      "--verify-candidate",
      "--withdraw",
      "--recover",
      "--status",
    ])
      expect(parsePublishArguments(["production", action])).toMatchObject({
        action,
        dataset: "",
        bundle: "",
        release: "",
      });
    for (const args of [
      ["production", "--recover", "--dataset", dataset],
      ["production", "--withdraw", "--release", release],
      ["production", "--promote", "--release", "not-a-release"],
      ["production", "--promote", "--release", release, "--release", release],
      ["development", "--dataset", dataset],
      ["staging", "--dataset", dataset],
      ["production", "--bootstrap", "--dataset", dataset],
      ["production", "--rehearse-recovery", "--dataset", dataset],
      ["production", "--dataset", "short"],
      ["production", "--dataset", dataset, "--dataset", dataset],
      ["production", "--recover", "--status"],
      ["production", "--bundle", "fixture"],
      ["production", ".local/phonebook"],
      [],
    ])
      expect(() => parsePublishArguments(args), args.join(" ")).toThrow();
  });

  it("stages only a prebuilt Worker named by its build digest", () => {
    const artifact = "c".repeat(64);
    for (const action of ["--stage", "--drill"])
      expect(
        parsePublishArguments([
          "production",
          action,
          "--dataset",
          dataset,
          "--artifact",
          artifact,
        ]),
      ).toMatchObject({ action, artifact });
    for (const args of [
      [
        "production",
        "--check-admission",
        "--dataset",
        dataset,
        "--artifact",
        artifact,
      ],
      [
        "production",
        "--check-evidence",
        "--dataset",
        dataset,
        "--artifact",
        artifact,
      ],
      ["production", "--withdraw", "--artifact", artifact],
      ["production", "--stage", "--dataset", dataset, "--artifact", "short"],
      [
        "production",
        "--stage",
        "--dataset",
        dataset,
        "--artifact",
        artifact,
        "--artifact",
        artifact,
      ],
    ])
      expect(() => parsePublishArguments(args), args.join(" ")).toThrow();
  });
});

describe("workflow outputs", () => {
  it("appends the named outputs for the next job and writes nothing outside Actions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phonebook-outputs-"));
    try {
      const file = join(directory, "output");
      await writeFile(file, "earlier=1\n");
      await exportOutputs({ "release-id": release }, { GITHUB_OUTPUT: file });
      expect(await readFile(file, "utf8")).toBe(
        `earlier=1\nrelease-id=${release}\n`,
      );
      await exportOutputs({ "release-id": release }, {});
      expect(await readFile(file, "utf8")).toBe(
        `earlier=1\nrelease-id=${release}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("candidate evidence signers", () => {
  it("admits evidence from the candidate workflow or the release workflow that calls it on main, and nothing else", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phonebook-evidence-"));
    try {
      const store = fileControlStore(join(directory, "store"));
      const expected = expectedStages("main", dataset);
      expect(evidenceSigners).toEqual([candidateSigner, releaseSigner]);
      for (const [index, stage] of candidateStages.entries())
        await recordCandidateEvidence(
          store,
          passingEvidence(stage, expected[stage], {
            ...releaseRun,
            workflow: index % 2 ? candidateSigner : releaseSigner,
          }),
        );
      await expect(
        requireCandidateEvidence(store, expected),
      ).resolves.toBeUndefined();
      expect(
        (
          await candidateEvidenceAdmission(store, expected, [candidateSigner])
        ).map((admission) => admission.decision),
      ).toEqual(
        candidateStages.map((_, index) =>
          index % 2 ? "admit" : "different-signer",
        ),
      );
      const forked = expectedStages("feature", dataset);
      await recordCandidateEvidence(
        store,
        passingEvidence("check", forked.check, {
          ...releaseRun,
          workflow:
            "P4suta/public-phonebook/.github/workflows/release.yml@refs/heads/feature",
        }),
      );
      expect(
        (await candidateEvidenceAdmission(store, forked))[0]?.decision,
      ).toBe("different-signer");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("candidate masking", () => {
  const journal: ReleaseJournal = {
    phase: "candidate-verified",
    candidate: {
      releaseId: release,
      versionId: candidateVersion,
      sourceTree: "c".repeat(40),
      snapshot: "1".repeat(64),
      databaseSha256: "2".repeat(64),
      databaseId: "33333333-3333-4333-8333-333333333333",
      manifestSha256: dataset,
      artifactSha256: "4".repeat(64),
      manifestBinding: "digest",
    },
    previous: null,
  };

  it("masks the version of a candidate that never took traffic in Actions logs and status output", () => {
    const lines: string[] = [];
    maskCandidate(journal, releaseRun, (line) => lines.push(line));
    maskCandidate(journal, { kind: "local" }, (line) => lines.push(line));
    maskCandidate({ ...journal, phase: "verified" }, releaseRun, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual([`::add-mask::${candidateVersion}`]);
    for (const phase of [
      "staged",
      "candidate-verified",
      "withdrawing",
      "withdrawn",
    ] as const)
      expect(
        JSON.stringify(publicJournal({ ...journal, phase })),
        phase,
      ).not.toContain(candidateVersion);
    expect(
      publicJournal({ ...journal, phase: "verified" })?.candidate.versionId,
    ).toBe(candidateVersion);
    expect(
      JSON.stringify(
        publicDeployment({
          current: { versionId: release, releaseId: release },
          candidate: { versionId: candidateVersion, releaseId: release },
        }),
      ),
    ).not.toContain(candidateVersion);
  });
});

describe("publication authority", () => {
  it("refuses local production publication while keeping local withdrawal, recovery, status, and admission checks", () => {
    for (const action of [
      "publish",
      "--stage",
      "--verify-candidate",
      "--promote",
      "--drill",
      "--adopt",
    ] as const)
      expect(() =>
        publicationAuthority("production", action, { kind: "local" }),
      ).toThrow("only from the release workflow");
    for (const action of [
      "--withdraw",
      "--recover",
      "--status",
      "--check-admission",
    ] as const)
      expect(() =>
        publicationAuthority("production", action, { kind: "local" }),
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

  it("lets the pipeline controls run only the withdrawal drill", () => {
    const controlsRun: RunProvenance = {
      ...releaseRun,
      workflow: controlsSigner,
    };
    expect(controlsSigner).toBe(
      "P4suta/public-phonebook/.github/workflows/pipeline-controls.yml@refs/heads/main",
    );
    expect(() =>
      publicationAuthority("production", "--drill", controlsRun),
    ).not.toThrow();
    for (const action of [
      "publish",
      "--stage",
      "--verify-candidate",
      "--promote",
      "--adopt",
    ] as const)
      expect(() =>
        publicationAuthority("production", action, controlsRun),
      ).toThrow(releaseSigner);
    expect(() =>
      publicationAuthority("production", "--drill", {
        ...controlsRun,
        workflow: controlsSigner.replace("refs/heads/main", "refs/heads/x"),
      }),
    ).toThrow(releaseSigner);
    expect(
      parsePublishArguments(["production", "--build-digest"]),
    ).toMatchObject({ action: "--build-digest", dataset: "", artifact: "" });
    expect(() =>
      parsePublishArguments([
        "production",
        "--build-digest",
        "--dataset",
        dataset,
      ]),
    ).toThrow("takes no dataset");
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
