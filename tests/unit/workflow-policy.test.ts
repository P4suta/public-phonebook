import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { expect, it } from "vitest";
import { parse } from "yaml";
import {
  actionViolations,
  auditWorkflows,
  interpolatesUntrustedContext,
  requireWorkflowPolicy,
  type WorkflowRule,
  workflowViolations,
} from "../../tools/workflow-policy.ts";

const checkout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const commitShaLength = 40;
const imageDigestLength = 64;

function rules(source: string): readonly WorkflowRule[] {
  const document: unknown = parse(source);
  return workflowViolations("fixture.yml", document).map(
    (violation) => violation.rule,
  );
}

function workflow(job: string, permissions = "permissions: {}"): string {
  return `on: pull_request
${permissions}
jobs:
  build:
    runs-on: ubuntu-24.04
${job}`;
}

it("accepts the repository workflows and composite actions", async () => {
  const audit = await auditWorkflows(".");
  expect(audit.violations).toEqual([]);
  expect(audit.workflows).toBeGreaterThanOrEqual(2);
  expect(audit.actions).toBeGreaterThanOrEqual(1);
});

it("accepts empty workflow permissions, granted job permissions, pinned and local actions, and environment indirection", () => {
  expect(
    rules(
      workflow(`    permissions:
      contents: read
    steps:
      - uses: ${checkout}
      - uses: $/.github/actions/toolchain
      - uses: ./.github/actions/toolchain
      - env:
          TITLE: \${{ github.event.pull_request.title }}
          REQUESTED: \${{ inputs.assurance }}
        run: |
          echo "$TITLE $REQUESTED \${{ github.event_name }}"
          echo "\${{ needs.changes.outputs.proofs }} \${{ matrix.runner }} \${{ steps.scope.outputs.inputs }}"`),
    ),
  ).toEqual([]);
  expect(rules(workflow("    permissions: {}\n    steps: []"))).toEqual([]);
});

it("rejects missing and nonempty workflow permissions", () => {
  expect(rules(workflow("    permissions: {}", ""))).toEqual([
    "workflow-permissions-missing",
  ]);
  expect(
    rules(workflow("    permissions: {}", "permissions:\n  contents: read")),
  ).toEqual(["workflow-permissions-not-empty"]);
  expect(
    rules(workflow("    permissions: {}", "permissions: read-all")),
  ).toEqual(["workflow-permissions-not-empty"]);
  expect(rules(workflow("    permissions: {}", "permissions:"))).toEqual([
    "workflow-permissions-not-empty",
  ]);
});

it("rejects a job without explicit permissions", () => {
  expect(rules(workflow("    steps: []"))).toEqual(["job-permissions-missing"]);
});

it("rejects actions pinned to a tag, a branch, an abbreviated SHA, or no revision", () => {
  for (const reference of [
    "actions/checkout@v6",
    "actions/checkout@main",
    "actions/checkout@d23441a",
    "actions/checkout",
    `actions/checkout@${"D".repeat(commitShaLength)}`,
  ])
    expect(
      rules(
        workflow(`    permissions: {}
    steps:
      - uses: ${reference}`),
      ),
    ).toEqual(["action-not-pinned"]);
});

it("rejects actions and reusable workflows outside the allowed list", () => {
  const revision = "0".repeat(commitShaLength);
  for (const reference of [
    `actions/setup-node@${revision}`,
    `actions/checkout-fork/checkout@${revision}`,
    `evil/actions-checkout@${revision}`,
    `docker://alpine@sha256:${"0".repeat(imageDigestLength)}`,
  ])
    expect(
      rules(
        workflow(`    permissions: {}
    steps:
      - uses: ${reference}`),
      ),
    ).toContain("action-not-allowed");
  expect(
    rules(`on: workflow_dispatch
permissions: {}
jobs:
  release:
    permissions: {}
    uses: other/workflows/.github/workflows/release.yml@main`),
  ).toEqual(["action-not-allowed", "action-not-pinned"]);
  expect(
    rules(`on: workflow_dispatch
permissions: {}
jobs:
  release:
    permissions: {}
    uses: $/.github/workflows/release.yml`),
  ).toEqual([]);
});

it("rejects input and event interpolation inside run scripts", () => {
  for (const script of [
    "echo ${{ inputs.assurance }}",
    "echo ${{inputs.assurance}}",
    "echo ${{ github.event.pull_request.title }}",
    "echo ${{ github.event['pull_request'].title }}",
    "echo ${{ toJSON(github.event.inputs) }}",
    "echo ${{ format('{0}', inputs.tools) }}",
    "echo ${{ github.event_name }} ${{\n  inputs.tools\n}}",
  ]) {
    expect(interpolatesUntrustedContext(script)).toBe(true);
    expect(
      rules(
        workflow(`    permissions: {}
    steps:
      - run: ${JSON.stringify(script)}`),
      ),
    ).toEqual(["script-interpolation"]);
  }
  for (const script of [
    "echo ${{ github.event_name }}",
    "echo ${{ needs.inputs.outputs.value }}",
    "echo ${{ steps.event.outputs.inputs }}",
    "echo $INPUTS github.event.inputs",
  ])
    expect(interpolatesUntrustedContext(script)).toBe(false);
});

function changeWorkflow(trigger: string, job: string): string {
  return `on: ${trigger}
permissions: {}
jobs:
  build:
    permissions: {}
${job}`;
}

it("keeps release-gate runners out of change workflows", () => {
  for (const runner of [
    "xcode-27",
    "macos-15",
    "windows-2025",
    "${{ matrix.runner }}",
    "[ubuntu-24.04, xcode-27]",
  ])
    expect(
      rules(
        changeWorkflow(
          "pull_request",
          `    runs-on: ${runner}
    steps: []`,
        ),
      ),
    ).toEqual(["change-runner-not-linux"]);
  expect(
    rules(
      changeWorkflow(
        "pull_request",
        `    runs-on: ubuntu-24.04
    steps: []`,
      ),
    ),
  ).toEqual([]);
});

it("keeps release-gate checks out of change workflows", () => {
  for (const script of [
    "mise x -- just prove",
    "mise x -- just ios-prove",
    "mise x -- just ios-check",
    "mise x -- just assurance",
    "mise x -- just check-build",
    "mise x -- just e2e",
    "mise x -- just test --stage data",
    "mise x -- npm exec --no -- playwright install --with-deps chromium",
  ])
    expect(
      rules(
        workflow(`    permissions: {}
    steps:
      - run: ${JSON.stringify(script)}`),
      ),
    ).toEqual(["change-release-check"]);
  for (const script of [
    "mise x -- just check",
    "mise x -- just check-linux",
    "mise x -- just typecheck",
    "mise x -- just lint",
    "echo prove",
  ])
    expect(
      rules(
        workflow(`    permissions: {}
    steps:
      - run: ${JSON.stringify(script)}`),
      ),
    ).toEqual([]);
  for (const reference of [
    "$/.github/workflows/assurance.yml",
    "./.github/workflows/assurance.yml",
  ])
    expect(
      rules(changeWorkflow("merge_group", `    uses: ${reference}`)),
    ).toEqual(["change-release-check"]);
});

it("applies the change rules to every change trigger form and no other trigger", () => {
  const heavy = `    runs-on: xcode-27
    steps:
      - run: mise x -- just ios-check`;
  for (const trigger of [
    "pull_request",
    "merge_group",
    "push",
    "pull_request_target",
    "[workflow_dispatch, push]",
    "\n  merge_group:\n  workflow_dispatch:",
  ])
    expect(rules(changeWorkflow(trigger, heavy)), trigger).toEqual([
      "change-runner-not-linux",
      "change-release-check",
    ]);
  for (const trigger of [
    "workflow_dispatch",
    "[workflow_dispatch, workflow_call]",
    "\n  workflow_call:\n  workflow_dispatch:",
  ])
    expect(rules(changeWorkflow(trigger, heavy)), trigger).toEqual([]);
});

it("rejects the assurance workflow when a pull request triggers it", async () => {
  const assurance: unknown = parse(
    await readFile(".github/workflows/assurance.yml", "utf8"),
  );
  expect(workflowViolations("assurance.yml", assurance)).toEqual([]);
  const planted = workflowViolations("assurance.yml", {
    ...v.parse(v.looseObject({}), assurance),
    on: "pull_request",
  }).map(({ location, rule }) => `${location} ${rule}`);
  expect(planted).toContain("jobs.native change-runner-not-linux");
  expect(planted).toContain("jobs.native.steps[2] change-release-check");
  expect(planted).toContain("jobs.proofs.steps[2] change-release-check");
  expect(planted).toContain("jobs.build.steps[3] change-release-check");
});

it("applies the step rules to composite actions", () => {
  const document: unknown = parse(`name: Fixture
description: Fixture
runs:
  using: composite
  steps:
    - uses: jdx/mise-action@v4
    - shell: bash
      run: mise install \${{ inputs.tools }}
    - uses: ./.github/actions/other`);
  expect(
    actionViolations("action.yml", document).map(
      ({ location, rule }) => `${location} ${rule}`,
    ),
  ).toEqual([
    "runs.steps[0] action-not-pinned",
    "runs.steps[1] script-interpolation",
  ]);
});

it("reports violations from workflow and action files and rejects an empty inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-workflows-"));
  try {
    await expect(requireWorkflowPolicy(root)).rejects.toThrow(
      "The workflow policy inventory is empty",
    );
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await mkdir(join(root, ".github/actions/setup"), { recursive: true });
    await writeFile(
      join(root, ".github/workflows/build.yml"),
      workflow("    steps: []"),
    );
    await writeFile(
      join(root, ".github/actions/setup/action.yml"),
      "runs:\n  using: composite\n  steps:\n    - uses: actions/cache@v5\n",
    );
    await writeFile(join(root, ".github/workflows/notes.txt"), "ignored");
    const audit = await auditWorkflows(root);
    expect(audit).toEqual({
      workflows: 1,
      actions: 1,
      violations: [
        {
          file: ".github/workflows/build.yml",
          location: "jobs.build",
          rule: "job-permissions-missing",
        },
        {
          file: ".github/actions/setup/action.yml",
          location: "runs.steps[0]",
          rule: "action-not-pinned",
        },
      ],
    });
    await expect(requireWorkflowPolicy(root)).rejects.toThrow(
      "Workflows violate the repository policy",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a workflow document without jobs", () => {
  const document: unknown = parse("on: push\npermissions: {}\n");
  expect(() => workflowViolations("fixture.yml", document)).toThrow();
});
