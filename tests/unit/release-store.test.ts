import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlStore,
  controlKeys,
  fileControlStore,
  sha256Hex,
} from "@public-phonebook/cloudflare/control-store";
import type { ReleaseJournal } from "@public-phonebook/cloudflare/release-lifecycle";
import {
  type CandidateEvidence,
  candidateEvidenceAdmission,
  candidateSigner,
  candidateStages,
  convertLegacyJournal,
  encodeRecord,
  journalRecord,
  journalWriter,
  loadRelease,
  materializeVerificationDataset,
  type RunProvenance,
  recordCandidateEvidence,
  recordCandidateObservation,
  releaseHistory,
  releaseLock,
  requireCandidateEvidence,
  runProvenance,
  saveRelease,
  storeVerificationDataset,
} from "@public-phonebook/cloudflare/release-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectedStages, passingEvidence } from "./stage-evidence-fixture.ts";

const tree = "1".repeat(40);
const manifest = "3".repeat(64);
const journal: ReleaseJournal = {
  phase: "verified",
  previous: null,
  candidate: {
    releaseId: "11111111-1111-4111-8111-111111111111",
    versionId: "11111111-1111-4111-8111-111111111111",
    databaseId: "22222222-2222-4222-8222-222222222222",
    sourceTree: tree,
    snapshot: "1".repeat(64),
    databaseSha256: "2".repeat(64),
    manifestSha256: manifest,
    artifactSha256: "4".repeat(64),
    manifestBinding: "digest",
  },
};
const actions: RunProvenance = {
  kind: "github-actions",
  repository: "P4suta/public-phonebook",
  workflow: candidateSigner,
  runId: "123",
  runAttempt: 2,
  commit: "5".repeat(40),
  actor: "P4suta",
};

let directory = "";
let store: ControlStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phonebook-journal-"));
  store = fileControlStore(join(directory, "store"), {
    lockedPrefixes: ["journals/production/history/", "evidence/"],
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("run provenance", () => {
  it("records the Actions run or the local owner and rejects incomplete runs", () => {
    expect(runProvenance({})).toEqual({ kind: "local" });
    expect(
      runProvenance({
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: actions.repository,
        GITHUB_WORKFLOW_REF: actions.workflow,
        GITHUB_RUN_ID: actions.runId,
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_SHA: actions.commit,
        GITHUB_ACTOR: actions.actor,
      }),
    ).toEqual(actions);
    expect(() =>
      runProvenance({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "x/y" }),
    ).toThrow();
  });
});

describe("journal format 2", () => {
  it("drops the bundle path and records the sequence, environment, and provenance", async () => {
    expect(await loadRelease(store, "production")).toBeNull();
    const head = await saveRelease(store, "production", journal, actions, null);
    expect(head.record).toEqual({
      formatVersion: 2,
      environment: "production",
      sequence: 1,
      ...journal,
      provenance: actions,
    });
    const loaded = await loadRelease(store, "production");
    expect(loaded?.journal).toEqual(journal);
    expect(loaded?.etag).toBe(head.etag);
    expect(JSON.stringify(loaded?.record)).not.toContain("bundle");
  });

  it("replaces the head conditionally and appends one history record per save", async () => {
    const writer = journalWriter(store, "production", { kind: "local" }, null);
    await writer.save({ ...journal, phase: "preparing" });
    await writer.save({ ...journal, phase: "checking" });
    await writer.save(journal);
    expect(writer.current()?.record.sequence).toBe(3);
    expect(
      (await releaseHistory(store, "production")).map((entry) => entry.phase),
    ).toEqual(["preparing", "checking", "verified"]);
    const stale = await loadRelease(store, "production");
    if (!stale) throw new Error("Missing head");
    await saveRelease(store, "production", journal, actions, stale);
    await expect(
      saveRelease(store, "production", journal, actions, stale),
    ).rejects.toMatchObject({ status: 412 });
  });

  it("restores a history record lost between the head write and the append", async () => {
    const first = await saveRelease(
      store,
      "production",
      journal,
      actions,
      null,
    );
    await rm(
      join(directory, "store", "journals/production/history/000000000001.json"),
    );
    await saveRelease(store, "production", journal, actions, first);
    expect(await releaseHistory(store, "production")).toHaveLength(2);
  });

  it("rejects corrupt, foreign, unsupported, and success-shaped incomplete heads", async () => {
    const key = controlKeys.journalHead("production");
    const valid = journalRecord("production", 1, journal, actions);
    for (const value of [
      { ...valid, formatVersion: 1 },
      { ...valid, environment: "staging" },
      { ...valid, candidate: { ...valid.candidate, versionId: "" } },
      { ...valid, phase: "recovered" },
      { ...valid, candidate: { ...valid.candidate, bundle: "/absolute" } },
      { ...valid, provenance: { kind: "actions" } },
    ]) {
      await rm(join(directory, "store"), { recursive: true, force: true });
      await store.write(key, encodeRecord(value), { kind: "create" });
      await expect(loadRelease(store, "production")).rejects.toThrow();
    }
  });
});

describe("format 1 conversion", () => {
  const legacyTarget = {
    ...journal.candidate,
    bundle: `/home/owner/.local/releases/bundles/${manifest}`,
  };
  const legacy = {
    formatVersion: 1,
    phase: "verified",
    candidate: legacyTarget,
    previous: null,
  };
  const digests = new Map([[manifest, manifest]]);
  const source = {
    environment: "production" as const,
    fileName: `production-${journal.candidate.releaseId}.json`,
    record: legacy,
    manifestDigest: (name: string): string | undefined => digests.get(name),
  };

  it("converts a record whose file name and bundle manifest match", () => {
    expect(convertLegacyJournal(source)).toEqual(journal);
    expect(
      convertLegacyJournal({ ...source, fileName: "production-journal.json" }),
    ).toEqual(journal);
  });

  it("rejects mismatched file names, bundle names, and manifest digests", () => {
    for (const [change, message] of [
      [{ fileName: "staging-journal.json" }, "name doesn't match"],
      [
        { fileName: "production-22222222-2222-4222-8222-222222222222.json" },
        "name doesn't match",
      ],
      [
        {
          record: {
            ...legacy,
            candidate: { ...legacyTarget, bundle: "/x/bundles/other" },
          },
        },
        "bundle name differs",
      ],
      [{ manifestDigest: (): string => "9".repeat(64) }, "manifest differs"],
      [{ manifestDigest: (): undefined => undefined }, "manifest differs"],
      [{ record: { ...legacy, formatVersion: 2 } }, ""],
      [{ record: { ...legacy, candidate: { ...journal.candidate } } }, ""],
    ] as const)
      expect(() => convertLegacyJournal({ ...source, ...change })).toThrow(
        message,
      );
  });
});

describe("verification datasets", () => {
  it("stores the manifest and catalog by digest and restores them after checking the digest", async () => {
    const bundle = join(directory, "bundle");
    await mkdir(bundle);
    await writeFile(join(bundle, "manifest.ready.json"), '{"m":1}');
    await writeFile(join(bundle, "catalog.json"), '{"c":1}');
    const digest = await storeVerificationDataset(store, bundle);
    expect(digest).toBe(sha256Hex(new TextEncoder().encode('{"m":1}')));
    expect(await storeVerificationDataset(store, bundle)).toBe(digest);
    const restored = await materializeVerificationDataset(
      store,
      digest,
      join(directory, "cache"),
    );
    expect(await readFile(join(restored, "catalog.json"), "utf8")).toBe(
      '{"c":1}',
    );
    await writeFile(join(bundle, "catalog.json"), '{"c":2}');
    await expect(storeVerificationDataset(store, bundle)).rejects.toThrow(
      "different bytes",
    );
    await expect(
      materializeVerificationDataset(store, manifest, join(directory, "cache")),
    ).rejects.toThrow("missing");
  });
});

describe("candidate evidence", () => {
  const expected = expectedStages("main", manifest);

  function evidence(
    stage: CandidateEvidence["stage"],
    change: Partial<CandidateEvidence> = {},
  ): CandidateEvidence {
    return {
      ...passingEvidence(stage, expected[stage], actions, tree),
      ...change,
    };
  }

  it("admits complete passing evidence from the candidate workflow", async () => {
    for (const stage of candidateStages)
      await recordCandidateEvidence(store, evidence(stage));
    await requireCandidateEvidence(store, expected);
    expect(
      await recordCandidateEvidence(
        store,
        evidence("e2e", { provenance: { ...actions, runAttempt: 3 } }),
      ),
    ).toBe("unchanged");
    await expect(
      recordCandidateEvidence(store, evidence("e2e", { result: "failed" })),
    ).rejects.toThrow("Only a passing stage");
    await expect(
      recordCandidateEvidence(
        store,
        evidence("e2e", { provenance: { kind: "local" } }),
      ),
    ).rejects.toThrow("Different candidate evidence");
  });

  it("refuses otherwise complete evidence without the national search parity stage", async () => {
    for (const stage of candidateStages)
      if (stage !== "parity")
        await recordCandidateEvidence(store, evidence(stage));
    expect(
      (await candidateEvidenceAdmission(store, expected)).filter(
        (admission) => admission.decision !== "admit",
      ),
    ).toEqual([
      {
        stage: "parity",
        inputsSha256: expected.parity.inputsSha256,
        decision: "missing-stage",
      },
    ]);
    await expect(requireCandidateEvidence(store, expected)).rejects.toThrow(
      "parity missing-stage",
    );
    await recordCandidateEvidence(store, evidence("parity"));
    await requireCandidateEvidence(store, expected);
  });

  it("reuses a stage's evidence when only files outside its inputs change", async () => {
    for (const stage of candidateStages)
      await recordCandidateEvidence(store, evidence(stage));
    const changedPage = {
      ...expectedStages("page-change", manifest),
      "ios-prove": expected["ios-prove"],
      "ios-check": expected["ios-check"],
    };
    expect(
      (await candidateEvidenceAdmission(store, changedPage)).map(
        ({ stage, decision }) => [stage, decision],
      ),
    ).toEqual(
      candidateStages.map((stage) => [
        stage,
        stage.startsWith("ios-") ? "admit" : "missing-stage",
      ]),
    );
  });

  it("keeps a performance observation beside the evidence without deciding admission", async () => {
    const observation = {
      formatVersion: 1 as const,
      name: "search-performance" as const,
      sourceTree: tree,
      manifestSha256: manifest,
      provenance: actions,
      report: { profiles: [] },
    };
    expect(await recordCandidateObservation(store, observation)).toBe(
      "created",
    );
    expect(
      await recordCandidateObservation(store, {
        ...observation,
        report: { profiles: ["rerun"] },
      }),
    ).toBe("unchanged");
    expect(
      (await candidateEvidenceAdmission(store, expected)).every(
        (admission) => admission.decision === "missing-stage",
      ),
    ).toBe(true);
  });

  it("refuses a missing stage, a failed stage, stale inputs, a different manifest, and a different signer", async () => {
    await recordCandidateEvidence(store, evidence("check"));
    await store.write(
      controlKeys.candidate(expected.data.inputsSha256, "data"),
      encodeRecord(evidence("data", { result: "failed" })),
      { kind: "create" },
    );
    await recordCandidateEvidence(
      store,
      evidence("phones", { provenance: { kind: "local" } }),
    );
    await recordCandidateEvidence(
      store,
      evidence("prove", {
        provenance: {
          ...actions,
          workflow:
            "P4suta/public-phonebook/.github/workflows/checks.yml@refs/heads/main",
        },
      }),
    );
    await store.write(
      controlKeys.candidate(expected.e2e.inputsSha256, "e2e"),
      encodeRecord(evidence("e2e", { inputsSha256: "6".repeat(64) })),
      { kind: "create" },
    );
    expect(
      (await candidateEvidenceAdmission(store, expected)).map(
        ({ stage, decision }) => ({ stage, decision }),
      ),
    ).toEqual([
      { stage: "check", decision: "admit" },
      { stage: "data", decision: "failed-stage" },
      { stage: "parity", decision: "missing-stage" },
      { stage: "phones", decision: "different-signer" },
      { stage: "prove", decision: "different-signer" },
      { stage: "e2e", decision: "stale-inputs" },
      { stage: "ios-prove", decision: "missing-stage" },
      { stage: "ios-check", decision: "missing-stage" },
    ]);
    await expect(requireCandidateEvidence(store, expected)).rejects.toThrow(
      "data failed-stage, parity missing-stage, phones different-signer, prove different-signer, e2e stale-inputs, ios-prove missing-stage, ios-check missing-stage",
    );
    const otherDataset = expectedStages("main", "7".repeat(64));
    await store.write(
      controlKeys.candidate(otherDataset.parity.inputsSha256, "parity"),
      encodeRecord(
        evidence("parity", { inputsSha256: otherDataset.parity.inputsSha256 }),
      ),
      { kind: "create" },
    );
    const admissions = await candidateEvidenceAdmission(store, otherDataset);
    expect(
      admissions
        .map(({ stage, decision }) => ({ stage, decision }))
        .slice(0, 3),
    ).toEqual([
      { stage: "check", decision: "admit" },
      { stage: "data", decision: "missing-stage" },
      { stage: "parity", decision: "different-manifest" },
    ]);
  });
});

it("serializes local builds and releases the lock for a later command", async () => {
  const locks = join(directory, "locks");
  const release = await releaseLock("build", locks);
  await expect(releaseLock("build", locks)).rejects.toThrow();
  await release();
  const again = await releaseLock("build", locks);
  await again();
});
