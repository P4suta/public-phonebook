import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { candidateSigner, candidateStages } from "../../tools/release-store.ts";
import {
  checkStageScripts,
  observePerformance,
  parityCommand,
  parseTestArguments,
  performanceCommand,
  performanceReport,
  recordingAuthority,
  stageRunner,
} from "../../tools/test.ts";
import {
  readStageReceipt,
  saveStageReceipt,
  stageReceiptPath,
} from "../../tools/verification-receipt.ts";

const tree = "a".repeat(40);
const manifest = "b".repeat(64);

describe("test stages", () => {
  it("runs every stage by default and selected stages in gate order", () => {
    expect(parseTestArguments([])).toEqual({
      bundle: resolve(".local/phonebook"),
      stages: candidateStages,
      record: false,
    });
    expect(
      parseTestArguments([
        "--stage",
        "e2e",
        "--bundle",
        "fixture",
        "--stage",
        "data",
        "--record",
      ]),
    ).toEqual({
      bundle: resolve("fixture"),
      stages: ["data", "e2e"],
      record: true,
    });
    for (const args of [
      ["--stage", "deploy"],
      ["--stage", "e2e", "--stage", "e2e"],
      ["--bundle"],
      ["fixture"],
    ])
      expect(() => parseTestArguments(args), args.join(" ")).toThrow();
    expect(Object.keys(stageRunner("fixture")).sort()).toEqual(
      [...candidateStages].sort(),
    );
  });

  it("compares national search parity on the candidate's bundle and observes performance without a verdict", async () => {
    expect(candidateStages).toContain("parity");
    expect(parityCommand("/data/bundle")).toEqual([
      "tools/search-parity.ts",
      "/data/bundle",
    ]);
    expect(performanceCommand("/data/bundle")).toEqual([
      "tools/search-performance.ts",
      "/data/bundle",
      "--output",
      performanceReport,
    ]);
    const directory = await mkdtemp(join(tmpdir(), "phonebook-observation-"));
    try {
      expect(await observePerformance(join(directory, "missing"))).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the build checks in the candidate check stage", async () => {
    const { scripts } = v.parse(
      v.object({ scripts: v.record(v.string(), v.string()) }),
      JSON.parse(await readFile("package.json", "utf8")),
    );
    expect(checkStageScripts.map((script) => scripts[script])).toEqual([
      "node tools/check.ts",
      "node tools/check-build.ts",
    ]);
  });

  it("records candidate evidence only from a clean Actions run", () => {
    const actions = {
      kind: "github-actions" as const,
      repository: "P4suta/public-phonebook",
      workflow: candidateSigner,
      runId: "9",
      runAttempt: 1,
      commit: tree,
      actor: "P4suta",
    };
    expect(() =>
      recordingAuthority(false, { kind: "local" }, null),
    ).not.toThrow();
    expect(() => recordingAuthority(true, actions, tree)).not.toThrow();
    expect(() => recordingAuthority(true, { kind: "local" }, tree)).toThrow(
      "GitHub Actions",
    );
    expect(() => recordingAuthority(true, actions, null)).toThrow("clean");
  });

  it("writes one receipt per stage under its tree and manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phonebook-stages-"));
    try {
      const path = await saveStageReceipt(
        {
          formatVersion: 1,
          stage: "e2e",
          sourceTree: tree,
          manifestSha256: manifest,
          result: "passed",
          provenance: { kind: "local" },
        },
        directory,
      );
      expect(path).toBe(stageReceiptPath(directory, tree, manifest, "e2e"));
      expect(path).toBe(
        join(directory, "receipts", tree, manifest, "e2e.json"),
      );
      expect(
        (await readStageReceipt(directory, tree, manifest, "e2e")).stage,
      ).toBe("e2e");
      await expect(
        readStageReceipt(directory, tree, manifest, "data"),
      ).rejects.toThrow();
      expect(() =>
        stageReceiptPath(directory, "../escape", manifest, "e2e"),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
