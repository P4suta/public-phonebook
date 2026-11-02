import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  DirectoryDiscoverySchema,
  UnversionedDiscoverySchema,
} from "../../src/core/api-contract.ts";
import {
  codeExamples,
  operationSearchKey,
  pathValuesComplete,
  planReferenceRequest,
  type ReferenceOperation,
  referenceModel,
  referenceOperations,
  requestTarget,
  responseBodyKind,
  shellQuote,
  validateReferenceSearch,
} from "../../src/core/api-reference.ts";
import { referenceRequestDecision } from "../../src/core/reference-request-policy.ts";
import { api } from "../../src/server/api.ts";
import {
  referenceCopy,
  statusMeaning,
} from "../../src/ui/api-reference-copy.ts";

const origin = "https://reference.test";
const DocumentSchema = v.looseObject({
  paths: v.record(v.string(), v.record(v.string(), v.unknown())),
});
const contractBases = ["/api", "/api/v1"] as const;
/** A document can't describe itself, so the documents are the only served routes they leave out. */
const undocumentedRoutes: readonly string[] = contractBases.map(
  (base) => `${base}/openapi.json`,
);
const routeParameter = /:([^/]+)/gu;

const DiscoveryOperationSchema = v.object({
  get: v.object({
    responses: v.object({
      "200": v.object({
        content: v.object({
          "application/json": v.object({
            schema: v.record(v.string(), v.unknown()),
            example: v.unknown(),
          }),
        }),
      }),
    }),
  }),
});

async function generatedDocument(base = "/api"): Promise<unknown> {
  const response = await api.request(`${base}/openapi.json`);
  expect(response.status).toBe(200);
  return response.json();
}

async function discoveryMedia(
  base: (typeof contractBases)[number],
): Promise<{ readonly schema: unknown; readonly example: unknown }> {
  const document = v.parse(DocumentSchema, await generatedDocument(base));
  return v.parse(DiscoveryOperationSchema, document.paths[base]).get.responses[
    "200"
  ].content["application/json"];
}

describe("the generated OpenAPI documents", () => {
  it("document every served route and no route the server lacks", async () => {
    const documented = await Promise.all(
      contractBases.map(async (base) =>
        Object.keys(
          v.parse(DocumentSchema, await generatedDocument(base)).paths,
        ),
      ),
    );
    const served = new Set(
      api.routes
        .filter((route) => route.method === "GET")
        .map((route) => route.path.replaceAll(routeParameter, "{$1}"))
        .filter((path) => !undocumentedRoutes.includes(path)),
    );
    expect(documented.flat().sort()).toEqual([...served].sort());
  });

  it("describe each discovery body with a closed schema and an example it admits", async () => {
    const schemas = {
      "/api": UnversionedDiscoverySchema,
      "/api/v1": DirectoryDiscoverySchema,
    } as const;
    for (const base of contractBases) {
      const discovery = await discoveryMedia(base);
      expect(discovery.schema, base).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(v.is(schemas[base], discovery.example), base).toBe(true);
    }
  });

  it("show the exact unversioned discovery body as its example", async () => {
    const served = await api.request("/api");
    expect(served.status).toBe(200);
    const body: unknown = await served.json();
    expect(v.is(UnversionedDiscoverySchema, body)).toBe(true);
    expect((await discoveryMedia("/api")).example).toEqual(body);
  });
});

function operation(
  overrides: Partial<ReferenceOperation> = {},
): ReferenceOperation {
  return {
    id: "getContact",
    method: "GET",
    path: "/api/contacts/{id}",
    tag: "Contacts",
    summary: "Get a facility",
    description: "",
    parameters: [
      {
        name: "id",
        location: "path",
        required: true,
        type: "string",
        description: "",
        example: "",
        choices: [],
        constraints: [],
      },
      {
        name: "q",
        location: "query",
        required: false,
        type: "string",
        description: "",
        example: "国立国会図書館",
        choices: [],
        constraints: [],
      },
      {
        name: "limit",
        location: "query",
        required: false,
        type: "integer",
        description: "",
        example: "5",
        choices: [],
        constraints: [],
      },
    ],
    responses: [],
    body: "json",
    ...overrides,
  };
}

describe("the generated reference model", () => {
  it("lists every documented operation once, grouped by its tag in document order", async () => {
    const document = await generatedDocument();
    const paths = v.parse(DocumentSchema, document).paths;
    const model = referenceModel(document);
    const operations = referenceOperations(model);
    expect(model.title).toBe("Public Phonebook API");
    expect(operations.map((item) => `${item.method} ${item.path}`)).toEqual(
      Object.entries(paths).flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    );
    expect(new Set(operations.map((item) => item.id)).size).toBe(
      operations.length,
    );
    expect(model.groups.map((group) => group.tag)).toEqual([
      "Directory",
      "Contacts",
      "Sources",
      "Datasets",
      "Search index",
    ]);
    for (const group of model.groups)
      for (const item of group.operations) expect(item.tag).toBe(group.tag);
    const search = operations.find((item) => item.id === "searchContacts");
    expect(search?.parameters.map((parameter) => parameter.name)).toEqual([
      "q",
      "prefecture",
      "municipality",
      "category",
      "limit",
      "cursor",
    ]);
    expect(search?.parameters[0]).toMatchObject({
      location: "query",
      required: false,
      example: "国立国会図書館",
    });
    expect(search?.parameters[4]?.constraints).toEqual([
      { kind: "minimum", value: "1" },
      { kind: "maximum", value: "100" },
      { kind: "default", value: "30" },
    ]);
    expect(search?.parameters[1]?.choices).toHaveLength(47);
    expect(search?.responses.map((response) => response.status)).toEqual([
      "200",
      "400",
      "404",
      "409",
      "503",
    ]);
    expect(search?.responses[0]?.mediaTypes).toEqual(["application/json"]);
    const vcard = operations.find((item) => item.id === "downloadContact");
    expect(vcard?.body).toBe("text");
    const index = operations.find((item) => item.id === "downloadSearchIndex");
    expect(index?.body).toBe("binary");
  });

  it("has a Japanese summary for every operation and a meaning for every documented status", async () => {
    const model = referenceModel(await generatedDocument());
    const operations = referenceOperations(model);
    expect(Object.keys(referenceCopy.summaries).sort()).toEqual(
      operations.map((item) => item.id).sort(),
    );
    expect(Object.keys(referenceCopy.tags).sort()).toEqual(
      model.groups.map((group) => group.tag).sort(),
    );
    for (const item of operations)
      for (const response of item.responses)
        expect(
          statusMeaning(Number(response.status)),
          response.status,
        ).not.toBe("");
  });

  it("rejects documents the reference can't present faithfully", async () => {
    const document = v.parse(DocumentSchema, await generatedDocument());
    const getCatalog = document.paths["/api/catalog"]?.get;
    expect(() =>
      referenceModel({
        ...document,
        paths: { "/api/catalog": { post: getCatalog } },
      }),
    ).toThrow();
    const reserved = {
      operationId: "reserved",
      summary: "Reserved",
      parameters: [{ name: operationSearchKey, in: "query" }],
      responses: { "200": { description: "OK" } },
    };
    expect(() =>
      referenceModel({
        ...document,
        paths: { "/api/reserved": { get: reserved } },
      }),
    ).toThrow(/reserved/u);
    const undeclared = {
      operationId: "undeclared",
      summary: "Undeclared",
      responses: { "200": { description: "OK" } },
    };
    expect(() =>
      referenceModel({
        ...document,
        paths: { "/api/items/{id}": { get: undeclared } },
      }),
    ).toThrow(/path parameters/u);
    expect(() =>
      referenceModel({
        ...document,
        paths: {
          "/api/one": { get: { ...undeclared, operationId: "same" } },
          "/api/two": { get: { ...undeclared, operationId: "same" } },
        },
      }),
    ).toThrow(/same/u);
    const header = {
      ...undeclared,
      parameters: [{ name: "Accept", in: "header" }],
    };
    expect(() =>
      referenceModel({
        ...document,
        paths: { "/api/header": { get: header } },
      }),
    ).toThrow();
  });
});

describe("request planning", () => {
  it("decides every combination exactly as the proved policy states", () => {
    for (const requested of [false, true])
      for (const documented of [false, true])
        for (const pathComplete of [false, true])
          expect(
            referenceRequestDecision(requested, documented, pathComplete),
          ).toBe(
            !requested
              ? "idle"
              : !documented
                ? "unknown_operation"
                : !pathComplete
                  ? "incomplete_path"
                  : "send",
          );
  });

  it("sends only documented operations with complete path values", () => {
    const operations = [operation()];
    expect(planReferenceRequest(operations, {})).toEqual({ decision: "idle" });
    expect(
      planReferenceRequest(operations, { [operationSearchKey]: "missing" }),
    ).toEqual({ decision: "unknown_operation", operation: "missing" });
    for (const id of ["", ".", ".."])
      expect(
        planReferenceRequest(operations, {
          [operationSearchKey]: "getContact",
          id,
        }).decision,
        id,
      ).toBe("incomplete_path");
    expect(
      planReferenceRequest(operations, {
        [operationSearchKey]: "getContact",
        id: "fixture:0",
        q: "図書館",
        unknown: "ignored",
      }),
    ).toMatchObject({
      decision: "send",
      target: "/api/contacts/fixture%3A0?q=%E5%9B%B3%E6%9B%B8%E9%A4%A8",
    });
  });

  it("encodes path values so they stay inside their segment and omits empty query values", () => {
    const item = operation();
    expect(requestTarget(item, { id: "a/b?c#d%e", q: "", limit: "101" })).toBe(
      "/api/contacts/a%2Fb%3Fc%23d%25e?limit=101",
    );
    expect(requestTarget(item, { id: "x", limit: "5", q: "a b" })).toBe(
      "/api/contacts/x?q=a+b&limit=5",
    );
    expect(pathValuesComplete(item, { id: "x" })).toBe(true);
    expect(pathValuesComplete(item, { id: "..." })).toBe(true);
    expect(pathValuesComplete(item, {})).toBe(false);
  });

  it("keeps only single string search values", () => {
    expect(
      validateReferenceSearch({
        operation: "searchContacts",
        q: "図書館",
        limit: 5,
        category: ["library", "museum"],
      }),
    ).toEqual({ operation: "searchContacts", q: "図書館" });
  });
});

describe("code examples", () => {
  it("builds runnable curl and fetch examples from the documented examples", () => {
    const examples = codeExamples(
      origin,
      operation({
        path: "/api/contacts",
        parameters: operation().parameters.slice(1),
      }),
    );
    expect(examples.placeholders).toBe(false);
    expect(examples.curl).toBe(
      [
        `curl --get '${origin}/api/contacts' \\`,
        "  --data-urlencode 'q=国立国会図書館' \\",
        "  --data-urlencode 'limit=5'",
      ].join("\n"),
    );
    expect(examples.javascript).toBe(
      [
        `const url = new URL("${origin}/api/contacts");`,
        'url.searchParams.set("q", "国立国会図書館");',
        'url.searchParams.set("limit", "5");',
        "const response = await fetch(url);",
        "const body = await response.json();",
      ].join("\n"),
    );
  });

  it("marks path placeholders and reads each body kind in JavaScript", () => {
    const placeholder = codeExamples(
      origin,
      operation({
        parameters: operation().parameters.slice(0, 1),
        body: "text",
      }),
    );
    expect(placeholder.placeholders).toBe(true);
    expect(placeholder.curl).toBe(`curl '${origin}/api/contacts/{id}'`);
    expect(placeholder.javascript).toBe(
      [
        `const response = await fetch("${origin}/api/contacts/{id}");`,
        "const body = await response.text();",
      ].join("\n"),
    );
    expect(
      codeExamples(origin, operation({ parameters: [], body: "binary" }))
        .javascript,
    ).toContain("await response.arrayBuffer();");
  });

  it("quotes every shell argument", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$HOME `x`")).toBe("'$HOME `x`'");
  });
});

it("classifies response bodies by media type", () => {
  expect(responseBodyKind("application/json")).toBe("json");
  expect(responseBodyKind("application/problem+json; charset=utf-8")).toBe(
    "json",
  );
  expect(responseBodyKind("text/vcard; charset=utf-8")).toBe("text");
  expect(responseBodyKind("application/octet-stream")).toBe("binary");
  expect(responseBodyKind("application/gzip")).toBe("binary");
  expect(responseBodyKind(null)).toBe("binary");
});
