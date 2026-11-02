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
  | "release-environment-off-main"
  | "production-without-predecessor"
  | "publication-concurrency"
  | "doppler-environment-injection"
  | "doppler-config-mismatch";

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

const StepSchema = v.looseObject({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
});
const StepsSchema = v.optional(v.array(StepSchema));
const JobSchema = v.looseObject({
  permissions: v.optional(v.unknown()),
  environment: v.optional(v.unknown()),
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

export function startsOnlyByDispatchOrCall(triggers: unknown): boolean {
  const parsed = v.safeParse(TriggerSchema, triggers);
  return (
    parsed.success &&
    parsed.output.length > 0 &&
    parsed.output.every((trigger) => credentialTriggers.includes(trigger))
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

export function workflowViolations(
  file: string,
  document: unknown,
): readonly WorkflowViolation[] {
  const workflow = v.parse(WorkflowSchema, document);
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
    violations.push(...releaseJobViolations(file, location, job));
  }
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
