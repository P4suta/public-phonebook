import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function credentialWorkflow(triggers: string, job: string): string {
  return `on: ${triggers}
permissions: {}
jobs:
  store:
    runs-on: ubuntu-24.04
${job}`;
}

const dispatchedCredentialJob = `    environment: data
    permissions:
      contents: read
      id-token: write
    steps: []`;

it("admits an OIDC token only in an environment job of a workflow started by dispatch or call", () => {
  for (const triggers of [
    "workflow_dispatch",
    "[workflow_dispatch]",
    "\n  workflow_dispatch:\n  workflow_call:",
  ])
    expect(
      rules(credentialWorkflow(triggers, dispatchedCredentialJob)),
    ).toEqual([]);
  expect(
    rules(
      credentialWorkflow(
        "workflow_dispatch",
        `    environment:
      name: data
    permissions: write-all
    steps: []`,
      ),
    ),
  ).toEqual([]);
  expect(
    rules(
      credentialWorkflow(
        "workflow_dispatch",
        `    permissions:
      id-token: write
    uses: $/.github/workflows/candidate.yml`,
      ),
    ),
  ).toEqual([]);
  expect(
    rules(`on: pull_request
permissions: {}
jobs:
  build:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      id-token: none
    steps: []`),
  ).toEqual([]);
});

it("rejects an OIDC token in a job without an environment", () => {
  for (const job of [
    "    permissions:\n      id-token: write",
    "    permissions: write-all",
    '    environment: ""\n    permissions:\n      id-token: write',
    "    environment:\n      url: https://example.com\n    permissions: write-all",
  ])
    expect(
      rules(credentialWorkflow("workflow_dispatch", `${job}\n    steps: []`)),
    ).toEqual(["id-token-without-environment"]);
});

it("rejects an OIDC token in a workflow that a push, pull request, or schedule starts", () => {
  for (const triggers of [
    "push",
    "[pull_request, workflow_dispatch]",
    "\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:",
    "[]",
    "{}",
  ])
    expect(
      rules(credentialWorkflow(triggers, dispatchedCredentialJob)),
    ).toEqual(["id-token-outside-dispatch"]);
  expect(
    rules(
      credentialWorkflow(
        "push",
        `    permissions:
      id-token: write
    uses: $/.github/workflows/candidate.yml`,
      ),
    ),
  ).toEqual(["id-token-outside-dispatch"]);
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
