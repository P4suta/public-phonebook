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
const rateLimitedStatus = 429;
const minimumRequestIntervalMs = 1000;
const defaultCooldownMs = 60000;
const millisecondsPerSecond = 1000;
const collectorAgent = "PublicPhonebookCollector (+https://www.dial.page/data)";

const ArtifactSchema = v.strictObject({
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

export class ArtifactStore {
  private readonly root: string;
  private readonly offline: boolean;
  private readonly preferCached: boolean;
  private readonly minimumIntervalMs: number;
  private readonly request: typeof fetch;
  private readonly clock: () => string;
  private readonly pending = new Map<string, Promise<SourceArtifact>>();
  private readonly origins = new Map<string, Promise<void>>();
  private readonly issuedAt = new Map<string, number>();
  private readonly blockedUntil = new Map<string, number>();

  constructor(
    root: string,
    options: {
      readonly offline?: boolean;
      readonly preferCached?: boolean;
      readonly minimumIntervalMs?: number;
      readonly request?: typeof fetch;
      readonly clock?: () => string;
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
    const origin = new URL(url).origin;
    const previous = this.origins.get(origin) ?? Promise.resolve();
    const slot = previous.then(async () => {
      const blocked = this.blockedUntil.get(origin) ?? 0;
      if (blocked > Date.now())
        throw new Error(
          `Source rate limit persists until ${new Date(blocked).toISOString()}: ${origin}`,
        );
      const remaining =
        (this.issuedAt.get(origin) ?? 0) + this.minimumIntervalMs - Date.now();
      if (remaining > 0) await delay(remaining);
      this.issuedAt.set(origin, Date.now());
    });
    this.origins.set(
      origin,
      slot.catch(() => undefined),
    );
    await slot;
    const response = await this.request(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const now = this.clock();
    let artifact: SourceArtifact;
    if (response.status === notModifiedStatus) {
      if (!cached) throw new Error("Uncached source returned not modified");
      artifact = { ...cached, checkedAt: now };
    } else {
      if (!response.ok) {
        if (response.status === rateLimitedStatus) {
          const retry = response.headers.get("retry-after");
          const until =
            retry && /^[0-9]+$/u.test(retry)
              ? Date.now() + Number(retry) * millisecondsPerSecond
              : retry
                ? Date.parse(retry)
                : Number.NaN;
          this.blockedUntil.set(
            origin,
            Number.isFinite(until)
              ? Math.max(until, Date.now() + defaultCooldownMs)
              : Date.now() + defaultCooldownMs,
          );
        }
        await response.body?.cancel();
        throw new Error(`Source returned HTTP ${response.status}: ${url}`);
      }
      const resolvedUrl = response.url || url;
      if (new URL(resolvedUrl).protocol !== "https:") {
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
      const sha256 = byteDigest(bytes);
      const objectPath = join(this.root, "objects", sha256);
      const temporary = `${objectPath}.${randomUUID()}.partial`;
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, objectPath);
      artifact = {
        url,
        resolvedUrl,
        sha256,
        bytes: length,
        retrievedAt: cached?.sha256 === sha256 ? cached.retrievedAt : now,
        checkedAt: now,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentType: response.headers.get("content-type") ?? "",
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
}
