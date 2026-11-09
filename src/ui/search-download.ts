import { sha256 } from "@noble/hashes/sha2.js";
import {
  type IndexUnavailable,
  indexProgressSteps,
  type LocalSearchReply,
} from "../core/local-search-protocol.ts";
import type { Result } from "../core/result.ts";

interface DownloadLocation {
  readonly url: string;
  readonly snapshot: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly uncompressedBytes: number;
  readonly uncompressedSha256: string;
}

interface DownloadPorts {
  readonly fetch: (url: string) => Promise<Response>;
  readonly post: (reply: LocalSearchReply) => void;
}

export async function downloadSearchFile(
  ports: DownloadPorts,
  expected: DownloadLocation,
  current: () => boolean,
  write: (bytes: Uint8Array, at: number) => void,
): Promise<
  Result<void, { readonly reason: IndexUnavailable; readonly detail: string }>
> {
  let reader:
    | ReadableStreamDefaultReader<Uint8Array>
    | ReadableStreamBYOBReader
    | null = null;
  try {
    const response = await ports.fetch(expected.url);
    if (!response.ok)
      return {
        ok: false,
        error: {
          reason: "fetch_failed",
          detail: `The index responded ${response.status}`,
        },
      };
    if (
      response.headers.get("Content-Encoding") !== "br" ||
      response.headers.get("Content-Length") !== String(expected.bytes) ||
      response.headers.get("ETag") !== `"${expected.sha256}"` ||
      response.headers.get("X-Dataset-Snapshot") !== expected.snapshot
    )
      return { ok: false, error: { reason: "transport_mismatch", detail: "" } };
    if (!response.body)
      return { ok: false, error: { reason: "length_mismatch", detail: "" } };
    try {
      reader = response.body.getReader({ mode: "byob" });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    reader ??= response.body.getReader();
    let buffer = new Uint8Array(65_536);
    const hasher = sha256.create();
    let received = 0;
    let step = 0;
    for (;;) {
      const result =
        reader instanceof ReadableStreamBYOBReader
          ? await reader.read(buffer)
          : await reader.read();
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array))
        throw new TypeError("The index body didn't stream bytes");
      if (!current() || received + chunk.length > expected.uncompressedBytes)
        return { ok: false, error: { reason: "length_mismatch", detail: "" } };
      hasher.update(chunk);
      for (let at = 0; at < chunk.length; at += 65_536) {
        const part = chunk.subarray(at, Math.min(at + 65_536, chunk.length));
        write(part, received + at);
      }
      received += chunk.length;
      if (reader instanceof ReadableStreamBYOBReader) {
        if (!(chunk.buffer instanceof ArrayBuffer))
          throw new TypeError("The index byte stream returned shared storage");
        buffer = new Uint8Array(chunk.buffer);
      }
      const reached = Math.floor(
        (received * indexProgressSteps) /
          Math.max(expected.uncompressedBytes, 1),
      );
      if (reached > step && current()) {
        step = reached;
        ports.post({
          type: "progress",
          received,
          total: expected.uncompressedBytes,
        });
      }
    }
    if (received !== expected.uncompressedBytes)
      return { ok: false, error: { reason: "length_mismatch", detail: "" } };
    const digest = Array.from(hasher.digest(), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return digest === expected.uncompressedSha256
      ? { ok: true, value: undefined }
      : { ok: false, error: { reason: "digest_mismatch", detail: "" } };
  } catch (error) {
    return {
      ok: false,
      error: { reason: "fetch_failed", detail: String(error) },
    };
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // A failed stream can reject cancellation after its primary error was classified.
    } finally {
      reader?.releaseLock();
    }
  }
}
