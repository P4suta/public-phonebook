import * as v from "valibot";
import { referenceRequestDecision } from "./reference-request-policy.ts";

/** The search key that names the operation a reference request form submits. */
export const operationSearchKey = "operation";
const dotSegments: readonly string[] = [".", ".."];
const pathTemplate = /\{([^{}]+)\}/gu;

const ExampleValueSchema = v.union([v.string(), v.number()]);
const ParameterSchema = v.object({
  name: v.string(),
  in: v.picklist(["query", "path"]),
  required: v.optional(v.boolean()),
  description: v.optional(v.string()),
  example: v.optional(ExampleValueSchema),
  schema: v.optional(
    v.object({
      type: v.optional(v.string()),
      format: v.optional(v.string()),
      enum: v.optional(v.array(v.string())),
      pattern: v.optional(v.string()),
      minimum: v.optional(v.number()),
      maximum: v.optional(v.number()),
      maxLength: v.optional(v.number()),
      default: v.optional(ExampleValueSchema),
    }),
  ),
});
const OperationSchema = v.object({
  operationId: v.string(),
  tags: v.optional(v.array(v.string())),
  summary: v.string(),
  description: v.optional(v.string()),
  parameters: v.optional(v.array(ParameterSchema)),
  responses: v.record(
    v.string(),
    v.object({
      description: v.string(),
      content: v.optional(v.record(v.string(), v.unknown())),
    }),
  ),
});
const ReferenceDocumentSchema = v.object({
  info: v.object({
    title: v.string(),
    version: v.string(),
    description: v.optional(v.string()),
  }),
  paths: v.record(v.string(), v.strictObject({ get: OperationSchema })),
});

export type ParameterLocation = "query" | "path";
export type BodyKind = "json" | "text" | "binary";

export interface ReferenceConstraint {
  readonly kind:
    | "format"
    | "pattern"
    | "minimum"
    | "maximum"
    | "maxLength"
    | "default";
  readonly value: string;
}

export interface ReferenceParameter {
  readonly name: string;
  readonly location: ParameterLocation;
  readonly required: boolean;
  readonly type: string;
  readonly description: string;
  readonly example: string;
  readonly choices: readonly string[];
  readonly constraints: readonly ReferenceConstraint[];
}

export interface ReferenceResponse {
  readonly status: string;
  readonly description: string;
  readonly mediaTypes: readonly string[];
}

export interface ReferenceOperation {
  readonly id: string;
  readonly method: "GET";
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly description: string;
  readonly parameters: readonly ReferenceParameter[];
  readonly responses: readonly ReferenceResponse[];
  /** How a client reads the successful response body. */
  readonly body: BodyKind;
}

export interface ReferenceGroup {
  readonly tag: string;
  readonly operations: readonly ReferenceOperation[];
}

export interface ReferenceModel {
  readonly title: string;
  readonly version: string;
  readonly description: string;
  readonly groups: readonly ReferenceGroup[];
}

/** Visitor-supplied search values; the request form submits one value per name. */
export type ReferenceSearch = Readonly<Record<string, string>>;
export type ReferenceValues = Readonly<Record<string, string>>;

export type ReferencePlan =
  | { readonly decision: "idle" }
  | { readonly decision: "unknown_operation"; readonly operation: string }
  | {
      readonly decision: "incomplete_path";
      readonly operation: ReferenceOperation;
    }
  | {
      readonly decision: "send";
      readonly operation: ReferenceOperation;
      readonly target: string;
    };

export interface CodeExamples {
  readonly curl: string;
  readonly javascript: string;
  /** Whether the examples keep a `{name}` path template for the reader to replace. */
  readonly placeholders: boolean;
}

export function responseBodyKind(contentType: string | null): BodyKind {
  const mediaType = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType === "application/json" || mediaType?.endsWith("+json"))
    return "json";
  if (mediaType?.startsWith("text/")) return "text";
  return "binary";
}

function constraints(
  schema: v.InferOutput<typeof ParameterSchema>["schema"],
): readonly ReferenceConstraint[] {
  if (!schema) return [];
  const entries: [ReferenceConstraint["kind"], string | number | undefined][] =
    [
      ["format", schema.format],
      ["pattern", schema.pattern],
      ["minimum", schema.minimum],
      ["maximum", schema.maximum],
      ["maxLength", schema.maxLength],
      ["default", schema.default],
    ];
  return entries.flatMap(([kind, value]) =>
    value === undefined ? [] : [{ kind, value: String(value) }],
  );
}

function referenceOperation(
  path: string,
  source: v.InferOutput<typeof OperationSchema>,
): ReferenceOperation {
  const parameters = (source.parameters ?? []).map(
    (parameter): ReferenceParameter => {
      if (parameter.name === operationSearchKey)
        throw new Error(
          `${source.operationId} uses the reserved parameter ${operationSearchKey}`,
        );
      return {
        name: parameter.name,
        location: parameter.in,
        required: parameter.in === "path" || parameter.required === true,
        type: parameter.schema?.type ?? "string",
        description: parameter.description ?? "",
        example:
          parameter.example === undefined ? "" : String(parameter.example),
        choices: parameter.schema?.enum ?? [],
        constraints: constraints(parameter.schema),
      };
    },
  );
  const templated = [...path.matchAll(pathTemplate)].map((match) => match[1]);
  const declared = parameters
    .filter((parameter) => parameter.location === "path")
    .map((parameter) => parameter.name);
  if (
    templated.length !== declared.length ||
    templated.some((name) => !declared.includes(name ?? ""))
  )
    throw new Error(
      `${source.operationId} doesn't declare exactly its path parameters`,
    );
  const responses = Object.entries(source.responses).map(
    ([status, response]): ReferenceResponse => ({
      status,
      description: response.description,
      mediaTypes: Object.keys(response.content ?? {}),
    }),
  );
  const success = responses.find((response) => response.status.startsWith("2"));
  return {
    id: source.operationId,
    method: "GET",
    path,
    tag: source.tags?.[0] ?? "",
    summary: source.summary,
    description: source.description ?? "",
    parameters,
    responses,
    body: responseBodyKind(success?.mediaTypes[0] ?? null),
  };
}

/** Reads the parts of an OpenAPI document the reference presents, and refuses parts it can't present faithfully. */
export function referenceModel(document: unknown): ReferenceModel {
  const parsed = v.parse(ReferenceDocumentSchema, document);
  const groups = new Map<string, ReferenceOperation[]>();
  const identities = new Set<string>();
  for (const [path, item] of Object.entries(parsed.paths)) {
    const operation = referenceOperation(path, item.get);
    if (identities.has(operation.id))
      throw new Error(`Two operations share the identity ${operation.id}`);
    identities.add(operation.id);
    const group = groups.get(operation.tag);
    if (group) group.push(operation);
    else groups.set(operation.tag, [operation]);
  }
  return {
    title: parsed.info.title,
    version: parsed.info.version,
    description: parsed.info.description ?? "",
    groups: [...groups].map(([tag, operations]) => ({ tag, operations })),
  };
}

export function referenceOperations(
  model: ReferenceModel,
): readonly ReferenceOperation[] {
  return model.groups.flatMap((group) => group.operations);
}

export function validateReferenceSearch(
  raw: Record<string, unknown>,
): ReferenceSearch {
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function exampleValues(operation: ReferenceOperation): ReferenceValues {
  return Object.fromEntries(
    operation.parameters
      .filter((parameter) => parameter.example !== "")
      .map((parameter) => [parameter.name, parameter.example]),
  );
}

/** Keeps the submitted values of the operation's own parameters. */
export function requestValues(
  operation: ReferenceOperation,
  search: ReferenceSearch,
): ReferenceValues {
  return Object.fromEntries(
    operation.parameters.flatMap((parameter) => {
      const value = search[parameter.name];
      return value === undefined ? [] : [[parameter.name, value]];
    }),
  );
}

export function pathValuesComplete(
  operation: ReferenceOperation,
  values: ReferenceValues,
): boolean {
  return operation.parameters
    .filter((parameter) => parameter.location === "path")
    .every((parameter) => {
      const value = values[parameter.name] ?? "";
      return value !== "" && !dotSegments.includes(value);
    });
}

/** Builds a same-origin request path: each path value stays within its segment, and empty query values are omitted. */
export function requestTarget(
  operation: ReferenceOperation,
  values: ReferenceValues,
): string {
  let path = operation.path;
  const query = new URLSearchParams();
  for (const parameter of operation.parameters) {
    const value = values[parameter.name] ?? "";
    if (parameter.location === "path")
      path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(value));
    else if (value !== "") query.set(parameter.name, value);
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

export function planReferenceRequest(
  operations: readonly ReferenceOperation[],
  search: ReferenceSearch,
): ReferencePlan {
  const id = search[operationSearchKey] ?? "";
  const operation = operations.find((item) => item.id === id);
  const values = operation ? requestValues(operation, search) : {};
  const decision = referenceRequestDecision(
    id !== "",
    operation !== undefined,
    operation !== undefined && pathValuesComplete(operation, values),
  );
  if (decision === "idle") return { decision };
  if (decision === "unknown_operation" || !operation)
    return { decision: "unknown_operation", operation: id };
  if (decision === "incomplete_path") return { decision, operation };
  return { decision, operation, target: requestTarget(operation, values) };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const bodyReaders: Readonly<Record<BodyKind, string>> = {
  json: "json",
  text: "text",
  binary: "arrayBuffer",
};

export function codeExamples(
  origin: string,
  operation: ReferenceOperation,
): CodeExamples {
  let path = operation.path;
  let placeholders = false;
  const query: [string, string][] = [];
  for (const parameter of operation.parameters) {
    if (parameter.location === "query") {
      if (parameter.example !== "")
        query.push([parameter.name, parameter.example]);
    } else if (parameter.example === "") placeholders = true;
    else
      path = path.replaceAll(
        `{${parameter.name}}`,
        encodeURIComponent(parameter.example),
      );
  }
  const url = `${origin}${path}`;
  const read = `const body = await response.${bodyReaders[operation.body]}();`;
  if (query.length === 0)
    return {
      placeholders,
      curl: `curl ${shellQuote(url)}`,
      javascript: [
        `const response = await fetch(${JSON.stringify(url)});`,
        read,
      ].join("\n"),
    };
  return {
    placeholders,
    curl: [
      `curl --get ${shellQuote(url)}`,
      ...query.map(
        ([name, value]) =>
          `  --data-urlencode ${shellQuote(`${name}=${value}`)}`,
      ),
    ].join(" \\\n"),
    javascript: [
      `const url = new URL(${JSON.stringify(url)});`,
      ...query.map(
        ([name, value]) =>
          `url.searchParams.set(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
      ),
      "const response = await fetch(url);",
      read,
    ].join("\n"),
  };
}
