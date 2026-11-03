import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { localBundle, localBundleVariable } from "../../tools/local-bundle.ts";
import { candidateStages } from "../../tools/release-store.ts";
import {
  checkStageScripts,
  e2eEnvironment,
  observePerformance,
  parityCommand,
  parseTestArguments,
  performanceCommand,
  performanceReport,
  stageRunner,
} from "../../tools/test.ts";
import {
  readStageReceipt,
  saveStageReceipt,
  stageReceiptPath,
} from "../../tools/verification-receipt.ts";

const tree = "a".repeat(40);
const manifest = "b".repeat(64);
const inputs = "c".repeat(64);

describe("test stages", () => {
  it("runs every stage by default and selected stages in gate order", () => {
    expect(parseTestArguments([])).toEqual({
      bundle: resolve(".local/phonebook"),
      stages: candidateStages,
    });
    expect(
      parseTestArguments([
        "--stage",
        "ios-check",
        "--stage",
        "e2e",
        "--bundle",
        "fixture",
        "--stage",
        "data",
      ]),
    ).toEqual({
      bundle: resolve("fixture"),
      stages: ["data", "e2e", "ios-check"],
    });
    for (const args of [
      ["--stage", "deploy"],
      ["--stage", "e2e", "--stage", "e2e"],
      ["--bundle"],
      ["--record"],
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

  it("tells the e2e checks which bundle the local state serves", () => {
    expect(e2eEnvironment("/data/bundle", { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      [localBundleVariable]: "/data/bundle",
    });
    expect(localBundle({})).toBe(resolve(".local/phonebook"));
    expect(localBundle({ [localBundleVariable]: "/data/bundle" })).toBe(
      "/data/bundle",
    );
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

  it("runs the iOS stages through the same native check tool as `just`", async () => {
    const justfile = await readFile("justfile", "utf8");
    for (const [stage, command] of [
      ["ios-prove", "prove"],
      ["ios-check", "check"],
    ] as const) {
      expect(candidateStages).toContain(stage);
      expect(justfile).toContain(
        `${stage}:\n    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- ${command}\n`,
      );
    }
  });

  it("writes one receipt per stage under the digest of its inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phonebook-stages-"));
    try {
      const path = await saveStageReceipt(
        {
          formatVersion: 2,
          stage: "e2e",
          inputsSha256: inputs,
          manifestSha256: manifest,
          sourceTree: tree,
          result: "passed",
          provenance: { kind: "local" },
        },
        directory,
      );
      expect(path).toBe(stageReceiptPath(directory, inputs, "e2e"));
      expect(path).toBe(join(directory, "receipts", inputs, "e2e.json"));
      expect((await readStageReceipt(directory, inputs, "e2e")).stage).toBe(
        "e2e",
      );
      await expect(
        readStageReceipt(directory, inputs, "data"),
      ).rejects.toThrow();
      expect(() => stageReceiptPath(directory, "../escape", "e2e")).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
