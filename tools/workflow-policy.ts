import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";

export const allowedActions: readonly string[] = [
  "actions/checkout",
  "actions/cache",
  "actions/upload-artifact",
  "jdx/mise-action",
];

export type WorkflowRule =
  | "workflow-permissions-missing"
  | "workflow-permissions-not-empty"
  | "job-permissions-missing"
  | "action-not-pinned"
  | "action-not-allowed"
  | "script-interpolation";

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

const StepSchema = v.looseObject({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
});
const StepsSchema = v.optional(v.array(StepSchema));
const JobSchema = v.looseObject({
  permissions: v.optional(v.unknown()),
  uses: v.optional(v.string()),
  steps: StepsSchema,
});
const WorkflowSchema = v.looseObject({
  permissions: v.optional(v.unknown()),
  jobs: v.record(v.string(), JobSchema),
});
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
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const location = `jobs.${id}`;
    if (!("permissions" in job))
      violations.push({ file, location, rule: "job-permissions-missing" });
    if (job.uses !== undefined)
      violations.push(...referenceViolations(file, location, job.uses));
    violations.push(...stepViolations(file, location, job.steps));
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
