import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { parse } from "csv-parse";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGzipArchive } from "../../tools/archive-stream.ts";

/** More records than a decoder buffers, so stopping at most positions leaves records unread. */
const recordCount = 64;
const recordPadding = 300;
const truncatedArchiveFraction = 0.5;

const records = Array.from(
  { length: recordCount },
  (_, index) => `${index},${"x".repeat(recordPadding)}\n`,
).join("");

async function collect(chunks: AsyncIterable<unknown>): Promise<unknown[]> {
  const collected: unknown[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return collected;
}

describe("gzip archive reading", () => {
  let directory = "";
  let path = "";
  const escaped: unknown[] = [];
  const recordEscape = (error: unknown): void => {
    escaped.push(error);
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "phonebook-archive-stream-"));
    path = join(directory, "records.csv.gz");
    await writeFile(path, gzipSync(records));
    escaped.length = 0;
    process.on("uncaughtException", recordEscape);
    process.on("unhandledRejection", recordEscape);
  });
  afterEach(async () => {
    process.off("uncaughtException", recordEscape);
    process.off("unhandledRejection", recordEscape);
    await rm(directory, { recursive: true, force: true });
  });

  async function expectNothingEscaped(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    expect(escaped).toEqual([]);
  }

  it("yields the decompressed bytes, or the records of a decoder", async () => {
    const text = new TextDecoder();
    const chunks = await collect(readGzipArchive(path));
    expect(
      chunks
        .map((chunk) => {
          if (!(chunk instanceof Uint8Array)) throw new Error("Expected bytes");
          return text.decode(chunk, { stream: true });
        })
        .join("") + text.decode(),
    ).toBe(records);
    const parsed = await collect(readGzipArchive(path, parse()));
    expect(parsed).toHaveLength(recordCount);
    expect(parsed.at(-1)).toEqual([
      String(recordCount - 1),
      "x".repeat(recordPadding),
    ]);
    await expectNothingEscaped();
  });

  it("closes every stage when the reader stops at any record", async () => {
    for (let stop = 0; stop < recordCount; stop += 1) {
      const decoder = parse();
      let seen = 0;
      for await (const _record of readGzipArchive(path, decoder)) {
        if (seen === stop) break;
        seen += 1;
      }
      expect(decoder.closed).toBe(true);
    }
    await expectNothingEscaped();
  });

  it("closes a decoder whose input has finished before the reader stops", async () => {
    const decoder = new PassThrough({
      highWaterMark: new TextEncoder().encode(records).byteLength,
    });
    const finished = once(decoder, "finish");
    const chunks = readGzipArchive(path, decoder);
    expect((await chunks.next()).done).toBe(false);
    await finished;
    expect(decoder.readableEnded).toBe(false);
    expect(await chunks.return(undefined)).toEqual({
      done: true,
      value: undefined,
    });
    expect(decoder.closed).toBe(true);
    await expectNothingEscaped();
  });

  it("reports a truncated archive or a decoder failure after closing every stage", async () => {
    const archive = gzipSync(records);
    await writeFile(
      path,
      archive.subarray(
        0,
        Math.floor(archive.byteLength * truncatedArchiveFraction),
      ),
    );
    const decoder = parse();
    await expect(collect(readGzipArchive(path, decoder))).rejects.toThrow(
      "unexpected end of file",
    );
    expect(decoder.closed).toBe(true);
    await writeFile(path, gzipSync(`${records}"unterminated\n`));
    await expect(collect(readGzipArchive(path, parse()))).rejects.toThrow(
      "Quote Not Closed",
    );
    await expect(
      collect(readGzipArchive(join(directory, "missing.csv.gz"))),
    ).rejects.toThrow("ENOENT");
    await expectNothingEscaped();
  });
});
