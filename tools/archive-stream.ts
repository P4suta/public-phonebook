import { createReadStream } from "node:fs";
import { type Duplex, PassThrough, type Stream } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

/** Resolves once `stage` has emitted `close`, with the first error it emitted or null. */
function closing(stage: Stream): Promise<unknown> {
  return new Promise((resolve) => {
    let failure: unknown = null;
    stage.on("error", (error: unknown) => {
      failure ??= error;
    });
    stage.once("close", () => resolve(failure));
  });
}

/**
 * Yields what `decoder` reads from the gzip file at `path`, through one pipeline that observes every stage.
 * The reader settles only after the file, gunzip, and decoder stages have each emitted `close`, so no stage event can follow it.
 * Draining it reports the first failure of any stage, including one raised while a stage closes.
 * Stopping early cancels the stages, waits for them to close, and reports nothing.
 * The decoder must emit `close`, as Node streams do by default.
 */
export async function* readGzipArchive(
  path: string,
  decoder: Duplex = new PassThrough(),
): AsyncGenerator<unknown> {
  const source = createReadStream(path);
  const gunzip = createGunzip();
  const closed = Promise.all([source, gunzip, decoder].map(closing));
  const cancellation = new AbortController();
  const piped = pipeline(source, gunzip, decoder, {
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
    await Promise.all([piped, closed]);
  }
  const failure =
    (await piped) ?? (await closed).find((error) => error !== null) ?? null;
  if (failure !== null) throw failure;
}
