import * as v from "valibot";

/**
 * A model of GitHub Actions job scheduling for checking every workflow before it runs.
 * It follows GitHub's documented rules: a job waits for its `needs`, a job without `if` uses `success()`, a condition without a status function is joined to `success()`, `success()` requires every ancestor to succeed, and `failure()` holds when any ancestor failed.
 * A skipped ancestor therefore skips a job without a condition even when its own needs succeeded, as release run 41599950592 showed.
 */

export const jobResults = [
  "success",
  "failure",
  "cancelled",
  "skipped",
] as const;
export type JobResult = (typeof jobResults)[number];
const runOutcomes = ["success", "failure", "cancelled"] as const;
/** Bounds the enumeration by count, never by time, so a larger schedule fails the check instead of slowing it. */
const scenarioBound = 1_000_000;
const statusFunctions = ["success", "failure", "cancelled", "always"] as const;
type StatusFunction = (typeof statusFunctions)[number];

type Operand =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "result"; readonly job: string }
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "output"; readonly text: string };

export type Condition =
  | {
      readonly kind: "or" | "and";
      readonly left: Condition;
      readonly right: Condition;
    }
  | { readonly kind: "not"; readonly operand: Condition }
  | { readonly kind: "status"; readonly name: StatusFunction }
  | {
      readonly kind: "compare";
      readonly equal: boolean;
      readonly left: Operand;
      readonly right: Operand;
    }
  | { readonly kind: "input"; readonly name: string }
  | { readonly kind: "atom"; readonly text: string };

const tokenPattern =
  /\s*(?:(?<operator>&&|\|\||==|!=|!|\(|\)|,)|'(?<literal>[^']*)'|(?<word>[A-Za-z_][\w.-]*))/uy;

interface Token {
  readonly kind: "operator" | "literal" | "word";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokens(source: string): readonly Token[] {
  const found: Token[] = [];
  tokenPattern.lastIndex = 0;
  while (tokenPattern.lastIndex < source.length) {
    if (/^\s*$/u.test(source.slice(tokenPattern.lastIndex))) break;
    const start = tokenPattern.lastIndex;
    const match = tokenPattern.exec(source);
    const groups = match?.groups;
    if (!match || !groups)
      throw new Error(`Unrecognized condition text at ${start}: ${source}`);
    const kind =
      groups.operator !== undefined
        ? "operator"
        : groups.literal !== undefined
          ? "literal"
          : "word";
    found.push({
      kind,
      text: groups.operator ?? groups.literal ?? groups.word ?? "",
      start: start + (match[0].length - match[0].trimStart().length),
      end: tokenPattern.lastIndex,
    });
  }
  return found;
}

/** Parses the job condition grammar that the repository's workflows use, and refuses anything else. */
export function parseCondition(raw: string): Condition {
  const source = raw
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/u, "$1")
    .trim();
  const list = tokens(source);
  let index = 0;
  const peek = (): Token | undefined => list[index];
  const take = (text?: string): Token => {
    const token = list[index];
    if (!token || (text !== undefined && token.text !== text))
      throw new Error(
        `Expected ${text ?? "more input"} in condition: ${source}`,
      );
    index += 1;
    return token;
  };
  function operand(token: Token): Operand {
    if (token.kind === "literal") return { kind: "literal", value: token.text };
    if (token.kind !== "word")
      throw new Error(`Unexpected ${token.text} in condition: ${source}`);
    const result = /^needs\.([\w-]+)\.result$/u.exec(token.text);
    if (result?.[1]) return { kind: "result", job: result[1] };
    const input = /^inputs\.([\w-]+)$/u.exec(token.text);
    if (input?.[1]) return { kind: "input", name: input[1] };
    if (/^needs\.[\w-]+\.outputs\.[\w-]+$/u.test(token.text))
      return { kind: "output", text: token.text };
    throw new Error(
      `Unsupported reference ${token.text} in condition: ${source}`,
    );
  }
  function primary(): Condition {
    const token = take();
    if (token.text === "(" && token.kind === "operator") {
      const inner = disjunction();
      take(")");
      return inner;
    }
    if (token.kind === "word" && peek()?.text === "(") {
      const name = token.text;
      if (v.is(v.picklist(statusFunctions), name)) {
        take("(");
        take(")");
        return { kind: "status", name };
      }
      if (name !== "contains")
        throw new Error(`Unsupported function ${name} in condition: ${source}`);
      let depth = 0;
      let end = token.end;
      do {
        const next = take();
        if (next.text === "(") depth += 1;
        if (next.text === ")") depth -= 1;
        end = next.end;
      } while (depth > 0);
      return { kind: "atom", text: source.slice(token.start, end) };
    }
    const left = operand(token);
    const next = peek();
    if (next?.text === "==" || next?.text === "!=") {
      take();
      return {
        kind: "compare",
        equal: next.text === "==",
        left,
        right: operand(take()),
      };
    }
    if (left.kind === "input") return { kind: "input", name: left.name };
    throw new Error(`A bare ${token.text} isn't a condition: ${source}`);
  }
  function unary(): Condition {
    if (peek()?.text === "!") {
      take("!");
      return { kind: "not", operand: unary() };
    }
    return primary();
  }
  function conjunction(): Condition {
    let left = unary();
    while (peek()?.text === "&&") {
      take("&&");
      left = { kind: "and", left, right: unary() };
    }
    return left;
  }
  function disjunction(): Condition {
    let left = conjunction();
    while (peek()?.text === "||") {
      take("||");
      left = { kind: "or", left, right: conjunction() };
    }
    return left;
  }
  const parsed = disjunction();
  if (index !== list.length)
    throw new Error(`Unexpected text after the condition: ${source}`);
  return parsed;
}

function usesStatusFunction(condition: Condition): boolean {
  switch (condition.kind) {
    case "status":
      return true;
    case "not":
      return usesStatusFunction(condition.operand);
    case "or":
    case "and":
      return (
        usesStatusFunction(condition.left) ||
        usesStatusFunction(condition.right)
      );
    default:
      return false;
  }
}

export interface ScheduledJob {
  readonly id: string;
  readonly needs: readonly string[];
  readonly condition: Condition | null;
}

export type InputDomain = Readonly<Record<string, readonly string[]>>;

export interface Scenario {
  readonly inputs: Readonly<Record<string, string>>;
  readonly atoms: Readonly<Record<string, boolean>>;
  readonly results: Readonly<Record<string, JobResult>>;
  /** Whether the run counted as cancelled when GitHub evaluated each job's condition. */
  readonly cancelledBefore: Readonly<Record<string, boolean>>;
}

const JobSchema = v.looseObject({
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  if: v.optional(v.union([v.string(), v.boolean()])),
});
const InputSchema = v.looseObject({
  type: v.optional(v.string()),
  options: v.optional(v.array(v.string())),
});
const WorkflowSchema = v.looseObject({
  on: v.optional(v.unknown()),
  jobs: v.record(v.string(), JobSchema),
});
const DispatchSchema = v.looseObject({
  workflow_dispatch: v.optional(
    v.nullable(
      v.looseObject({
        inputs: v.optional(v.record(v.string(), InputSchema)),
      }),
    ),
  ),
});

export interface WorkflowSchedule {
  readonly jobs: readonly ScheduledJob[];
  readonly inputs: InputDomain;
}

/** Orders jobs so every job follows its needs, and reads the dispatch inputs whose values a condition can compare. */
export function workflowSchedule(document: unknown): WorkflowSchedule {
  const workflow = v.parse(WorkflowSchema, document);
  const known = new Set(Object.keys(workflow.jobs));
  // actionlint refuses a need that names no job, so the model keeps only the needs it can order.
  const declared = Object.entries(workflow.jobs).map(([id, job]) => ({
    id,
    needs: (job.needs === undefined ? [] : [job.needs].flat()).filter((need) =>
      known.has(need),
    ),
    condition:
      job.if === undefined
        ? null
        : parseCondition(typeof job.if === "boolean" ? String(job.if) : job.if),
  }));
  const ordered: ScheduledJob[] = [];
  const placed = new Set<string>();
  while (ordered.length < declared.length) {
    const next = declared.find(
      (job) =>
        !placed.has(job.id) && job.needs.every((need) => placed.has(need)),
    );
    if (!next)
      throw new Error(
        "The workflow's needs form a cycle or name a missing job",
      );
    ordered.push(next);
    placed.add(next.id);
  }
  const triggers = v.safeParse(DispatchSchema, workflow.on);
  const inputs: Record<string, readonly string[]> = {};
  if (triggers.success)
    for (const [name, input] of Object.entries(
      triggers.output.workflow_dispatch?.inputs ?? {},
    )) {
      if (input.type === "choice" && input.options)
        inputs[name] = input.options;
      if (input.type === "boolean") inputs[name] = ["true", "false"];
    }
  return { jobs: ordered, inputs };
}

interface State {
  readonly inputs: Readonly<Record<string, string>>;
  readonly atoms: Readonly<Record<string, boolean>>;
  readonly results: Readonly<Record<string, JobResult>>;
  readonly cancelledBefore: Readonly<Record<string, boolean>>;
}

type Evaluation =
  | { readonly kind: "value"; readonly value: boolean }
  | { readonly kind: "branch"; readonly atom: string };

function ancestors(
  jobs: ReadonlyMap<string, ScheduledJob>,
  id: string,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [...(jobs.get(id)?.needs ?? [])];
  while (pending.length) {
    const next = pending.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(jobs.get(next)?.needs ?? []));
  }
  return seen;
}

function operandValue(
  operand: Operand,
  state: State,
): { readonly known: boolean; readonly value: string } {
  switch (operand.kind) {
    case "literal":
      return { known: true, value: operand.value };
    case "result":
      return { known: true, value: state.results[operand.job] ?? "skipped" };
    case "input": {
      const value = state.inputs[operand.name];
      return value === undefined
        ? { known: false, value: "" }
        : { known: true, value };
    }
    case "output":
      return { known: false, value: "" };
  }
}

function evaluate(
  condition: Condition,
  state: State,
  lineage: ReadonlySet<string>,
  cancelled: boolean,
): Evaluation {
  const value = (result: boolean): Evaluation => ({
    kind: "value",
    value: result,
  });
  switch (condition.kind) {
    case "status": {
      const results = [...lineage].map((job) => state.results[job]);
      if (condition.name === "always") return value(true);
      if (condition.name === "cancelled") return value(cancelled);
      if (condition.name === "failure")
        return value(results.includes("failure"));
      return value(results.every((result) => result === "success"));
    }
    case "input": {
      const input = state.inputs[condition.name];
      if (input === undefined)
        return { kind: "branch", atom: `inputs.${condition.name}` };
      return value(input === "true");
    }
    case "atom": {
      const atom = state.atoms[condition.text];
      return atom === undefined
        ? { kind: "branch", atom: condition.text }
        : value(atom);
    }
    case "compare": {
      const left = operandValue(condition.left, state);
      const right = operandValue(condition.right, state);
      if (!left.known || !right.known) {
        const atom = conditionText(condition);
        const known = state.atoms[atom];
        return known === undefined ? { kind: "branch", atom } : value(known);
      }
      return value((left.value === right.value) === condition.equal);
    }
    case "not": {
      const inner = evaluate(condition.operand, state, lineage, cancelled);
      return inner.kind === "value" ? value(!inner.value) : inner;
    }
    case "and":
    case "or": {
      const left = evaluate(condition.left, state, lineage, cancelled);
      if (left.kind === "branch") return left;
      if (condition.kind === "and" ? !left.value : left.value) return left;
      return evaluate(condition.right, state, lineage, cancelled);
    }
  }
}

function operandText(operand: Operand): string {
  switch (operand.kind) {
    case "literal":
      return `'${operand.value}'`;
    case "result":
      return `needs.${operand.job}.result`;
    case "input":
      return `inputs.${operand.name}`;
    case "output":
      return operand.text;
  }
}

function conditionText(condition: Condition): string {
  switch (condition.kind) {
    case "or":
      return `(${conditionText(condition.left)} || ${conditionText(condition.right)})`;
    case "and":
      return `(${conditionText(condition.left)} && ${conditionText(condition.right)})`;
    case "not":
      return `!${conditionText(condition.operand)}`;
    case "status":
      return `${condition.name}()`;
    case "compare":
      return `${operandText(condition.left)} ${condition.equal ? "==" : "!="} ${operandText(condition.right)}`;
    case "input":
      return `inputs.${condition.name}`;
    case "atom":
      return condition.text;
  }
}

function effectiveCondition(job: ScheduledJob): Condition {
  const success: Condition = { kind: "status", name: "success" };
  if (job.condition === null) return success;
  if (usesStatusFunction(job.condition)) return job.condition;
  return { kind: "and", left: success, right: job.condition };
}

function inputAssignments(
  domain: InputDomain,
): readonly Record<string, string>[] {
  return Object.entries(domain).reduce<readonly Record<string, string>[]>(
    (assignments, [name, values]) =>
      assignments.flatMap((assignment) =>
        values.map((value) => ({ ...assignment, [name]: value })),
      ),
    [{}],
  );
}

/** Visits every dispatch input value, every outcome of every job that runs, and both values of each unknown output predicate. */
export function scenarios(
  schedule: WorkflowSchedule,
  limit = scenarioBound,
): readonly Scenario[] {
  const byId = new Map(schedule.jobs.map((job) => [job.id, job]));
  const lineages = new Map(
    schedule.jobs.map((job) => [job.id, ancestors(byId, job.id)]),
  );
  const found: Scenario[] = [];
  function visit(position: number, state: State): void {
    if (found.length > limit)
      throw new Error("The schedule has more scenarios than its bound");
    const job = schedule.jobs[position];
    if (!job) {
      found.push(state);
      return;
    }
    const cancelled = Object.values(state.results).includes("cancelled");
    const evaluation = evaluate(
      effectiveCondition(job),
      state,
      lineages.get(job.id) ?? new Set(),
      cancelled,
    );
    if (evaluation.kind === "branch") {
      for (const atom of [true, false])
        visit(position, {
          ...state,
          atoms: { ...state.atoms, [evaluation.atom]: atom },
        });
      return;
    }
    const outcomes: readonly JobResult[] = evaluation.value
      ? runOutcomes
      : ["skipped"];
    for (const outcome of outcomes)
      visit(position + 1, {
        ...state,
        results: { ...state.results, [job.id]: outcome },
        cancelledBefore: { ...state.cancelledBefore, [job.id]: cancelled },
      });
  }
  for (const inputs of inputAssignments(schedule.inputs))
    visit(0, { inputs, atoms: {}, results: {}, cancelledBefore: {} });
  return found;
}

/** Follows one run in which every job that runs ends as given, or succeeds by default, and every unknown predicate is true. */
export function followRun(
  schedule: WorkflowSchedule,
  inputs: Readonly<Record<string, string>>,
  outcomes: Readonly<Record<string, Exclude<JobResult, "skipped">>> = {},
  atoms: Readonly<Record<string, boolean>> = {},
): Readonly<Record<string, JobResult>> {
  const matching = scenarios(schedule).filter(
    (scenario) =>
      Object.entries(inputs).every(
        ([name, value]) => scenario.inputs[name] === value,
      ) &&
      Object.entries(scenario.atoms).every(
        ([atom, value]) => value === (atoms[atom] ?? true),
      ) &&
      Object.entries(scenario.results).every(
        ([job, result]) =>
          result === "skipped" || result === (outcomes[job] ?? "success"),
      ),
  );
  const [only, ...others] = matching;
  if (!only || others.length)
    throw new Error("The run doesn't determine one scenario");
  return only.results;
}

const ran = (result: JobResult | undefined): boolean =>
  result !== undefined && result !== "skipped";

export interface ScheduleProperty {
  readonly name: string;
  readonly holds: (scenario: Scenario) => boolean;
}

export interface SchedulePromise {
  readonly inputs: Readonly<Record<string, string>>;
  readonly atoms?: Readonly<Record<string, boolean>>;
  /** The jobs that run when every job that runs succeeds. */
  readonly runs: readonly string[];
}

export interface ScheduleSpecification {
  readonly properties: readonly ScheduleProperty[];
  readonly promises: readonly SchedulePromise[];
}

function requires(
  job: string,
  predecessors: readonly string[],
): ScheduleProperty {
  return {
    name: `${job} runs only after ${predecessors.join(", ")} succeeded`,
    holds: ({ results }) =>
      !ran(results[job]) ||
      predecessors.every((predecessor) => results[predecessor] === "success"),
  };
}

function notAfterCancellation(job: string): ScheduleProperty {
  return {
    name: `${job} doesn't start after a cancellation`,
    holds: ({ results, cancelledBefore }) =>
      !ran(results[job]) || !cancelledBefore[job],
  };
}

/** The behavior that each release-path workflow promises for every input and job result. */
export const scheduleSpecifications: Readonly<
  Record<string, ScheduleSpecification>
> = {
  "release.yml": {
    properties: [
      requires("candidate", ["delivery-checks"]),
      requires("evidence", ["delivery-checks"]),
      requires("build", ["evidence"]),
      requires("stage", ["evidence", "build"]),
      requires("verify", ["stage"]),
      requires("promote", ["evidence", "build", "stage", "verify"]),
      requires("record", ["promote"]),
      {
        name: "withdraw runs exactly when the staged candidate failed or abandoned its checks",
        holds: ({ results }) =>
          ran(results.withdraw) ===
          (results.stage === "success" &&
            (results.verify === "failure" || results.verify === "cancelled")),
      },
      {
        name: "the evidence admission follows a passing or skipped candidate run",
        holds: ({ results }) =>
          !ran(results.evidence) ||
          results.candidate === "success" ||
          results.candidate === "skipped",
      },
      ...["build", "stage", "verify", "promote", "record"].map(
        notAfterCancellation,
      ),
    ],
    promises: [
      {
        inputs: { checks: "run" },
        runs: [
          "delivery-checks",
          "candidate",
          "evidence",
          "build",
          "stage",
          "verify",
          "promote",
          "record",
        ],
      },
      {
        inputs: { checks: "reuse" },
        runs: [
          "delivery-checks",
          "evidence",
          "build",
          "stage",
          "verify",
          "promote",
          "record",
        ],
      },
    ],
  },
  "ios.yml": {
    properties: [
      requires("proofs", ["delivery-checks"]),
      requires("native", ["delivery-checks"]),
      requires("unsigned", ["delivery-checks", "proofs", "native"]),
      requires("signing", ["unsigned"]),
      requires("upload", ["signing"]),
    ],
    promises: [
      {
        inputs: {},
        runs: [
          "delivery-checks",
          "proofs",
          "native",
          "unsigned",
          "signing",
          "upload",
        ],
      },
    ],
  },
  "android.yml": {
    properties: [
      requires("native", ["delivery-checks"]),
      requires("candidate", ["delivery-checks", "native"]),
    ],
    promises: [
      { inputs: {}, runs: ["delivery-checks", "native", "candidate"] },
    ],
  },
  "versions.yml": {
    properties: [requires("proposal", ["delivery-checks"])],
    promises: [
      {
        inputs: { operation: "version-ios" },
        runs: ["delivery-checks", "proposal"],
      },
      {
        inputs: { operation: "version-android" },
        runs: ["delivery-checks", "proposal"],
      },
    ],
  },
  "delivery-checks.yml": {
    properties: [
      requires("fast", ["plan"]),
      requires("proofs", ["plan"]),
      requires("worker", ["plan", "fast"]),
      requires("ios", ["plan", "fast"]),
      requires("android", ["plan", "fast"]),
      {
        name: "the admission gate runs even after failed or skipped prerequisites",
        holds: ({ results }) => ran(results.gate),
      },
    ],
    promises: [
      {
        inputs: {},
        atoms: { "inputs.operation != 'version-ios'": false },
        runs: ["plan", "fast", "gate"],
      },
      {
        inputs: {},
        atoms: { "inputs.operation != 'version-android'": false },
        runs: ["plan", "fast", "gate"],
      },
    ],
  },
  "delivery-credentials.yml": {
    properties: [
      requires("version", ["context"]),
      requires("signing", ["context"]),
      requires("upload", ["context"]),
      requires("preview", ["context"]),
      requires("apply", ["context"]),
      {
        name: "credential transport selects only the requested role",
        holds: ({ inputs, results }) => {
          const roles: Readonly<Record<string, string>> = {
            version: "version-preparation",
            signing: "testflight-signing",
            upload: "testflight-upload",
            preview: "operations-preview",
            apply: "operations-apply",
          };
          return Object.entries(roles).every(
            ([job, target]) => !ran(results[job]) || inputs.target === target,
          );
        },
      },
    ],
    promises: [
      {
        inputs: { target: "version-preparation" },
        runs: ["context", "version"],
      },
      {
        inputs: { target: "testflight-signing" },
        runs: ["context", "signing"],
      },
      { inputs: { target: "testflight-upload" }, runs: ["context", "upload"] },
      {
        inputs: { target: "operations-preview" },
        runs: ["context", "preview"],
      },
      { inputs: { target: "operations-apply" }, runs: ["context", "apply"] },
    ],
  },
  "operations.yml": {
    properties: [
      requires("preview", ["delivery-checks"]),
      requires("apply", ["preview"]),
      {
        name: "only explicit apply operations can write configuration",
        holds: ({ inputs, results }) =>
          !ran(results.apply) ||
          inputs.operation === "cloudflare-alerts-apply" ||
          inputs.operation === "monitors-apply",
      },
    ],
    promises: [
      {
        inputs: { operation: "cloudflare-alerts-preview" },
        runs: ["delivery-checks", "preview"],
      },
      {
        inputs: { operation: "monitors-preview" },
        runs: ["delivery-checks", "preview"],
      },
      {
        inputs: { operation: "cloudflare-alerts-apply" },
        runs: ["delivery-checks", "preview", "apply"],
      },
      {
        inputs: { operation: "monitors-apply" },
        runs: ["delivery-checks", "preview", "apply"],
      },
    ],
  },
  "recover.yml": {
    properties: [
      requires("restore", ["inspect"]),
      {
        name: "withdraw runs only for the withdraw operation",
        holds: ({ inputs, results }) =>
          !ran(results.withdraw) || inputs.operation === "withdraw",
      },
      {
        name: "restore runs only for the restore operation",
        holds: ({ inputs, results }) =>
          !ran(results.restore) || inputs.operation === "restore",
      },
    ],
    promises: [
      { inputs: { operation: "withdraw" }, runs: ["withdraw"] },
      { inputs: { operation: "restore" }, runs: ["inspect", "restore"] },
    ],
  },
  "candidate.yml": {
    properties: [
      ...[
        "check",
        "prove",
        "ios-prove",
        "ios-check",
        "data",
        "parity",
        "e2e",
        "record",
      ].map((job) => requires(job, ["plan"])),
      {
        name: "record runs whenever plan succeeded, so passing stages keep their evidence",
        holds: ({ results }) =>
          results.plan !== "success" || ran(results.record),
      },
    ],
    promises: [
      {
        inputs: {},
        runs: [
          "plan",
          "check",
          "prove",
          "ios-prove",
          "ios-check",
          "data",
          "parity",
          "e2e",
          "record",
        ],
      },
    ],
  },
  "pipeline-controls.yml": {
    properties: [
      requires("drill-build", ["drill-evidence"]),
      requires("drill", ["drill-evidence", "drill-build"]),
    ],
    promises: [
      {
        inputs: {},
        runs: [
          "fakes",
          "foreign-secret",
          "read-only-deploy",
          "drill-evidence",
          "drill-build",
          "drill",
        ],
      },
    ],
  },
};

export interface ScheduleFinding {
  readonly property: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly results: Readonly<Record<string, JobResult>>;
}

/** Checks every property in every scenario, and each promise in its successful run; a finding names one counterexample. */
export function checkSchedule(
  schedule: WorkflowSchedule,
  specification: ScheduleSpecification,
): readonly ScheduleFinding[] {
  const all = scenarios(schedule);
  const findings: ScheduleFinding[] = [];
  for (const property of specification.properties) {
    const counterexample = all.find((scenario) => !property.holds(scenario));
    if (counterexample)
      findings.push({
        property: property.name,
        inputs: counterexample.inputs,
        results: counterexample.results,
      });
  }
  for (const promise of specification.promises) {
    const results = followRun(
      schedule,
      promise.inputs,
      {},
      promise.atoms ?? {},
    );
    const expected = new Set(promise.runs);
    const mismatch = schedule.jobs.some(
      (job) => ran(results[job.id]) !== expected.has(job.id),
    );
    if (mismatch)
      findings.push({
        property: `a successful run with ${JSON.stringify(promise.inputs)} runs ${promise.runs.join(", ")}`,
        inputs: promise.inputs,
        results,
      });
  }
  return findings;
}
