import { readdir, readFile } from "node:fs/promises";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  checkSchedule,
  followRun,
  parseCondition,
  scenarios,
  scheduleSpecifications,
  workflowSchedule,
} from "../../tools/workflow-schedule.ts";

const workflows = ".github/workflows";

async function workflowText(name: string): Promise<string> {
  return readFile(`${workflows}/${name}`, "utf8");
}

function findings(name: string, text: string): readonly string[] {
  const specification = scheduleSpecifications[name];
  if (!specification) throw new Error(`No schedule specification for ${name}`);
  return checkSchedule(workflowSchedule(parse(text)), specification).map(
    (finding) => finding.property,
  );
}

function planted(text: string, from: string, to: string): string {
  if (!text.includes(from))
    throw new Error(`The planted defect has no target: ${from}`);
  return text.replace(from, to);
}

describe("workflow schedules", () => {
  it("parses every job condition in the repository's workflows", async () => {
    let conditions = 0;
    for (const name of await readdir(workflows)) {
      const document = v.parse(
        v.object({
          jobs: v.record(
            v.string(),
            v.looseObject({ if: v.optional(v.unknown()) }),
          ),
        }),
        parse(await workflowText(name)),
      );
      for (const job of Object.values(document.jobs)) {
        const condition = job.if;
        if (typeof condition !== "string") continue;
        expect(() => parseCondition(condition), condition).not.toThrow();
        conditions += 1;
      }
    }
    expect(conditions).toBeGreaterThan(0);
  });

  it("refuses conditions outside the supported grammar", () => {
    for (const condition of [
      "github.event_name == 'push'",
      "startsWith(github.ref, 'refs/tags/')",
      "always() &&",
      "(success()",
      "needs.build.result",
      "success() success()",
    ])
      expect(() => parseCondition(condition), condition).toThrow();
  });

  it("keeps publication skipped after a failed build or release check", async () => {
    const schedule = workflowSchedule(parse(await workflowText("release.yml")));
    expect(followRun(schedule, {}, { build: "failure" })).toEqual({
      verify: "success",
      build: "failure",
      deploy: "skipped",
    });
    expect(followRun(schedule, {}, { verify: "failure" })).toEqual({
      verify: "failure",
      build: "skipped",
      deploy: "skipped",
    });
  });

  it("holds every declared property and promise of the release-path workflows", async () => {
    for (const name of Object.keys(scheduleSpecifications)) {
      expect(findings(name, await workflowText(name)), name).toEqual([]);
      expect(
        scenarios(workflowSchedule(parse(await workflowText(name)))).length,
        name,
      ).toBeGreaterThan(1);
    }
  });

  it("runs independent iOS checks while every failed check blocks archive preparation and signing", async () => {
    const text = await workflowText("ios.yml");
    const schedule = workflowSchedule(parse(text));
    for (const failed of ["fast", "proofs", "native"]) {
      const results = followRun(schedule, {}, { [failed]: "failure" });
      for (const job of ["fast", "proofs", "native"])
        expect(results[job]).toBe(job === failed ? "failure" : "success");
      for (const job of ["unsigned", "signing", "upload"])
        expect(results[job]).toBe("skipped");
    }
    expect(
      findings(
        "ios.yml",
        planted(
          text,
          "    needs: [fast, proofs, native]\n",
          "    needs: [proofs, native]\n",
        ),
      ),
    ).toContain("unsigned runs only after fast, proofs, native succeeded");
  });

  it("finds a planted defect in each release-path workflow", async () => {
    expect(
      findings(
        "delivery-credentials.yml",
        planted(
          await workflowText("delivery-credentials.yml"),
          "    if: inputs.target == 'testflight-upload'\n",
          "    if: always()\n",
        ),
      ),
    ).toContain("credential transport selects only the requested role");
    const release = await workflowText("release.yml");
    expect(
      findings(
        "release.yml",
        planted(
          release,
          "    needs: [build]\n",
          "    needs: [build]\n    if: always()\n",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "deploy runs only after verify, build succeeded",
        "deploy doesn't start after a cancellation",
      ]),
    );
    expect(
      findings(
        "recover.yml",
        planted(
          await workflowText("recover.yml"),
          "    needs: [inspect]\n",
          "    needs: [inspect]\n    if: always()\n",
        ),
      ),
    ).toContain("restore runs only after inspect succeeded");
  });

  it("applies the implicit success() and skips after a skipped ancestor", () => {
    const schedule = workflowSchedule(
      parse(`on:
  workflow_dispatch:
    inputs:
      mode:
        type: choice
        options: [a, b]
jobs:
  first:
    if: inputs.mode == 'a'
  second:
    needs: [first]
    if: always()
  third:
    needs: [second]
  fourth:
    needs: [second]
    if: needs.second.result == 'success'
  fifth:
    needs: [second]
    if: failure()
`),
    );
    expect(followRun(schedule, { mode: "b" })).toEqual({
      first: "skipped",
      second: "success",
      third: "skipped",
      fourth: "skipped",
      fifth: "skipped",
    });
    expect(followRun(schedule, { mode: "a" }, { first: "failure" })).toEqual({
      first: "failure",
      second: "success",
      third: "skipped",
      fourth: "skipped",
      fifth: "success",
    });
  });
});
