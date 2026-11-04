import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { AwsClient } from "aws4fetch";
import * as v from "valibot";
import { environments, releaseControl } from "../src/core/environment.ts";
import { httpStatus } from "../src/core/http-status.ts";
import { DigestSchema } from "../src/core/models.ts";

export type RemoteEnvironment = "production";
export type WriteCondition =
  | { readonly kind: "create" }
  | { readonly kind: "replace"; readonly etag: string };
export interface FileBody {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export type ObjectBody = Uint8Array | FileBody;
export interface StoredObject {
  readonly body: Uint8Array;
  readonly etag: string;
}
export interface ReadResult {
  readonly observedAt: Date;
  readonly object: StoredObject | null;
}
export interface ObjectHead {
  readonly etag: string;
  readonly bytes: number;
}
export interface WriteResult {
  readonly etag: string;
  readonly observedAt: Date;
}
export interface ControlStore {
  read(key: string): Promise<ReadResult>;
  head(key: string): Promise<ObjectHead | null>;
  download(key: string, destination: string): Promise<ObjectHead | null>;
  write(
    key: string,
    body: ObjectBody,
    condition: WriteCondition,
  ): Promise<WriteResult>;
}

export const preconditionFailed = 412;
export const lockedByBucketPolicy = 409;
export type ConflictStatus =
  | typeof preconditionFailed
  | typeof lockedByBucketPolicy;

export class ControlStoreConflict extends Error {
  readonly status: ConflictStatus;
  readonly key: string;
  constructor(status: ConflictStatus, key: string) {
    super(
      status === preconditionFailed
        ? `The control object changed or already exists: ${key}`
        : `The control object is locked by the bucket policy: ${key}`,
    );
    this.name = "ControlStoreConflict";
    this.status = status;
    this.key = key;
  }
}

export class ControlStoreFailure extends Error {
  readonly status: number;
  constructor(operation: string, key: string, status: number, code: string) {
    super(`Control store ${operation} failed for ${key}: ${status} ${code}`);
    this.name = "ControlStoreFailure";
    this.status = status;
  }
}

export function isConflict(
  error: unknown,
  status?: ConflictStatus,
): error is ControlStoreConflict {
  return (
    error instanceof ControlStoreConflict &&
    (status === undefined || error.status === status)
  );
}

const keySegment = /^[a-z0-9][a-z0-9._-]*$/u;
const treeSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u));
const stageSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*$/u));
const databaseIdSchema = v.pipe(v.string(), v.uuid());
const historyWidth = 12;
const minimumKeySegments = 2;
const maximumSequence = 999_999_999_999;
export const SequenceSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(maximumSequence),
);

export function checkedKey(key: string): string {
  const segments = key.split("/");
  if (
    segments.length < minimumKeySegments ||
    !segments.every((segment) => keySegment.test(segment) && segment !== "..")
  )
    throw new Error(`Unsupported control key: ${key}`);
  return key;
}

export type WritePolicy = "write-once" | "conditional" | "append-only";

export const controlKeys = {
  blob: (sha256: string): string =>
    `blobs/sha256/${v.parse(DigestSchema, sha256)}`,
  dataset: (
    manifestSha256: string,
    file: "manifest.ready.json" | "catalog.json",
  ): string => `datasets/${v.parse(DigestSchema, manifestSha256)}/${file}`,
  collection: (report: string, file: string): string =>
    checkedKey(`collections/${v.parse(DigestSchema, report)}/${file}`),
  collectionCache: (sha256: string): string =>
    `collection-cache/${v.parse(DigestSchema, sha256)}`,
  candidate: (inputsSha256: string, stage: string): string =>
    `candidates/${v.parse(DigestSchema, inputsSha256)}/${v.parse(stageSchema, stage)}.json`,
  observation: (
    sourceTree: string,
    manifestSha256: string,
    name: string,
  ): string =>
    `observations/${v.parse(treeSchema, sourceTree)}/${v.parse(DigestSchema, manifestSha256)}/${v.parse(stageSchema, name)}.json`,
  journalHead: (environment: RemoteEnvironment): string =>
    `journals/${environment}/head.json`,
  journalHistory: (environment: RemoteEnvironment, sequence: number): string =>
    `journals/${environment}/history/${String(v.parse(SequenceSchema, sequence)).padStart(historyWidth, "0")}.json`,
  lease: (environment: RemoteEnvironment): string =>
    `leases/${environment}.json`,
  evidence: (scope: string, sha256: string): string =>
    checkedKey(`evidence/${scope}/${v.parse(DigestSchema, sha256)}.json`),
  databaseEvidence: (databaseSha256: string, databaseId: string): string =>
    checkedKey(
      `evidence/databases/${v.parse(DigestSchema, databaseSha256)}/${v.parse(databaseIdSchema, databaseId)}.json`,
    ),
} as const;

export function writePolicy(key: string): WritePolicy {
  checkedKey(key);
  if (/^journals\/[a-z]+\/head\.json$/u.test(key) || key.startsWith("leases/"))
    return "conditional";
  if (key.startsWith("journals/") || key.startsWith("evidence/"))
    return "append-only";
  if (
    [
      "blobs/",
      "datasets/",
      "collections/",
      "collection-cache/",
      "candidates/",
      "observations/",
    ].some((prefix) => key.startsWith(prefix))
  )
    return "write-once";
  throw new Error(`Unsupported control key: ${key}`);
}

export type KeyLayout = "control" | "dataset";
const datasetArchiveKey = /^[a-f0-9]{64}\/[a-f0-9]{64}\/[a-z0-9][a-z0-9._-]*$/u;

function requireWritePolicy(
  key: string,
  condition: WriteCondition,
  layout: KeyLayout = "control",
): void {
  if (layout === "dataset") {
    if (!datasetArchiveKey.test(key) || condition.kind !== "create")
      throw new Error(
        `The dataset bucket accepts only new archive keys: ${key}`,
      );
    return;
  }
  const policy = writePolicy(key);
  if (condition.kind === "replace" && policy !== "conditional")
    throw new Error(`The control object can't be replaced: ${key}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quotedTag(bytes: Uint8Array): string {
  return `"${sha256Hex(bytes)}"`;
}

async function bodyBytes(body: ObjectBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const bytes = new Uint8Array(await readFile(body.path));
  if (bytes.byteLength !== body.bytes || sha256Hex(bytes) !== body.sha256)
    throw new Error("A control object source changed before upload");
  return bytes;
}

export async function readObject(
  store: ControlStore,
  key: string,
): Promise<StoredObject | null> {
  return (await store.read(key)).object;
}

export async function writeOnce(
  store: ControlStore,
  key: string,
  body: Uint8Array,
): Promise<"created" | "unchanged"> {
  try {
    await store.write(key, body, { kind: "create" });
    return "created";
  } catch (error) {
    if (!isConflict(error)) throw error;
    const existing = await readObject(store, key);
    if (existing && sha256Hex(existing.body) === sha256Hex(body))
      return "unchanged";
    throw new Error(`A control object already holds different bytes: ${key}`, {
      cause: error,
    });
  }
}

export interface FileStoreOptions {
  readonly now?: () => Date;
  readonly lockedPrefixes?: readonly string[];
  readonly layout?: KeyLayout;
}

export function fileControlStore(
  root: string,
  options: FileStoreOptions = {},
): ControlStore {
  const now = options.now ?? ((): Date => new Date());
  const locked = options.lockedPrefixes ?? [];
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }
  function path(key: string): string {
    return join(root, ...checkedKey(key).split("/"));
  }
  async function existing(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path(key)));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  return {
    read: (key) =>
      serialized(async () => {
        const body = await existing(key);
        return {
          observedAt: now(),
          object: body ? { body, etag: quotedTag(body) } : null,
        };
      }),
    head: (key) =>
      serialized(async () => {
        const body = await existing(key);
        return body ? { etag: quotedTag(body), bytes: body.byteLength } : null;
      }),
    download: (key, destination) =>
      serialized(async () => {
        const body = await existing(key);
        if (!body) return null;
        await writeFile(destination, body, { flush: true });
        return { etag: quotedTag(body), bytes: body.byteLength };
      }),
    write: (key, body, condition) =>
      serialized(async () => {
        requireWritePolicy(key, condition, options.layout);
        const bytes = await bodyBytes(body);
        const current = await existing(key);
        if (current && locked.some((prefix) => key.startsWith(prefix)))
          throw new ControlStoreConflict(lockedByBucketPolicy, key);
        if (
          condition.kind === "create"
            ? current !== null
            : current === null || quotedTag(current) !== condition.etag
        )
          throw new ControlStoreConflict(preconditionFailed, key);
        const target = path(key);
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.partial`;
        try {
          if (body instanceof Uint8Array)
            await writeFile(temporary, bytes, { flag: "wx", flush: true });
          else await copyFile(body.path, temporary);
          if (condition.kind === "create") await link(temporary, target);
          else await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        return { etag: quotedTag(bytes), observedAt: now() };
      }),
  };
}

export const controlCredentialVariables = {
  account: "CLOUDFLARE_ACCOUNT_ID",
  accessKey: "R2_ACCESS_KEY_ID",
  secretKey: "R2_SECRET_ACCESS_KEY",
} as const;
const accountSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/u));
const credentialSchema = v.pipe(v.string(), v.minLength(1));
const maximumSinglePutBytes = 5_000_000_000;
const maximumAttempts = 3;
const retryBaseMs = 250;
const retryGrowth = 2;
const serverErrorFloor = 500;
const tooManyRequests = 429;
const errorCodeLength = 64;
const streamChunkBytes = 1_048_576;

function fileStream(path: string): ReadableStream<Uint8Array> {
  let handle: FileHandle | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      handle ??= await open(path, "r");
      const chunk = new Uint8Array(streamChunkBytes);
      const { bytesRead } = await handle.read(chunk, 0, streamChunkBytes, null);
      if (bytesRead > 0) {
        controller.enqueue(chunk.subarray(0, bytesRead));
        return;
      }
      await handle.close();
      controller.close();
    },
    async cancel(): Promise<void> {
      await handle?.close();
    },
  });
}

export interface R2StoreOptions {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetch?: typeof fetch;
  readonly pause?: (milliseconds: number) => Promise<void>;
}

function allowedBuckets(): ReadonlySet<string> {
  return new Set([releaseControl.bucket, environments.production.bucket]);
}

function serverTime(response: Response): Date {
  const date = new Date(response.headers.get("Date") ?? "");
  if (!Number.isSafeInteger(date.getTime()))
    throw new Error("The control store response has no server time");
  return date;
}

function entityTag(response: Response, key: string): string {
  const tag = response.headers.get("ETag");
  if (!tag) throw new Error(`The control store returned no entity tag: ${key}`);
  return tag;
}

async function errorCode(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return (
    /<Code>([A-Za-z]+)<\/Code>/u.exec(text)?.[1]?.slice(0, errorCodeLength) ??
    "Unknown"
  );
}

export function r2ControlStore(options: R2StoreOptions): ControlStore {
  if (!allowedBuckets().has(options.bucket))
    throw new Error("The control store refuses an unlisted bucket");
  const layout: KeyLayout =
    options.bucket === releaseControl.bucket ? "control" : "dataset";
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: releaseControl.storageRegion,
    retries: 0,
  });
  const send = options.fetch ?? fetch;
  const pause =
    options.pause ??
    ((milliseconds: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  function url(key: string): string {
    const encoded = checkedKey(key)
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return new URL(
      `/${options.bucket}/${encoded}`,
      options.endpoint,
    ).toString();
  }
  async function request(
    key: string,
    init: () => Promise<RequestInit>,
  ): Promise<{ response: Response; attempt: number }> {
    for (let attempt = 1; ; attempt += 1) {
      let response: Response | null = null;
      try {
        response = await send(await client.sign(url(key), await init()));
      } catch (error) {
        if (attempt >= maximumAttempts) throw error;
      }
      if (
        response &&
        (response.status < serverErrorFloor || attempt >= maximumAttempts) &&
        (response.status !== tooManyRequests || attempt >= maximumAttempts)
      )
        return { response, attempt };
      await response?.body?.cancel();
      await pause(retryBaseMs * retryGrowth ** (attempt - 1));
    }
  }
  async function read(key: string): Promise<ReadResult> {
    const { response } = await request(key, async () => ({ method: "GET" }));
    const observedAt = serverTime(response);
    if (response.status === httpStatus.notFound) {
      await response.body?.cancel();
      return { observedAt, object: null };
    }
    if (!response.ok)
      throw new ControlStoreFailure(
        "read",
        key,
        response.status,
        await errorCode(response),
      );
    return {
      observedAt,
      object: {
        body: new Uint8Array(await response.arrayBuffer()),
        etag: entityTag(response, key),
      },
    };
  }
  return {
    read,
    async head(key) {
      const { response } = await request(key, async () => ({ method: "HEAD" }));
      if (response.status === httpStatus.notFound) return null;
      if (!response.ok)
        throw new ControlStoreFailure("head", key, response.status, "Head");
      return {
        etag: entityTag(response, key),
        bytes: Number(response.headers.get("Content-Length") ?? "0"),
      };
    },
    async download(key, destination) {
      const { response } = await request(key, async () => ({ method: "GET" }));
      if (response.status === httpStatus.notFound) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body)
        throw new ControlStoreFailure(
          "download",
          key,
          response.status,
          await errorCode(response),
        );
      const etag = entityTag(response, key);
      const reader = response.body.getReader();
      const handle = await open(destination, "w");
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array))
            throw new Error(`The control store sent no bytes: ${key}`);
          await handle.write(value);
          bytes += value.byteLength;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { etag, bytes };
    },
    async write(key, body, condition) {
      requireWritePolicy(key, condition, layout);
      const length = body instanceof Uint8Array ? body.byteLength : body.bytes;
      if (length > maximumSinglePutBytes)
        throw new Error(`A control object exceeds one upload: ${key}`);
      const digest =
        body instanceof Uint8Array
          ? sha256Hex(body)
          : v.parse(DigestSchema, body.sha256);
      const { response, attempt } = await request(key, async () => {
        if (!(body instanceof Uint8Array)) {
          const file = await stat(body.path);
          if (file.size !== body.bytes)
            throw new Error("A control object source changed before upload");
        }
        return {
          method: "PUT",
          headers: {
            "Content-Length": String(length),
            "X-Amz-Content-Sha256": digest,
            ...(condition.kind === "create"
              ? { "If-None-Match": "*" }
              : { "If-Match": condition.etag }),
          },
          body:
            body instanceof Uint8Array
              ? new Uint8Array(body)
              : fileStream(body.path),
          duplex: "half",
        };
      });
      if (
        response.status === preconditionFailed ||
        response.status === lockedByBucketPolicy
      ) {
        await response.body?.cancel();
        if (attempt > 1 && response.status === preconditionFailed) {
          const committed = await committedObject(key, read);
          if (committed && committed.digest === digest)
            return { etag: committed.etag, observedAt: committed.observedAt };
        }
        throw new ControlStoreConflict(response.status, key);
      }
      if (!response.ok)
        throw new ControlStoreFailure(
          "write",
          key,
          response.status,
          await errorCode(response),
        );
      await response.body?.cancel();
      return {
        etag: entityTag(response, key),
        observedAt: serverTime(response),
      };
    },
  };
}

async function committedObject(
  key: string,
  read: (key: string) => Promise<ReadResult>,
): Promise<{ digest: string; etag: string; observedAt: Date } | null> {
  const result = await read(key);
  return result.object
    ? {
        digest: sha256Hex(result.object.body),
        etag: result.object.etag,
        observedAt: result.observedAt,
      }
    : null;
}

export function controlStoreFromEnvironment(
  bucket: string = releaseControl.bucket,
  variables: NodeJS.ProcessEnv = process.env,
): ControlStore {
  const account = v.safeParse(
    accountSchema,
    variables[controlCredentialVariables.account],
  );
  const accessKeyId = v.safeParse(
    credentialSchema,
    variables[controlCredentialVariables.accessKey],
  );
  const secretAccessKey = v.safeParse(
    credentialSchema,
    variables[controlCredentialVariables.secretKey],
  );
  if (!account.success || !accessKeyId.success || !secretAccessKey.success)
    throw new Error(
      `The control store requires ${Object.values(controlCredentialVariables).join(", ")}`,
    );
  return r2ControlStore({
    endpoint: new URL(
      `https://${account.output}.${releaseControl.storageHost}`,
    ),
    bucket,
    accessKeyId: accessKeyId.output,
    secretAccessKey: secretAccessKey.output,
  });
}
