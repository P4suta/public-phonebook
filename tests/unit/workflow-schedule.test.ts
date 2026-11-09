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
    expect(conditions).toBeGreaterThanOrEqual(15);
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

  it("keeps publication skipped after a failed build and successful dependency checks", async () => {
    const schedule = workflowSchedule(parse(await workflowText("release.yml")));
    expect(
      followRun(schedule, { checks: "run" }, { build: "failure" }),
    ).toEqual({
      "delivery-checks": "success",
      candidate: "success",
      evidence: "success",
      build: "failure",
      stage: "skipped",
      verify: "skipped",
      withdraw: "skipped",
      promote: "skipped",
      record: "skipped",
    });
  });

  it("detects the implicit skip regression when the optional candidate job is skipped", async () => {
    let text = await workflowText("release.yml");
    for (const guard of text.match(
      /^ {4}if: \$\{\{ !cancelled\(\) && .*\}\}\n/gmu,
    ) ?? [])
      text = text.replace(guard, "");
    const schedule = workflowSchedule(parse(text));
    expect(followRun(schedule, { checks: "reuse" })).toEqual({
      "delivery-checks": "success",
      candidate: "skipped",
      evidence: "success",
      build: "skipped",
      stage: "skipped",
      verify: "skipped",
      withdraw: "skipped",
      promote: "skipped",
      record: "skipped",
    });
    expect(findings("release.yml", text)).toContain(
      'a successful run with {"checks":"reuse"} runs delivery-checks, evidence, build, stage, verify, promote, record',
    );
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
    for (const failed of ["delivery-checks", "proofs", "native"]) {
      const results = followRun(schedule, {}, { [failed]: "failure" });
      for (const job of ["delivery-checks", "proofs", "native"])
        expect(results[job]).toBe(job === failed ? "failure" : "success");
      for (const job of ["unsigned", "signing", "upload"])
        expect(results[job]).toBe("skipped");
    }
    expect(
      findings(
        "ios.yml",
        planted(
          text,
          "    needs: [delivery-checks, proofs, native]\n",
          "    needs: [proofs, native]\n",
        ),
      ),
    ).toContain(
      "unsigned runs only after delivery-checks, proofs, native succeeded",
    );
  });

  it("finds a planted defect in each release-path workflow", async () => {
    expect(
      findings(
        "delivery-checks.yml",
        planted(
          await workflowText("delivery-checks.yml"),
          "    if: always()\n",
          "",
        ),
      ),
    ).toContain(
      "the admission gate runs even after failed or skipped prerequisites",
    );
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
          "if: ${{ !cancelled() && needs.stage.result == 'success' && needs.verify.result == 'success' }}",
          "if: ${{ always() && needs.stage.result == 'success' }}",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "promote runs only after evidence, build, stage, verify succeeded",
        "promote doesn't start after a cancellation",
      ]),
    );
    expect(
      findings(
        "release.yml",
        planted(
          release,
          "if: always() && needs.stage.result == 'success' && (needs.verify.result == 'failure' || needs.verify.result == 'cancelled')",
          "if: always() && needs.stage.result == 'success'",
        ),
      ),
    ).toContain(
      "withdraw runs exactly when the staged candidate failed or abandoned its checks",
    );
    // Dropping the stage check from withdraw changes nothing, because verify runs only after a staged candidate.
    expect(
      findings(
        "release.yml",
        planted(
          release,
          "if: always() && needs.stage.result == 'success' && (needs.verify.result == 'failure' || needs.verify.result == 'cancelled')",
          "if: always() && (needs.verify.result == 'failure' || needs.verify.result == 'cancelled')",
        ),
      ),
    ).toEqual([]);
    expect(
      findings(
        "recover.yml",
        planted(
          await workflowText("recover.yml"),
          "    if: inputs.operation == 'withdraw'\n",
          "",
        ),
      ),
    ).toContain("withdraw runs only for the withdraw operation");
    expect(
      findings(
        "candidate.yml",
        planted(
          await workflowText("candidate.yml"),
          "if: always() && needs.plan.result == 'success'",
          "if: needs.plan.result == 'success'",
        ),
      ),
    ).toContain(
      "record runs whenever plan succeeded, so passing stages keep their evidence",
    );
    expect(
      findings(
        "pipeline-controls.yml",
        planted(
          await workflowText("pipeline-controls.yml"),
          "    needs: [drill-evidence, drill-build]\n",
          "    needs: [drill-evidence, drill-build]\n    if: always()\n",
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "drill runs only after drill-evidence, drill-build succeeded",
      ]),
    );
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
