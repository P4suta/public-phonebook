import { createReadStream } from "node:fs";
import { type Duplex, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/**
 * Yields what `decoder` reads from the gzip file at `path`, through one pipeline that observes every stage.
 * The reader settles only after every stage has closed.
 * Draining it reports any stage failure, and stopping early cancels the stages it no longer reads.
 */
export async function* readGzipArchive(
  path: string,
  decoder: Duplex = new PassThrough(),
): AsyncGenerator<unknown> {
  const cancellation = new AbortController();
  const closed = pipeline(createReadStream(path), createGunzip(), decoder, {
    signal: cancellation.signal,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  let drained = false;
  try {
    yield* decoder;
    drained = true;
  } finally {
    if (!drained) cancellation.abort();
    await closed;
  }
  const failure = await closed;
  if (failure !== null) throw failure;
}
