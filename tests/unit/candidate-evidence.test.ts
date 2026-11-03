import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  parseEvidenceArguments,
  recordDecision,
  recordingAuthority,
  stageJobs,
} from "../../tools/candidate-evidence.ts";
import { candidateSigner, candidateStages } from "../../tools/release-store.ts";

const dataset = "a".repeat(64);
const tree = "b".repeat(40);

describe("candidate evidence recording", () => {
  it("records each planned stage whose job passed and names the rest", () => {
    expect(
      recordDecision(["check", "data", "phones", "ios-check"], {
        check: "success",
        data: "success",
        "ios-check": "failure",
        e2e: "success",
      }),
    ).toEqual({
      passed: ["check", "data", "phones"],
      unfinished: ["ios-check"],
    });
    expect(recordDecision([], { check: "success" })).toEqual({
      passed: [],
      unfinished: [],
    });
    expect(recordDecision(["e2e"], { e2e: "skipped" })).toEqual({
      passed: [],
      unfinished: ["e2e"],
    });
  });

  it("parses the plan and record commands and refuses unknown values", () => {
    expect(parseEvidenceArguments(["plan", "--dataset", dataset])).toEqual({
      command: "plan",
      dataset,
      missing: [],
      results: {},
    });
    expect(
      parseEvidenceArguments([
        "record",
        "--dataset",
        dataset,
        "--missing",
        '["check","ios-check"]',
        "--result",
        "check=success",
        "--result",
        "ios-check=failure",
      ]),
    ).toEqual({
      command: "record",
      dataset,
      missing: ["check", "ios-check"],
      results: { check: "success", "ios-check": "failure" },
    });
    for (const args of [
      ["plan"],
      ["deploy", "--dataset", dataset],
      ["plan", "--dataset", "short"],
      ["record", "--dataset", dataset, "--missing", '["deploy"]'],
      ["record", "--dataset", dataset, "--result", "deploy=success"],
      ["record", "--dataset", dataset, "--result", "check=green"],
      ["record", "--dataset", dataset, "--result"],
    ])
      expect(() => parseEvidenceArguments(args), args.join(" ")).toThrow();
  });

  it("records evidence only from a clean Actions run", () => {
    const actions = {
      kind: "github-actions" as const,
      repository: "P4suta/public-phonebook",
      workflow: candidateSigner,
      runId: "9",
      runAttempt: 1,
      commit: tree,
      actor: "P4suta",
    };
    expect(() => recordingAuthority(actions, tree)).not.toThrow();
    expect(() => recordingAuthority({ kind: "local" }, tree)).toThrow(
      "GitHub Actions",
    );
    expect(() => recordingAuthority(actions, null)).toThrow("clean");
  });

  it("gives every stage a job in the candidate workflow, which records them after all stage jobs", async () => {
    const workflow = v.parse(
      v.object({
        jobs: v.record(
          v.string(),
          v.looseObject({
            needs: v.optional(v.array(v.string())),
            if: v.optional(v.string()),
          }),
        ),
      }),
      parse(await readFile(".github/workflows/candidate.yml", "utf8")),
    );
    const jobs = new Set(Object.values(stageJobs));
    expect(Object.keys(stageJobs).sort()).toEqual([...candidateStages].sort());
    for (const job of jobs) {
      expect(workflow.jobs[job], job).toBeDefined();
      expect(workflow.jobs[job]?.needs, job).toEqual(["plan"]);
    }
    expect([...(workflow.jobs.record?.needs ?? [])].sort()).toEqual(
      ["plan", ...jobs].sort(),
    );
    expect(workflow.jobs.record?.if).toBe(
      "always() && needs.plan.result == 'success'",
    );
  });
});
