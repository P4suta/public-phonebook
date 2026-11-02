import { describe, expect, it } from "vitest";
import {
  operationSearchKey,
  planReferenceRequest,
  type ReferenceOperation,
} from "../../src/core/api-reference.ts";
import {
  attemptPlan,
  readAttempt,
  readBoundedText,
} from "../../src/ui/reference-request.ts";

const encoder = new TextEncoder();

function stream(chunks: readonly Uint8Array[]): {
  readonly body: ReadableStream<Uint8Array>;
  readonly state: { cancelled: boolean; pulled: number };
} {
  const state = { cancelled: false, pulled: 0 };
  let index = 0;
  return {
    state,
    body: new ReadableStream<Uint8Array>({
      pull(controller): void {
        const chunk = chunks[index];
        index += 1;
        state.pulled = index;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel(): void {
        state.cancelled = true;
      },
    }),
  };
}

const catalog: ReferenceOperation = {
  id: "getCatalog",
  method: "GET",
  path: "/api/catalog",
  tag: "Directory",
  summary: "Get the catalog",
  description: "",
  parameters: [],
  responses: [],
  body: "json",
};

describe("bounded body reading", () => {
  it("reads a body below the limit completely", async () => {
    const { body, state } = stream([encoder.encode("ab"), encoder.encode("c")]);
    expect(await readBoundedText(body, 8)).toEqual({
      text: "abc",
      truncated: false,
    });
    expect(state.cancelled).toBe(false);
  });

  it("stops at the byte limit and cancels the rest of the body", async () => {
    const { body, state } = stream([
      encoder.encode("abcd"),
      encoder.encode("efgh"),
      encoder.encode("ijkl"),
    ]);
    expect(await readBoundedText(body, 6)).toEqual({
      text: "abcdef",
      truncated: true,
    });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(4);
  });

  it("treats a body of exactly the limit as complete", async () => {
    const { body } = stream([encoder.encode("abcd")]);
    expect(await readBoundedText(body, 4)).toEqual({
      text: "abcd",
      truncated: false,
    });
  });

  it("drops a character that the limit cuts instead of showing a replacement", async () => {
    const { body } = stream([encoder.encode("あい")]);
    expect(await readBoundedText(body, 4)).toEqual({
      text: "あ",
      truncated: true,
    });
  });
});

describe("response presentation", () => {
  it("indents a complete JSON body and keeps its status and media type", async () => {
    expect(
      await readAttempt(
        "getCatalog",
        new Response('{"a":[1]}', {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).toEqual({
      operation: "getCatalog",
      outcome: "response",
      status: 200,
      contentType: "application/json",
      body: {
        kind: "text",
        text: '{\n  "a": [\n    1\n  ]\n}',
        truncated: false,
      },
    });
  });

  it("shows a truncated JSON body as received", async () => {
    const attempt = await readAttempt(
      "getCatalog",
      new Response('{"a":"bcdef"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      4,
    );
    expect(attempt).toMatchObject({
      body: { kind: "text", text: '{"a"', truncated: true },
    });
  });

  it("keeps a problem body that isn't JSON as text", async () => {
    expect(
      await readAttempt(
        "getCatalog",
        new Response("not json", {
          status: 503,
          headers: { "Content-Type": "application/problem+json" },
        }),
      ),
    ).toMatchObject({
      status: 503,
      body: { kind: "text", text: "not json", truncated: false },
    });
  });

  it("reports a binary body's length without reading it", async () => {
    const { body, state } = stream([new Uint8Array([1, 2, 3])]);
    expect(
      await readAttempt(
        "downloadDataset",
        new Response(body, {
          headers: {
            "Content-Type": "application/gzip",
            "Content-Length": "3",
          },
        }),
      ),
    ).toEqual({
      operation: "downloadDataset",
      outcome: "response",
      status: 200,
      contentType: "application/gzip",
      body: { kind: "binary", bytes: 3 },
    });
    expect(state.cancelled).toBe(true);
    expect(
      await readAttempt(
        "downloadDataset",
        new Response(null, { headers: { "Content-Length": "x" } }),
      ),
    ).toMatchObject({ contentType: "", body: { kind: "binary", bytes: null } });
  });
});

describe("attempts", () => {
  it("sends nothing until the visitor submits an operation", async () => {
    const sent: string[] = [];
    const send = async (target: string): Promise<Response> => {
      sent.push(target);
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    };
    expect(await attemptPlan(planReferenceRequest([catalog], {}), send)).toBe(
      null,
    );
    expect(
      await attemptPlan(
        planReferenceRequest([catalog], { [operationSearchKey]: "missing" }),
        send,
      ),
    ).toEqual({ operation: "missing", outcome: "unknown_operation" });
    expect(sent).toEqual([]);
    expect(
      await attemptPlan(
        planReferenceRequest([catalog], { [operationSearchKey]: "getCatalog" }),
        send,
      ),
    ).toMatchObject({ outcome: "response", status: 200 });
    expect(sent).toEqual(["/api/catalog"]);
  });

  it("reports a failed connection as a failed attempt", async () => {
    expect(
      await attemptPlan(
        planReferenceRequest([catalog], { [operationSearchKey]: "getCatalog" }),
        async () => {
          throw new TypeError("Failed to fetch");
        },
      ),
    ).toEqual({ operation: "getCatalog", outcome: "failed" });
  });
});
