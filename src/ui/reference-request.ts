import { type ReferencePlan, responseBodyKind } from "../core/api-reference.ts";

const bytesPerKibibyte = 1024;
/** The page shows at most this much of a response body. */
export const displayLimitKibibytes = 64;
const displayLimitBytes = displayLimitKibibytes * bytesPerKibibyte;
const jsonIndentation = 2;

export type ReferenceBody =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly truncated: boolean;
    }
  | { readonly kind: "binary"; readonly bytes: number | null };

export type ReferenceAttempt =
  | {
      readonly operation: string;
      readonly outcome: "response";
      readonly status: number;
      readonly contentType: string;
      readonly body: ReferenceBody;
    }
  | {
      readonly operation: string;
      readonly outcome: "failed" | "unknown_operation" | "incomplete_path";
    };

export type ReferenceSender = (target: string) => Promise<Response>;

/** Sends a reference request from the browser without credentials. */
export const browserSender: ReferenceSender = async (target) =>
  fetch(target, { credentials: "omit" });

/** Decodes at most `limit` bytes and cancels the rest; a character the limit cuts is dropped. */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return { text: text + decoder.decode(), truncated: false };
    const room = limit - received;
    if (chunk.value.byteLength > room) {
      text += decoder.decode(chunk.value.subarray(0, room), { stream: true });
      await reader.cancel();
      return { text, truncated: true };
    }
    received += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function indentJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, jsonIndentation);
  } catch {
    return text;
  }
}

function contentLength(response: Response): number | null {
  const header = response.headers.get("Content-Length");
  const bytes = Number(header);
  return header !== null && Number.isSafeInteger(bytes) && bytes >= 0
    ? bytes
    : null;
}

export async function readAttempt(
  operation: string,
  response: Response,
  limit = displayLimitBytes,
): Promise<ReferenceAttempt> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const kind = responseBodyKind(contentType);
  let body: ReferenceBody;
  if (kind === "binary") {
    await response.body?.cancel();
    body = { kind, bytes: contentLength(response) };
  } else {
    const read = await readBoundedText(response.body, limit);
    body = {
      kind: "text",
      text:
        kind === "json" && !read.truncated ? indentJson(read.text) : read.text,
      truncated: read.truncated,
    };
  }
  return {
    operation,
    outcome: "response",
    status: response.status,
    contentType,
    body,
  };
}

export async function attemptPlan(
  plan: ReferencePlan,
  send: ReferenceSender,
): Promise<ReferenceAttempt | null> {
  switch (plan.decision) {
    case "idle":
      return null;
    case "unknown_operation":
      return { operation: plan.operation, outcome: "unknown_operation" };
    case "incomplete_path":
      return { operation: plan.operation.id, outcome: "incomplete_path" };
    case "send":
      try {
        return await readAttempt(plan.operation.id, await send(plan.target));
      } catch {
        return { operation: plan.operation.id, outcome: "failed" };
      }
  }
}
