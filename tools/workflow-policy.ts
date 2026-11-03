import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";

export const allowedActions: readonly string[] = [
  "actions/checkout",
  "actions/cache",
  "actions/upload-artifact",
  "actions/download-artifact",
  "dopplerhq/secrets-fetch-action",
  "jdx/mise-action",
  "actions/attest-build-provenance",
  "actions/attest-sbom",
  "actions/attest",
];

export type WorkflowRule =
  | "workflow-permissions-missing"
  | "workflow-permissions-not-empty"
  | "job-permissions-missing"
  | "action-not-pinned"
  | "action-not-allowed"
  | "script-interpolation"
  | "id-token-without-environment"
  | "id-token-outside-dispatch"
  | "change-runner-not-linux"
  | "change-release-check"
  | "gate-not-always"
  | "gate-needs-incomplete"
  | "gate-script-unrecognized"
  | "gate-accepts-unsuccessful"
  | "release-environment-off-main"
  | "production-without-predecessor"
  | "publication-concurrency"
  | "doppler-environment-injection"
  | "doppler-config-mismatch"
  | "skipped-predecessor-unguarded";

export interface WorkflowViolation {
  readonly file: string;
  readonly location: string;
  readonly rule: WorkflowRule;
}

const commitShaLength = 40;
const pinnedRevision = new RegExp(`^[0-9a-f]{${commitShaLength}}$`, "u");
const localReferences = ["./", "$/"];
const repositorySegments = 2;
const expression = /\$\{\{(.*?)\}\}/gsu;
const untrustedContext = /(?<![\w.-])(?:inputs|github\.event)\s*(?:\.|\[)/u;
const workflowDirectory = ".github/workflows";
const actionDirectory = ".github/actions";
const workflowExtension = /\.ya?ml$/u;
const actionFiles = ["action.yml", "action.yaml"];
const credentialTriggers: readonly string[] = [
  "workflow_dispatch",
  "workflow_call",
];

const changeEvents = [
  "pull_request",
  "pull_request_target",
  "merge_group",
  "push",
];
const releaseGateRecipes = ["assurance", "check-build", "prove", "e2e", "test"];
const linuxRunner = /^ubuntu-/u;
const releaseGateCommand = new RegExp(
  `\\bjust\\s+(?:${releaseGateRecipes.join("|")}|ios-[a-z-]+)(?![\\w-])|\\bplaywright\\s+install\\b`,
  "u",
);
const releaseGateWorkflow =
  /^(?:\$|\.)\/\.github\/workflows\/assurance\.ya?ml$/u;

const StepSchema = v.looseObject({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
});
const StepsSchema = v.optional(v.array(StepSchema));
const JobSchema = v.looseObject({
  name: v.optional(v.unknown()),
  permissions: v.optional(v.unknown()),
  environment: v.optional(v.unknown()),
  "runs-on": v.optional(v.unknown()),
  uses: v.optional(v.string()),
  steps: StepsSchema,
});
const WorkflowSchema = v.looseObject({
  on: v.optional(v.unknown()),
  permissions: v.optional(v.unknown()),
  jobs: v.record(v.string(), JobSchema),
});
const IdTokenGrantSchema = v.union([
  v.literal("write-all"),
  v.looseObject({ "id-token": v.literal("write") }),
]);
const NamedEnvironmentSchema = v.union([
  v.pipe(v.string(), v.minLength(1)),
  v.looseObject({ name: v.pipe(v.string(), v.minLength(1)) }),
]);
const TriggerSchema = v.union([
  v.pipe(
    v.string(),
    v.transform((trigger) => [trigger]),
  ),
  v.array(v.string()),
  v.pipe(
    v.record(v.string(), v.unknown()),
    v.transform((triggers) => Object.keys(triggers)),
  ),
]);

function triggerEvents(triggers: unknown): readonly string[] {
  const parsed = v.safeParse(TriggerSchema, triggers);
  return parsed.success ? parsed.output : [];
}

export function startsOnlyByDispatchOrCall(triggers: unknown): boolean {
  const events = triggerEvents(triggers);
  return (
    events.length > 0 &&
    events.every((trigger) => credentialTriggers.includes(trigger))
  );
}
const ActionSchema = v.looseObject({
  runs: v.looseObject({ using: v.string(), steps: StepsSchema }),
});
const EmptyPermissionsSchema = v.strictObject({});

function referenceViolations(
  file: string,
  location: string,
  reference: string,
): readonly WorkflowViolation[] {
  if (localReferences.some((prefix) => reference.startsWith(prefix))) return [];
  const separator = reference.lastIndexOf("@");
  const path = separator < 0 ? reference : reference.slice(0, separator);
  const revision = separator < 0 ? "" : reference.slice(separator + 1);
  const repository = path.split("/").slice(0, repositorySegments).join("/");
  const violations: WorkflowViolation[] = [];
  if (!allowedActions.includes(repository))
    violations.push({ file, location, rule: "action-not-allowed" });
  if (!pinnedRevision.test(revision))
    violations.push({ file, location, rule: "action-not-pinned" });
  return violations;
}

export function interpolatesUntrustedContext(script: string): boolean {
  return [...script.matchAll(expression)].some(([, body]) =>
    untrustedContext.test(body ?? ""),
  );
}

function stepViolations(
  file: string,
  location: string,
  steps: readonly v.InferOutput<typeof StepSchema>[] | undefined,
): readonly WorkflowViolation[] {
  return (steps ?? []).flatMap((step, index) => {
    const stepLocation = `${location}.steps[${index}]`;
    return [
      ...(step.uses === undefined
        ? []
        : referenceViolations(file, stepLocation, step.uses)),
      ...(step.run !== undefined && interpolatesUntrustedContext(step.run)
        ? [
            {
              file,
              location: stepLocation,
              rule: "script-interpolation" as const,
            },
          ]
        : []),
    ];
  });
}

function changeJobViolations(
  file: string,
  location: string,
  job: v.InferOutput<typeof JobSchema>,
): readonly WorkflowViolation[] {
  const violations: WorkflowViolation[] = [];
  const runner = job["runs-on"];
  if (job.uses !== undefined) {
    if (releaseGateWorkflow.test(job.uses))
      violations.push({ file, location, rule: "change-release-check" });
  } else if (typeof runner !== "string" || !linuxRunner.test(runner))
    violations.push({ file, location, rule: "change-runner-not-linux" });
  for (const [index, step] of (job.steps ?? []).entries())
    if (step.run !== undefined && releaseGateCommand.test(step.run))
      violations.push({
        file,
        location: `${location}.steps[${index}]`,
        rule: "change-release-check",
      });
  return violations;
}

export const requiredCheck = "Checks";
export const scopedJobs: readonly string[] = ["rust"];
const successfulResults: readonly string[] = ["success"];
const scopedResults: readonly string[] = ["success", "skipped"];
const jobResults: readonly string[] = [
  "success",
  "failure",
  "cancelled",
  "skipped",
];
const maximumGateAssignments = 65_536;
const gateCondition = /^(?:always\(\)|\$\{\{\s*always\(\)\s*\}\})$/u;
const gateClause =
  /^test "(\$[A-Z][A-Z0-9_]*(?::\$[A-Z][A-Z0-9_]*)*)" = ([a-z]+(?::[a-z]+)*)$/u;
const gateClauseSeparator = " || ";
const needsFact =
  /^\$\{\{\s*needs\.([A-Za-z_][\w-]*)\.(result|outputs\.[A-Za-z_][\w-]*)\s*\}\}$/u;
const resultFact = /^[\w-]+\.result$/u;

const GateStepSchema = v.strictObject({
  name: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  run: v.string(),
});
const GateJobSchema = v.looseObject({
  if: v.optional(v.unknown()),
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  steps: v.optional(v.array(v.unknown())),
});

interface GateClause {
  readonly facts: readonly string[];
  readonly expected: string;
}
type GateLine = readonly GateClause[];

function gateClauseOf(
  clause: string,
  facts: ReadonlyMap<string, string>,
): GateClause | null {
  const [, operand, expected] = gateClause.exec(clause) ?? [];
  if (operand === undefined || expected === undefined) return null;
  const referenced: string[] = [];
  for (const variable of operand.replaceAll("$", "").split(":")) {
    const fact = facts.get(variable);
    if (fact === undefined) return null;
    referenced.push(fact);
  }
  return { facts: referenced, expected };
}

function gateLines(
  step: unknown,
  needs: readonly string[],
): readonly GateLine[] | null {
  const parsed = v.safeParse(GateStepSchema, step);
  if (!parsed.success) return null;
  const facts = new Map<string, string>();
  for (const [variable, value] of Object.entries(parsed.output.env ?? {})) {
    const [, job, property] = needsFact.exec(value) ?? [];
    if (job === undefined || property === undefined || !needs.includes(job))
      return null;
    facts.set(variable, `${job}.${property}`);
  }
  const lines: GateLine[] = [];
  for (const line of parsed.output.run.split("\n").map((text) => text.trim())) {
    if (line === "") continue;
    const clauses = line
      .split(gateClauseSeparator)
      .map((clause) => gateClauseOf(clause, facts));
    if (clauses.includes(null)) return null;
    lines.push(clauses.filter((clause) => clause !== null));
  }
  return lines.length > 0 ? lines : null;
}

function segmentRuns(literal: string): readonly string[] {
  const segments = literal.split(":");
  const runs: string[] = [];
  for (let start = 0; start < segments.length; start += 1)
    for (let end = start + 1; end <= segments.length; end += 1)
      runs.push(segments.slice(start, end).join(":"));
  return runs;
}

/** An output outside every compared literal fails each clause like the empty string does. */
function outputDomain(lines: readonly GateLine[]): readonly string[] {
  return [
    ...new Set([
      "",
      ...lines.flat().flatMap((clause) => segmentRuns(clause.expected)),
    ]),
  ];
}

function gateAssignments(
  facts: readonly string[],
  outputs: readonly string[],
): readonly ReadonlyMap<string, string>[] {
  return facts.reduce<readonly ReadonlyMap<string, string>[]>(
    (assignments, fact) =>
      assignments.flatMap((assignment) =>
        (resultFact.test(fact) ? jobResults : outputs).map(
          (value) => new Map([...assignment, [fact, value]]),
        ),
      ),
    [new Map()],
  );
}

function gatePasses(
  lines: readonly GateLine[],
  assignment: ReadonlyMap<string, string>,
): boolean {
  return lines.every((line) =>
    line.some(
      ({ facts, expected }) =>
        facts.map((fact) => assignment.get(fact)).join(":") === expected,
    ),
  );
}

function gateViolations(
  file: string,
  id: string,
  document: unknown,
  jobs: readonly string[],
  shellDefaults: boolean,
): readonly WorkflowViolation[] {
  const location = `jobs.${id}`;
  const gate = v.parse(GateJobSchema, document);
  const needs = gate.needs === undefined ? [] : [gate.needs].flat();
  const violations: WorkflowViolation[] = [];
  if (typeof gate.if !== "string" || !gateCondition.test(gate.if.trim()))
    violations.push({ file, location, rule: "gate-not-always" });
  if (jobs.some((job) => job !== id && !needs.includes(job)))
    violations.push({ file, location, rule: "gate-needs-incomplete" });
  if (shellDefaults || "defaults" in gate || "continue-on-error" in gate) {
    violations.push({ file, location, rule: "gate-script-unrecognized" });
    return violations;
  }
  const steps = (gate.steps ?? []).map((step) => gateLines(step, needs));
  for (const [index, lines] of steps.entries())
    if (lines === null)
      violations.push({
        file,
        location: `${location}.steps[${index}]`,
        rule: "gate-script-unrecognized",
      });
  if (steps.includes(null)) return violations;
  const lines = steps.filter((step) => step !== null).flat();
  const facts = [
    ...new Set([
      ...needs.map((job) => `${job}.result`),
      ...lines.flat().flatMap((clause) => clause.facts),
    ]),
  ];
  const outputs = outputDomain(lines);
  const assignments = facts.reduce(
    (count, fact) =>
      count * (resultFact.test(fact) ? jobResults : outputs).length,
    1,
  );
  if (assignments > maximumGateAssignments) {
    violations.push({ file, location, rule: "gate-script-unrecognized" });
    return violations;
  }
  const passing = gateAssignments(facts, outputs).filter((assignment) =>
    gatePasses(lines, assignment),
  );
  for (const job of needs) {
    const accepted = scopedJobs.includes(job)
      ? scopedResults
      : successfulResults;
    if (
      passing.some(
        (assignment) =>
          !accepted.includes(assignment.get(`${job}.result`) ?? ""),
      )
    )
      violations.push({
        file,
        location: `${location}.needs.${job}`,
        rule: "gate-accepts-unsuccessful",
      });
  }
  return violations;
}

export const releaseEnvironments: readonly string[] = [
  "candidate",
  "release-candidate",
  "observe",
  "production",
];
const publishingEnvironments: readonly string[] = [
  "release-candidate",
  "production",
];
export const publicationGroup = "publication-production";
const mainBranchGuard = 'test "$GITHUB_REF" = refs/heads/main';
const dopplerAction = "dopplerhq/secrets-fetch-action@";
const dopplerConfigPrefix = "ci_";

const ReleaseStepSchema = v.looseObject({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  "continue-on-error": v.optional(v.unknown()),
});
const ReleaseJobSchema = v.looseObject({
  environment: v.optional(v.unknown()),
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  concurrency: v.optional(v.unknown()),
  steps: v.optional(v.array(ReleaseStepSchema)),
});
const PublicationConcurrencySchema = v.looseObject({
  group: v.literal(publicationGroup),
  "cancel-in-progress": v.literal(false),
});

function environmentName(environment: unknown): string | null {
  if (typeof environment === "string") return environment;
  const named = v.safeParse(v.looseObject({ name: v.string() }), environment);
  return named.success ? named.output.name : null;
}

export function dopplerConfigFor(environment: string): string {
  return `${dopplerConfigPrefix}${environment.replaceAll("-", "_")}`;
}

function releaseJobViolations(
  file: string,
  location: string,
  document: unknown,
): readonly WorkflowViolation[] {
  const job = v.parse(ReleaseJobSchema, document);
  const environment = environmentName(job.environment);
  const steps = job.steps ?? [];
  const violations: WorkflowViolation[] = [];
  if (
    environment !== null &&
    releaseEnvironments.includes(environment) &&
    steps[0]?.run?.trim() !== mainBranchGuard
  )
    violations.push({ file, location, rule: "release-environment-off-main" });
  if (
    environment === "production" &&
    (job.needs === undefined || job.needs.length === 0)
  )
    violations.push({ file, location, rule: "production-without-predecessor" });
  if (
    environment !== null &&
    publishingEnvironments.includes(environment) &&
    !v.is(PublicationConcurrencySchema, job.concurrency)
  )
    violations.push({ file, location, rule: "publication-concurrency" });
  for (const [index, step] of steps.entries()) {
    if (!step.uses?.startsWith(dopplerAction)) continue;
    const stepLocation = `${location}.steps[${index}]`;
    if (step.with?.["inject-env-vars"] !== "false")
      violations.push({
        file,
        location: stepLocation,
        rule: "doppler-environment-injection",
      });
    const refusalControl = step["continue-on-error"] === true;
    if (
      !refusalControl &&
      (environment === null ||
        step.with?.["doppler-config"] !== dopplerConfigFor(environment))
    )
      violations.push({
        file,
        location: stepLocation,
        rule: "doppler-config-mismatch",
      });
  }
  return violations;
}

const ConditionalJobSchema = v.looseObject({
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  if: v.optional(v.unknown()),
});

/**
 * A job without `if` runs only when every earlier job in its chain succeeded, so it skips after a skipped ancestor.
 * When it needs a conditional job that has needs of its own, that job can run after a skipped ancestor while this one silently skips.
 */
function skipPropagationViolations(
  file: string,
  jobs: Readonly<Record<string, unknown>>,
): readonly WorkflowViolation[] {
  const conditions = new Map(
    Object.entries(jobs).map(([id, job]) => {
      const { needs, if: condition } = v.parse(ConditionalJobSchema, job);
      return [
        id,
        {
          needs: needs === undefined ? [] : [needs].flat(),
          conditional: condition !== undefined,
        },
      ];
    }),
  );
  const violations: WorkflowViolation[] = [];
  for (const [id, job] of conditions) {
    if (job.conditional) continue;
    const followsConditionalChain = job.needs.some((need) => {
      const needed = conditions.get(need);
      return needed?.conditional === true && needed.needs.length > 0;
    });
    if (followsConditionalChain)
      violations.push({
        file,
        location: `jobs.${id}`,
        rule: "skipped-predecessor-unguarded",
      });
  }
  return violations;
}

export function workflowViolations(
  file: string,
  document: unknown,
): readonly WorkflowViolation[] {
  const workflow = v.parse(WorkflowSchema, document);
  const runsOnChange = triggerEvents(workflow.on).some((event) =>
    changeEvents.includes(event),
  );
  const violations: WorkflowViolation[] = [];
  if (!("permissions" in workflow))
    violations.push({
      file,
      location: "permissions",
      rule: "workflow-permissions-missing",
    });
  else if (!v.is(EmptyPermissionsSchema, workflow.permissions))
    violations.push({
      file,
      location: "permissions",
      rule: "workflow-permissions-not-empty",
    });
  const credentialJobs = Object.entries(workflow.jobs).filter(([, job]) =>
    v.is(IdTokenGrantSchema, job.permissions),
  );
  if (credentialJobs.length > 0 && !startsOnlyByDispatchOrCall(workflow.on))
    violations.push({
      file,
      location: "on",
      rule: "id-token-outside-dispatch",
    });
  for (const [id, job] of credentialJobs)
    if (
      job.uses === undefined &&
      !v.is(NamedEnvironmentSchema, job.environment)
    )
      violations.push({
        file,
        location: `jobs.${id}`,
        rule: "id-token-without-environment",
      });
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const location = `jobs.${id}`;
    if (!("permissions" in job))
      violations.push({ file, location, rule: "job-permissions-missing" });
    if (job.uses !== undefined)
      violations.push(...referenceViolations(file, location, job.uses));
    violations.push(...stepViolations(file, location, job.steps));
    if (runsOnChange)
      violations.push(...changeJobViolations(file, location, job));
    if (runsOnChange && job.name === requiredCheck)
      violations.push(
        ...gateViolations(
          file,
          id,
          job,
          Object.keys(workflow.jobs),
          "defaults" in workflow,
        ),
      );
    violations.push(...releaseJobViolations(file, location, job));
  }
  violations.push(...skipPropagationViolations(file, workflow.jobs));
  return violations;
}

export function actionViolations(
  file: string,
  document: unknown,
): readonly WorkflowViolation[] {
  return stepViolations(
    file,
    "runs",
    v.parse(ActionSchema, document).runs.steps,
  );
}

async function entries(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).toSorted();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

async function document(path: string): Promise<unknown> {
  const decoded: unknown = parse(await readFile(path, "utf8"));
  return decoded;
}

export interface WorkflowAudit {
  readonly workflows: number;
  readonly actions: number;
  readonly violations: readonly WorkflowViolation[];
}

export async function auditWorkflows(root: string): Promise<WorkflowAudit> {
  const violations: WorkflowViolation[] = [];
  let workflows = 0;
  for (const name of await entries(join(root, workflowDirectory))) {
    if (!workflowExtension.test(name)) continue;
    const file = `${workflowDirectory}/${name}`;
    violations.push(
      ...workflowViolations(file, await document(join(root, file))),
    );
    workflows += 1;
  }
  let actions = 0;
  for (const name of await entries(join(root, actionDirectory))) {
    const present = new Set(await entries(join(root, actionDirectory, name)));
    for (const definition of actionFiles.filter((file) => present.has(file))) {
      const file = `${actionDirectory}/${name}/${definition}`;
      violations.push(
        ...actionViolations(file, await document(join(root, file))),
      );
      actions += 1;
    }
  }
  return { workflows, actions, violations };
}

export async function requireWorkflowPolicy(root: string): Promise<void> {
  const audit = await auditWorkflows(root);
  if (audit.workflows === 0)
    throw new Error("The workflow policy inventory is empty");
  for (const violation of audit.violations)
    console.error(
      `${violation.file}: ${violation.location}: ${violation.rule}`,
    );
  if (audit.violations.length > 0)
    throw new Error("Workflows violate the repository policy");
  console.info(
    JSON.stringify({
      operation: "workflow-policy",
      workflows: audit.workflows,
      actions: audit.actions,
      result: "passed",
    }),
  );
}

if (import.meta.main) await requireWorkflowPolicy(".");
