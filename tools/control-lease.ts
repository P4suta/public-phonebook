import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import * as v from "valibot";
import { leaseAdmission } from "../src/core/publication-policy.ts";
import {
  type ControlStore,
  controlKeys,
  isConflict,
  type RemoteEnvironment,
} from "./control-store.ts";
import {
  encodeRecord,
  RemoteEnvironmentSchema,
  type RunProvenance,
  RunProvenanceSchema,
} from "./release-store.ts";

export const leaseDurationMs = 600_000;
export const leaseRenewalMs = 60_000;
const leaseFormat = 1;

export const LeaseRecordSchema = v.strictObject({
  formatVersion: v.literal(leaseFormat),
  environment: RemoteEnvironmentSchema,
  holder: v.pipe(v.string(), v.uuid()),
  provenance: RunProvenanceSchema,
  expiresAt: v.pipe(v.string(), v.isoTimestamp()),
});
export type LeaseRecord = v.InferOutput<typeof LeaseRecordSchema>;

export interface LeaseScheduler {
  repeat(intervalMs: number, task: () => Promise<void>): () => void;
}
export const intervalScheduler: LeaseScheduler = {
  repeat(intervalMs, task): () => void {
    const timer = setInterval(() => {
      task().catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return (): void => clearInterval(timer);
  },
};

export class LeaseRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LeaseRefused";
  }
}

export interface PublicationLease {
  readonly holder: string;
  assertHeld(): void;
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface LeaseOptions {
  readonly holder?: string;
  readonly scheduler?: LeaseScheduler;
  readonly monotonic?: () => number;
}

function decodeLease(
  environment: RemoteEnvironment,
  bytes: Uint8Array,
): LeaseRecord {
  const record = v.parse(
    LeaseRecordSchema,
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  if (record.environment !== environment)
    throw new Error("A publication lease belongs to another environment");
  return record;
}

function leaseTime(value: Date | string): number {
  const time = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isSafeInteger(time) || time < 0)
    throw new Error("A publication lease time is out of range");
  return time;
}

interface Observation {
  readonly decision: ReturnType<typeof leaseAdmission>;
  readonly record: LeaseRecord | null;
  readonly etag: string | null;
  readonly serverTimeMs: number;
}

async function observe(
  store: ControlStore,
  environment: RemoteEnvironment,
  holder: string,
): Promise<Observation> {
  const current = await store.read(controlKeys.lease(environment));
  const record = current.object
    ? decodeLease(environment, current.object.body)
    : null;
  const serverTimeMs = leaseTime(current.observedAt);
  return {
    decision: leaseAdmission(
      record !== null,
      record?.holder === holder,
      serverTimeMs,
      record ? leaseTime(record.expiresAt) : 0,
    ),
    record,
    etag: current.object?.etag ?? null,
    serverTimeMs,
  };
}

function leaseBytes(
  environment: RemoteEnvironment,
  holder: string,
  provenance: RunProvenance,
  expiresAtMs: number,
): Uint8Array {
  return encodeRecord(
    v.parse(LeaseRecordSchema, {
      formatVersion: leaseFormat,
      environment,
      holder,
      provenance,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }),
  );
}

function describeHolder(record: LeaseRecord | null): string {
  if (!record) return "an unknown publisher";
  return record.provenance.kind === "local"
    ? `a local publisher until ${record.expiresAt}`
    : `${record.provenance.workflow} run ${record.provenance.runId} until ${record.expiresAt}`;
}

export async function acquireLease(
  store: ControlStore,
  environment: RemoteEnvironment,
  provenance: RunProvenance,
  options: LeaseOptions = {},
): Promise<PublicationLease> {
  const holder = options.holder ?? randomUUID();
  const scheduler = options.scheduler ?? intervalScheduler;
  const monotonic = options.monotonic ?? ((): number => performance.now());
  const key = controlKeys.lease(environment);
  const observed = await observe(store, environment, holder);
  if (observed.decision !== "acquire" && observed.decision !== "takeover")
    throw new LeaseRefused(
      `The ${environment} publication lease is held by ${describeHolder(observed.record)}`,
    );
  let etag: string;
  try {
    etag = (
      await store.write(
        key,
        leaseBytes(
          environment,
          holder,
          provenance,
          observed.serverTimeMs + leaseDurationMs,
        ),
        observed.decision === "acquire" || observed.etag === null
          ? { kind: "create" }
          : { kind: "replace", etag: observed.etag },
      )
    ).etag;
  } catch (error) {
    if (isConflict(error))
      throw new LeaseRefused(
        `Another publisher acquired the ${environment} publication lease`,
        { cause: error },
      );
    throw error;
  }
  let confirmedAt = monotonic();
  let lost: Error | null = null;
  let released = false;
  let queue: Promise<void> = Promise.resolve();
  function serialized(task: () => Promise<void>): Promise<void> {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  }
  async function renewOnce(): Promise<void> {
    if (lost || released) return;
    const current = await observe(store, environment, holder);
    if (current.decision !== "renew" || current.etag !== etag) {
      lost = new LeaseRefused(
        `The ${environment} publication lease was lost to ${describeHolder(current.record)}`,
      );
      return;
    }
    try {
      etag = (
        await store.write(
          key,
          leaseBytes(
            environment,
            holder,
            provenance,
            current.serverTimeMs + leaseDurationMs,
          ),
          { kind: "replace", etag },
        )
      ).etag;
      confirmedAt = monotonic();
    } catch (error) {
      if (!isConflict(error)) throw error;
      lost = new LeaseRefused(
        `The ${environment} publication lease changed during renewal`,
        { cause: error },
      );
    }
  }
  const stop = scheduler.repeat(leaseRenewalMs, () => serialized(renewOnce));
  return {
    holder,
    assertHeld(): void {
      if (lost) throw lost;
      if (released)
        throw new LeaseRefused("The publication lease was released");
      if (monotonic() - confirmedAt >= leaseDurationMs - leaseRenewalMs)
        throw new LeaseRefused(
          `The ${environment} publication lease could not be renewed in time`,
        );
    },
    renew: (): Promise<void> => serialized(renewOnce),
    release: (): Promise<void> =>
      serialized(async () => {
        stop();
        if (released) return;
        released = true;
        if (lost) return;
        const current = await observe(store, environment, holder);
        if (current.record?.holder !== holder || current.etag !== etag) return;
        try {
          await store.write(
            key,
            leaseBytes(environment, holder, provenance, current.serverTimeMs),
            { kind: "replace", etag },
          );
        } catch (error) {
          if (!isConflict(error)) throw error;
        }
      }),
  };
}

export async function withLease<T>(
  store: ControlStore,
  environment: RemoteEnvironment,
  provenance: RunProvenance,
  task: (lease: PublicationLease) => Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lease = await acquireLease(store, environment, provenance, options);
  try {
    return await task(lease);
  } finally {
    await lease.release();
  }
}
