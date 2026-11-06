import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { expect, it } from "vitest";
import { parse } from "yaml";
import {
  actionViolations,
  auditWorkflows,
  dopplerConfigFor,
  effectConcurrencyGroup,
  interpolatesUntrustedContext,
  releaseEnvironments,
  requireWorkflowPolicy,
  type WorkflowRule,
  workflowViolations,
} from "../../tools/workflow-policy.ts";

const checkout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const commitShaLength = 40;
const imageDigestLength = 64;
const unboundedExtraJobs = 7;

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
    `actions/attest-sbom@${revision}`,
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
    "mise x -- just check-rust",
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

const scopeCheck = 'test "$SCOPE_RESULT" = success';
const verifyCheck = 'test "$VERIFY_RESULT" = success';
const requiredChecks = `${scopeCheck}\n${verifyCheck}`;
const rustCheck =
  'test "$RUST_REQUIRED:$RUST_RESULT" = true:success || test "$RUST_REQUIRED:$RUST_RESULT" = false:skipped';
const boundRustGate = `${requiredChecks}\n${rustCheck}`;
const gateNeeds = "[scope, verify, rust]";

function summaryJob(
  run: string,
  needs = gateNeeds,
  condition = "    if: always()\n",
): string {
  return `${condition}    needs: ${needs}
    steps:
      - name: Require successful verification
        env:
          SCOPE_RESULT: \${{ needs.scope.result }}
          VERIFY_RESULT: \${{ needs.verify.result }}
          RUST_REQUIRED: \${{ needs.scope.outputs.rust }}
          RUST_RESULT: \${{ needs.rust.result }}
        run: ${JSON.stringify(run)}`;
}

function checksWorkflow(summary: string, extraJobs = ""): string {
  return `on:
  pull_request:
  merge_group:
permissions: {}
jobs:
  scope:
    name: Scope
    runs-on: ubuntu-24.04
    permissions: {}
    outputs:
      rust: \${{ steps.scope.outputs.rust }}
    steps: []
  verify:
    name: Verify
    runs-on: ubuntu-24.04
    permissions: {}
    steps: []
  rust:
    name: Rust
    needs: [scope]
    if: needs.scope.outputs.rust == 'true'
    runs-on: ubuntu-24.04
    permissions: {}
    steps: []
${extraJobs}  gate:
    name: Checks
    runs-on: ubuntu-24.04
    permissions: {}
${summary}`;
}

function located(source: string): readonly string[] {
  const document: unknown = parse(source);
  return workflowViolations("fixture.yml", document).map(
    ({ location, rule }) => `${location} ${rule}`,
  );
}

it("admits a Checks job that always runs, needs every job, and accepts a skip only from the rust job", () => {
  expect(located(checksWorkflow(summaryJob(boundRustGate)))).toEqual([]);
  expect(
    located(
      checksWorkflow(
        summaryJob(
          `${requiredChecks}\ntest "$RUST_RESULT" = success || test "$RUST_RESULT" = skipped`,
          "[rust, verify, scope]",
          "    if: ${{ always() }}\n",
        ),
      ),
    ),
  ).toEqual([]);
});

it("rejects a Checks job that skips with a failed job or misses a job", () => {
  expect(
    located(checksWorkflow(summaryJob(boundRustGate, gateNeeds, ""))),
  ).toEqual([
    "jobs.gate gate-not-always",
    "jobs.gate skipped-predecessor-unguarded",
  ]);
  for (const condition of [
    "    if: success()\n",
    '    if: "!cancelled()"\n',
    "    if: always() && needs.verify.result == 'success'\n",
  ])
    expect(
      located(checksWorkflow(summaryJob(boundRustGate, gateNeeds, condition))),
      condition,
    ).toEqual(["jobs.gate gate-not-always"]);
  expect(
    located(
      checksWorkflow(`    if: always()
    needs: verify
    steps:
      - env:
          VERIFY_RESULT: \${{ needs.verify.result }}
        run: ${verifyCheck}`),
    ),
  ).toEqual(["jobs.gate gate-needs-incomplete"]);
});

it("rejects a Checks job that ignores a failed or cancelled rust job", () => {
  for (const run of [
    requiredChecks,
    `${requiredChecks}\ntest "$RUST_RESULT" = success || test "$RUST_RESULT" = failure`,
    `${requiredChecks}\ntest "$RUST_REQUIRED:$RUST_RESULT" = true:success || test "$RUST_REQUIRED:$RUST_RESULT" = true:cancelled`,
    `${requiredChecks}\ntest "$RUST_REQUIRED:$RUST_RESULT" = true:success || test "$RUST_REQUIRED:$RUST_RESULT" = maybe:failure`,
    `${requiredChecks}\ntest "$RUST_RESULT" = success || test "$RUST_REQUIRED" = ignored`,
  ])
    expect(located(checksWorkflow(summaryJob(run))), run).toEqual([
      "jobs.gate.needs.rust gate-accepts-unsuccessful",
    ]);
  expect(
    located(
      checksWorkflow(
        summaryJob(
          `${scopeCheck}\n${verifyCheck} || test "$RUST_RESULT" = success`,
        ),
      ),
    ),
  ).toEqual([
    "jobs.gate.needs.verify gate-accepts-unsuccessful",
    "jobs.gate.needs.rust gate-accepts-unsuccessful",
  ]);
});

it("rejects a Checks job that accepts a skip from any job but rust", () => {
  for (const [job, run] of [
    [
      "verify",
      `${scopeCheck}\n${verifyCheck} || test "$VERIFY_RESULT" = skipped\n${rustCheck}`,
    ],
    [
      "scope",
      `${scopeCheck} || test "$SCOPE_RESULT" = skipped\n${verifyCheck}\n${rustCheck}`,
    ],
  ] as const)
    expect(located(checksWorkflow(summaryJob(run))), run).toEqual([
      `jobs.gate.needs.${job} gate-accepts-unsuccessful`,
    ]);
  expect(
    located(
      checksWorkflow(
        `    if: always()
    needs: [scope, verify, rust, lint]
    steps:
      - env:
          SCOPE_RESULT: \${{ needs.scope.result }}
          VERIFY_RESULT: \${{ needs.verify.result }}
          RUST_REQUIRED: \${{ needs.scope.outputs.rust }}
          RUST_RESULT: \${{ needs.rust.result }}
          LINT_RESULT: \${{ needs.lint.result }}
        run: ${JSON.stringify(`${boundRustGate}\ntest "$LINT_RESULT" = success || test "$LINT_RESULT" = skipped`)}`,
        `  lint:
    needs: [scope]
    if: needs.scope.outputs.rust == 'true'
    runs-on: ubuntu-24.04
    permissions: {}
    steps: []
`,
      ),
    ),
  ).toEqual(["jobs.gate.needs.lint gate-accepts-unsuccessful"]);
});

it("rejects a Checks job whose script or shell the policy can't interpret", () => {
  for (const run of [
    'test "$RUST_RESULT" != failure',
    '[ "$VERIFY_RESULT" = success ]',
    'test "$VERIFY_RESULT" = success && test "$RUST_RESULT" = success',
    'test "$UNDECLARED" = success',
    "true",
    "",
  ])
    expect(located(checksWorkflow(summaryJob(run))), run).toEqual([
      "jobs.gate.steps[0] gate-script-unrecognized",
    ]);
  for (const step of [
    `      - shell: bash {0}
        env:
          VERIFY_RESULT: \${{ needs.verify.result }}
        run: test "$VERIFY_RESULT" = success`,
    `      - continue-on-error: true
        env:
          VERIFY_RESULT: \${{ needs.verify.result }}
        run: test "$VERIFY_RESULT" = success`,
    `      - env:
          VERIFY_RESULT: \${{ github.event_name }}
        run: test "$VERIFY_RESULT" = success`,
    `      - uses: ${checkout}`,
  ])
    expect(
      located(
        checksWorkflow(`    if: always()
    needs: [scope, verify, rust]
    steps:
      - env:
          RUST_REQUIRED: \${{ needs.scope.outputs.rust }}
          RUST_RESULT: \${{ needs.rust.result }}
        run: ${JSON.stringify(rustCheck)}
${step}`),
      ),
      step,
    ).toContain("jobs.gate.steps[1] gate-script-unrecognized");
  for (const setting of [
    "    continue-on-error: true\n",
    "    defaults:\n      run:\n        shell: bash {0}\n",
  ])
    expect(
      located(
        checksWorkflow(`    if: always()
${setting}${summaryJob(boundRustGate, gateNeeds, "")}`),
      ),
      setting,
    ).toEqual(["jobs.gate gate-script-unrecognized"]);
  expect(
    located(
      checksWorkflow(summaryJob(boundRustGate)).replace(
        "permissions: {}\njobs:",
        "permissions: {}\ndefaults:\n  run:\n    shell: bash {0}\njobs:",
      ),
    ),
  ).toEqual(["jobs.gate gate-script-unrecognized"]);
});

it("refuses to evaluate a Checks job with more result combinations than its bound", () => {
  const extra = Array.from(
    { length: unboundedExtraJobs },
    (_, index) => `extra${index}`,
  );
  expect(
    located(
      checksWorkflow(
        summaryJob(boundRustGate, `[scope, verify, rust, ${extra.join(", ")}]`),
        extra
          .map(
            (id) => `  ${id}:
    runs-on: ubuntu-24.04
    permissions: {}
    steps: []
`,
          )
          .join(""),
      ),
    ),
  ).toEqual(["jobs.gate gate-script-unrecognized"]);
});

it("rejects planted gate defects in the repository's Checks workflow", async () => {
  const source = await readFile(".github/workflows/checks.yml", "utf8");
  expect(located(source)).toEqual([]);
  const checks = v.parse(
    v.looseObject({
      jobs: v.looseObject({
        rust: v.looseObject({}),
        gate: v.looseObject({
          needs: v.array(v.string()),
          steps: v.tuple([
            v.looseObject({
              env: v.record(v.string(), v.string()),
              run: v.string(),
            }),
          ]),
        }),
      }),
    }),
    parse(source),
  );
  const { gate } = checks.jobs;
  const [step] = gate.steps;
  function planted(change: object): readonly string[] {
    return workflowViolations("checks.yml", {
      ...checks,
      jobs: { ...checks.jobs, gate: { ...gate, ...change } },
    }).map(({ location, rule }) => `${location} ${rule}`);
  }
  expect(planted({ needs: ["verify"] })).toEqual([
    "jobs.gate gate-needs-incomplete",
    "jobs.gate.steps[0] gate-script-unrecognized",
  ]);
  for (const [variable, job] of [
    ["RUST_RESULT", "rust"],
    ["SCOPE_RESULT", "scope"],
    ["VERIFY_RESULT", "verify"],
  ] as const)
    expect(
      planted({
        steps: [
          {
            ...step,
            run: step.run
              .split("\n")
              .filter((line) => !line.includes(variable))
              .join("\n"),
          },
        ],
      }),
      variable,
    ).toEqual([`jobs.gate.needs.${job} gate-accepts-unsuccessful`]);
  expect(planted({ if: "success()" })).toEqual(["jobs.gate gate-not-always"]);
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

const doppler =
  "dopplerhq/secrets-fetch-action@451892f16195f9ac360e1a5bcbf0b5fd0e957534";
const mainGuard = `      - run: test "$GITHUB_REF" = refs/heads/main`;
const publication = `    concurrency:
      group: publication-production
      cancel-in-progress: false`;

function releaseJob(environment: string, body: string): string {
  return `on: workflow_dispatch
permissions: {}
jobs:
  release:
    runs-on: ubuntu-24.04
    environment: ${environment}
    permissions:
      contents: read
      id-token: write
${body}`;
}

function dopplerStep(config: string, inject = '"false"'): string {
  return `      - uses: ${doppler}
        with:
          auth-method: oidc
          doppler-config: ${config}
          inject-env-vars: ${inject}`;
}

it("admits release jobs that guard the main branch, follow their predecessor, serialize publication, and fetch their own Doppler config", () => {
  expect(dopplerConfigFor("release-candidate")).toBe("ci_release_candidate");
  expect(
    rules(
      releaseJob(
        "release-candidate",
        `${publication}
    steps:
${mainGuard}
${dopplerStep("ci_release_candidate")}`,
      ),
    ),
  ).toEqual([]);
  expect(
    rules(
      releaseJob(
        "production",
        `    needs: [verify]
${publication}
    steps:
${mainGuard}
${dopplerStep("ci_production")}`,
      ),
    ),
  ).toEqual([]);
  expect(
    rules(
      releaseJob(
        "observe",
        `    steps:
${mainGuard}
${dopplerStep("ci_observe")}`,
      ),
    ),
  ).toEqual([]);
  expect(
    rules(
      releaseJob(
        "testflight",
        `    steps:
${dopplerStep("ci_testflight")}`,
      ),
    ),
  ).toEqual([]);
});

it("rejects a release job that runs before it checks the main branch", () => {
  for (const environment of releaseEnvironments)
    expect(
      rules(
        releaseJob(
          environment,
          `    needs: [verify]
${publication.replace("publication-production", effectConcurrencyGroup(environment))}
    steps:
      - uses: ${checkout}
${mainGuard}`,
        ),
      ),
      environment,
    ).toEqual(["release-environment-off-main"]);
});

it("rejects a production job without a preceding job", () => {
  for (const needs of ["", "    needs: []\n"])
    expect(
      rules(
        releaseJob(
          "production",
          `${needs}${publication}
    steps:
${mainGuard}`,
        ),
      ),
    ).toEqual(["production-without-predecessor"]);
});

it("rejects a publishing job outside the shared non-cancelling publication group", () => {
  for (const concurrency of [
    "",
    "    concurrency: publication-production\n",
    "    concurrency:\n      group: release-${{ github.ref }}\n      cancel-in-progress: false\n",
    "    concurrency:\n      group: publication-production\n      cancel-in-progress: true\n",
    "    concurrency:\n      group: publication-production\n",
  ])
    expect(
      rules(
        releaseJob(
          "release-candidate",
          `${concurrency}    steps:
${mainGuard}`,
        ),
      ),
      concurrency,
    ).toEqual(["publication-concurrency"]);
});

it("rejects Doppler secrets injected into the job environment or fetched from another environment's config", () => {
  for (const inject of ['"true"', "true", "false"])
    expect(
      rules(
        releaseJob(
          "observe",
          `    steps:
${mainGuard}
${dopplerStep("ci_observe", inject)}`,
        ),
      ),
      inject,
    ).toEqual(["doppler-environment-injection"]);
  for (const config of ["ci_production", "prd", "ci_release-candidate"])
    expect(
      rules(
        releaseJob(
          "release-candidate",
          `${publication}
    steps:
${mainGuard}
${dopplerStep(config)}`,
        ),
      ),
      config,
    ).toEqual(["doppler-config-mismatch"]);
  expect(
    rules(`on: workflow_dispatch
permissions: {}
jobs:
  status:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
${dopplerStep("ci_observe")}`),
  ).toEqual(["doppler-config-mismatch"]);
});

it("lets only a step that continues on error request another environment's config, as a refusal control", () => {
  expect(
    rules(
      releaseJob(
        "observe",
        `    steps:
${mainGuard}
${dopplerStep("ci_production")}
        continue-on-error: true`,
      ),
    ),
  ).toEqual([]);
  expect(
    rules(
      releaseJob(
        "observe",
        `    steps:
${mainGuard}
${dopplerStep("ci_production", '"true"')}
        continue-on-error: true`,
      ),
    ),
  ).toEqual(["doppler-environment-injection"]);
  expect(
    rules(
      releaseJob(
        "observe",
        `    steps:
${mainGuard}
${dopplerStep("ci_production")}
        continue-on-error: \${{ always() }}`,
      ),
    ),
  ).toEqual(["doppler-config-mismatch"]);
});

it("rejects a job without a condition that needs a conditional job with needs of its own", async () => {
  const dispatch = (jobs: string): string => `on: workflow_dispatch
permissions: {}
jobs:
${jobs}`;
  const optionalChain = `  optional:
    if: inputs.run
    runs-on: ubuntu-24.04
    permissions: {}
  tolerant:
    needs: [optional]
    if: always() && needs.optional.result != 'failure'
    runs-on: ubuntu-24.04
    permissions: {}
`;
  expect(
    rules(
      dispatch(`${optionalChain}  after:
    needs: [tolerant]
    runs-on: ubuntu-24.04
    permissions: {}
`),
    ),
  ).toEqual(["skipped-predecessor-unguarded"]);
  expect(
    rules(
      dispatch(`${optionalChain}  after:
    needs: [tolerant]
    if: "!cancelled() && needs.tolerant.result == 'success'"
    runs-on: ubuntu-24.04
    permissions: {}
`),
    ),
  ).toEqual([]);
  expect(
    rules(
      dispatch(`  inspect:
    if: inputs.restore
    runs-on: ubuntu-24.04
    permissions: {}
  restore:
    needs: [inspect]
    runs-on: ubuntu-24.04
    permissions: {}
`),
    ),
  ).toEqual([]);
  const release = await readFile(".github/workflows/release.yml", "utf8");
  const guard =
    "    if: ${{ !cancelled() && needs.evidence.result == 'success' }}\n";
  expect(release).toContain(guard);
  expect(rules(release.replace(guard, ""))).toEqual([
    "skipped-predecessor-unguarded",
  ]);
});
