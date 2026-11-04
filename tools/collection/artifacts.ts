import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { DigestSchema, PublicUrlSchema } from "../../src/core/models.ts";

const requestTimeoutMs = 30000;
const maximumSourceBytes = 33554432;
const jsonIndentation = 2;
const notModifiedStatus = 304;
/** A publisher that answers 403 or 429 receives no further request in the run, because each later request could extend its block. */
const refusalStatuses: ReadonlySet<number> = new Set([403, 429]);
const minimumRequestIntervalMs = 5000;
const collectorAgent = "PublicPhonebookCollector (+https://www.dial.page/data)";

export const ArtifactSchema = v.strictObject({
  url: PublicUrlSchema,
  resolvedUrl: PublicUrlSchema,
  sha256: DigestSchema,
  bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  retrievedAt: v.string(),
  checkedAt: v.string(),
  etag: v.nullable(v.string()),
  lastModified: v.nullable(v.string()),
  contentType: v.string(),
});
export type SourceArtifact = v.InferOutput<typeof ArtifactSchema>;

export function byteDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

interface Retrieval {
  /** `null` when the origin confirmed that the cached bytes are current. */
  readonly bytes: Uint8Array | null;
  readonly resolvedUrl: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentType: string;
}

export class ArtifactStore {
  private readonly root: string;
  private readonly offline: boolean;
  private readonly preferCached: boolean;
  private readonly minimumIntervalMs: number;
  private readonly request: typeof fetch;
  private readonly clock: () => string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pending = new Map<string, Promise<SourceArtifact>>();
  private readonly origins = new Map<string, Promise<void>>();
  private readonly issuedAt = new Map<string, number>();
  private readonly refusals = new Map<string, number>();

  constructor(
    root: string,
    options: {
      readonly offline?: boolean;
      readonly preferCached?: boolean;
      readonly minimumIntervalMs?: number;
      readonly request?: typeof fetch;
      readonly clock?: () => string;
      readonly now?: () => number;
      readonly sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.root = resolve(root);
    this.offline = options.offline ?? false;
    this.preferCached = options.preferCached ?? false;
    this.minimumIntervalMs =
      options.minimumIntervalMs ?? minimumRequestIntervalMs;
    if (!Number.isFinite(this.minimumIntervalMs) || this.minimumIntervalMs < 0)
      throw new Error("Invalid request interval");
    this.request = options.request ?? fetch;
    this.clock = options.clock ?? ((): string => new Date().toISOString());
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      (async (milliseconds): Promise<void> => {
        await delay(milliseconds);
      });
  }

  async read(artifact: SourceArtifact): Promise<Uint8Array> {
    const checked = v.parse(ArtifactSchema, artifact);
    const bytes = await readFile(join(this.root, "objects", checked.sha256));
    if (
      bytes.byteLength !== checked.bytes ||
      byteDigest(bytes) !== checked.sha256
    )
      throw new Error(`Source cache integrity failure: ${checked.url}`);
    return bytes;
  }

  async artifacts(): Promise<readonly SourceArtifact[]> {
    const settled = await Promise.allSettled(this.pending.values());
    return settled
      .flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      )
      .sort((first, second) =>
        first.url < second.url ? -1 : first.url === second.url ? 0 : 1,
      );
  }

  async get(value: string): Promise<SourceArtifact> {
    const url = v.parse(PublicUrlSchema, value);
    if (new URL(url).protocol !== "https:")
      throw new Error("Collection requires an HTTPS source");
    const existing = this.pending.get(url);
    if (existing) return existing;
    const pending = this.download(url);
    this.pending.set(url, pending);
    return pending;
  }

  private async download(url: string): Promise<SourceArtifact> {
    await mkdir(join(this.root, "objects"), { recursive: true });
    await mkdir(join(this.root, "urls"), { recursive: true });
    const key = byteDigest(new TextEncoder().encode(url));
    const metadataPath = join(this.root, "urls", `${key}.json`);
    const raw = await readOptional(metadataPath);
    const cached =
      raw === null ? null : v.parse(ArtifactSchema, JSON.parse(raw));
    if (cached && cached.url !== url)
      throw new Error("Source cache URL conflict");
    if (cached) await this.read(cached);
    if (this.offline || (cached && this.preferCached)) {
      if (!cached) throw new Error(`Source is not cached: ${url}`);
      return cached;
    }
    const headers = new Headers({ "User-Agent": collectorAgent });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    if (cached?.lastModified)
      headers.set("If-Modified-Since", cached.lastModified);
    // One request per origin is in flight at a time, so a refusal reaches every request queued behind it.
    const origin = new URL(url).origin;
    const turn = (this.origins.get(origin) ?? Promise.resolve()).then(
      async (): Promise<Retrieval> => this.retrieve(origin, url, headers),
    );
    this.origins.set(
      origin,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    const retrieval = await turn;
    const now = this.clock();
    let artifact: SourceArtifact;
    if (retrieval.bytes === null) {
      if (!cached) throw new Error("Uncached source returned not modified");
      artifact = { ...cached, checkedAt: now };
    } else {
      const sha256 = byteDigest(retrieval.bytes);
      const objectPath = join(this.root, "objects", sha256);
      const temporary = `${objectPath}.${randomUUID()}.partial`;
      await writeFile(temporary, retrieval.bytes, { flag: "wx" });
      await rename(temporary, objectPath);
      artifact = {
        url,
        resolvedUrl: retrieval.resolvedUrl,
        sha256,
        bytes: retrieval.bytes.byteLength,
        retrievedAt: cached?.sha256 === sha256 ? cached.retrievedAt : now,
        checkedAt: now,
        etag: retrieval.etag,
        lastModified: retrieval.lastModified,
        contentType: retrieval.contentType,
      };
    }
    const temporary = `${metadataPath}.${randomUUID()}.partial`;
    await writeFile(
      temporary,
      `${JSON.stringify(artifact, null, jsonIndentation)}\n`,
      { flag: "wx" },
    );
    await rename(temporary, metadataPath);
    console.info(
      JSON.stringify({
        operation: "collection.fetch",
        url,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      }),
    );
    return artifact;
  }

  private async retrieve(
    origin: string,
    url: string,
    headers: Headers,
  ): Promise<Retrieval> {
    const refusal = this.refusals.get(origin);
    if (refusal !== undefined)
      throw new Error(
        `Source origin refused an earlier request with HTTP ${refusal}: ${url}`,
      );
    const remaining =
      (this.issuedAt.get(origin) ?? Number.NEGATIVE_INFINITY) +
      this.minimumIntervalMs -
      this.now();
    if (remaining > 0) await this.sleep(remaining);
    this.issuedAt.set(origin, this.now());
    const response = await this.request(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const metadata = {
      resolvedUrl: response.url || url,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentType: response.headers.get("content-type") ?? "",
    };
    if (response.status === notModifiedStatus) {
      await response.body?.cancel();
      return { ...metadata, bytes: null };
    }
    if (!response.ok) {
      if (refusalStatuses.has(response.status))
        this.refusals.set(origin, response.status);
      await response.body?.cancel();
      throw new Error(`Source returned HTTP ${response.status}: ${url}`);
    }
    if (new URL(metadata.resolvedUrl).protocol !== "https:") {
      await response.body?.cancel();
      throw new Error("Source redirected outside HTTPS");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > maximumSourceBytes) {
      await response.body?.cancel();
      throw new Error(`Source exceeds the download limit: ${url}`);
    }
    if (!response.body) throw new Error(`Source has no body: ${url}`);
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const rawChunk of response.body) {
      const chunk: unknown = rawChunk;
      if (!(chunk instanceof Uint8Array))
        throw new Error("Expected source bytes");
      length += chunk.byteLength;
      if (length > maximumSourceBytes)
        throw new Error(`Source exceeds the download limit: ${url}`);
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ...metadata, bytes };
  }
}
