import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseAdmission } from "../../src/core/publication-policy.ts";
import {
  acquireLease,
  LeaseRefused,
  type LeaseScheduler,
  leaseDurationMs,
  leaseRenewalMs,
  withLease,
} from "../../tools/control-lease.ts";
import {
  type ControlStore,
  controlKeys,
  fileControlStore,
  readObject,
} from "../../tools/control-store.ts";

const serverStart = Date.parse("2031-05-06T07:08:09.000Z");

class ManualScheduler implements LeaseScheduler {
  readonly tasks: { intervalMs: number; task: () => Promise<void> }[] = [];
  stopped = 0;
  repeat(intervalMs: number, task: () => Promise<void>): () => void {
    const entry = { intervalMs, task };
    this.tasks.push(entry);
    return (): void => {
      this.stopped += 1;
      this.tasks.splice(this.tasks.indexOf(entry), 1);
    };
  }
  async tick(): Promise<void> {
    for (const entry of [...this.tasks]) await entry.task();
  }
}

let directory = "";
let serverTime = serverStart;
let localTime = 0;
let store: ControlStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phonebook-lease-"));
  serverTime = serverStart;
  localTime = 0;
  store = fileControlStore(directory, { now: () => new Date(serverTime) });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function storedLease(): Promise<{ holder: string; expiresAt: string }> {
  const object = await readObject(store, controlKeys.lease("production"));
  if (!object) throw new Error("No lease");
  const record: unknown = JSON.parse(new TextDecoder().decode(object.body));
  if (
    typeof record !== "object" ||
    record === null ||
    !("holder" in record) ||
    !("expiresAt" in record) ||
    typeof record.holder !== "string" ||
    typeof record.expiresAt !== "string"
  )
    throw new Error("Malformed lease");
  return { holder: record.holder, expiresAt: record.expiresAt };
}

describe("lease admission", () => {
  it("acquires an absent lease, renews only its own live lease, and takes over only an expired foreign lease", () => {
    expect(leaseAdmission(false, false, 5, 0)).toBe("acquire");
    expect(leaseAdmission(true, true, 4, 5)).toBe("renew");
    expect(leaseAdmission(true, true, 5, 5)).toBe("lost");
    expect(leaseAdmission(true, false, 4, 5)).toBe("refuse");
    expect(leaseAdmission(true, false, 5, 5)).toBe("takeover");
  });
});

describe("publication lease", () => {
  it("expires ten minutes after the server's time, not the local clock, and renews every minute", async () => {
    const scheduler = new ManualScheduler();
    const lease = await acquireLease(
      store,
      "production",
      { kind: "local" },
      {
        scheduler,
        monotonic: () => localTime,
      },
    );
    expect(scheduler.tasks.map((task) => task.intervalMs)).toEqual([
      leaseRenewalMs,
    ]);
    expect(await storedLease()).toEqual({
      holder: lease.holder,
      expiresAt: new Date(serverStart + leaseDurationMs).toISOString(),
    });
    serverTime += leaseRenewalMs;
    localTime += leaseRenewalMs;
    await scheduler.tick();
    expect((await storedLease()).expiresAt).toBe(
      new Date(serverStart + leaseRenewalMs + leaseDurationMs).toISOString(),
    );
    lease.assertHeld();
    await lease.release();
    expect(scheduler.stopped).toBe(1);
    expect(() => lease.assertHeld()).toThrow("released");
    const next = await acquireLease(
      store,
      "production",
      { kind: "local" },
      {
        scheduler: new ManualScheduler(),
      },
    );
    expect(next.holder).not.toBe(lease.holder);
  });

  it("lets exactly one of two concurrent publishers win", async () => {
    const results = await Promise.allSettled([
      acquireLease(
        store,
        "production",
        { kind: "local" },
        {
          scheduler: new ManualScheduler(),
        },
      ),
      acquireLease(
        store,
        "production",
        { kind: "local" },
        {
          scheduler: new ManualScheduler(),
        },
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(
      LeaseRefused,
    );
  });

  it("refuses a live foreign lease, allows takeover after expiry, and stops the previous holder", async () => {
    const firstScheduler = new ManualScheduler();
    const first = await acquireLease(
      store,
      "production",
      { kind: "local" },
      {
        scheduler: firstScheduler,
        monotonic: () => localTime,
      },
    );
    serverTime += leaseDurationMs - 1;
    await expect(
      acquireLease(
        store,
        "production",
        { kind: "local" },
        {
          scheduler: new ManualScheduler(),
        },
      ),
    ).rejects.toThrow("held by a local publisher");
    serverTime += 1;
    const second = await acquireLease(
      store,
      "production",
      { kind: "local" },
      {
        scheduler: new ManualScheduler(),
      },
    );
    expect((await storedLease()).holder).toBe(second.holder);
    await firstScheduler.tick();
    expect(() => first.assertHeld()).toThrow("lost");
    await first.release();
    expect((await storedLease()).holder).toBe(second.holder);
    second.assertHeld();
  });

  it("stops trusting a lease it couldn't renew before the margin", async () => {
    const lease = await acquireLease(
      store,
      "production",
      { kind: "local" },
      {
        scheduler: new ManualScheduler(),
        monotonic: () => localTime,
      },
    );
    localTime += leaseDurationMs - leaseRenewalMs - 1;
    lease.assertHeld();
    localTime += 1;
    expect(() => lease.assertHeld()).toThrow("in time");
  });

  it("releases the lease even when the guarded task fails", async () => {
    await expect(
      withLease(
        store,
        "production",
        { kind: "local" },
        async () => {
          throw new Error("task failed");
        },
        { scheduler: new ManualScheduler() },
      ),
    ).rejects.toThrow("task failed");
    await acquireLease(
      store,
      "production",
      { kind: "local" },
      {
        scheduler: new ManualScheduler(),
      },
    );
  });
});
