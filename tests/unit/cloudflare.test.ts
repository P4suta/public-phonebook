import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  overloadAttempts,
  overloaded,
  type RemoteSqlOptions,
  readOnlyBatch,
  remoteSql,
} from "../../tools/cloudflare.ts";
import type { SqlStatement } from "../../tools/remote-statements.ts";

const overload = new Error(
  "Cloudflare d1 query db failed: [7429] D1 DB is overloaded. Too many resources consumed within a 10 second window",
);
const reads: readonly SqlStatement[] = [
  { sql: "SELECT count(*) AS contacts FROM contacts", params: [] },
  { sql: "PRAGMA foreign_key_check", params: [] },
];
const writes: readonly SqlStatement[] = [
  { sql: "INSERT INTO contacts(id) VALUES (?)", params: ["a"] },
];
const answer = [
  { success: true, results: [{ contacts: 1 }] },
  { success: true, results: [] },
];

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "phonebook-d1-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Answers with the given outcomes in order and records each pause instead of waiting. */
function scripted(outcomes: readonly unknown[]): {
  readonly run: (args: readonly string[]) => Promise<unknown>;
  readonly pause: (milliseconds: number) => Promise<void>;
  readonly calls: () => number;
  readonly pauses: number[];
} {
  let calls = 0;
  const pauses: number[] = [];
  return {
    run: async (): Promise<unknown> => {
      const outcome = outcomes[calls];
      calls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    pause: async (milliseconds: number): Promise<void> => {
      pauses.push(milliseconds);
    },
    calls: (): number => calls,
    pauses,
  };
}

/** Options for a database that no Worker version binds, the only kind that may receive a read again. */
function unbound(script: ReturnType<typeof scripted>): RemoteSqlOptions {
  return { run: script.run, pause: script.pause, retryOverloadedReads: true };
}

describe("D1 overload handling", () => {
  it("classifies read-only batches and the overloaded error", () => {
    expect(readOnlyBatch(reads)).toBe(true);
    expect(
      readOnlyBatch([
        { sql: "  with x as (select 1) select * from x", params: [] },
      ]),
    ).toBe(true);
    expect(readOnlyBatch(writes)).toBe(false);
    expect(readOnlyBatch([...reads, ...writes])).toBe(false);
    expect(readOnlyBatch([{ sql: "PRAGMA foreign_keys=ON", params: [] }])).toBe(
      false,
    );
    expect(readOnlyBatch([])).toBe(false);
    expect(overloaded(overload)).toBe(true);
    expect(overloaded(new Error("D1_ERROR: no such table"))).toBe(false);
    expect(overloaded("[7429]")).toBe(false);
  });

  it("sends a read-only batch again after each overload, with growing pauses", async () => {
    const script = scripted([overload, overload, answer]);
    const sql = remoteSql("db", join(root, "request.json"), unbound(script));
    expect(await sql.execute(reads)).toEqual([{ contacts: 1 }]);
    expect(script.calls()).toBe(3);
    expect(script.pauses).toEqual([15_000, 30_000]);
  });

  it("fails a read-only batch on the first overload unless the database is unbound", async () => {
    for (const options of [{}, { retryOverloadedReads: false }]) {
      const script = scripted([overload, answer]);
      const sql = remoteSql("db", join(root, "request.json"), {
        ...options,
        run: script.run,
        pause: script.pause,
      });
      await expect(sql.execute(reads)).rejects.toBe(overload);
      expect(script.calls()).toBe(1);
      expect(script.pauses).toEqual([]);
    }
  });

  it("fails a write batch on the first overload", async () => {
    const script = scripted([overload, answer]);
    const sql = remoteSql("db", join(root, "request.json"), unbound(script));
    await expect(sql.execute(writes)).rejects.toBe(overload);
    expect(script.calls()).toBe(1);
    expect(script.pauses).toEqual([]);
  });

  it("fails a read-only batch at once on any other error", async () => {
    const other = new Error(
      "Cloudflare d1 query db failed: D1_ERROR: no such table",
    );
    const script = scripted([other, answer]);
    const sql = remoteSql("db", join(root, "request.json"), unbound(script));
    await expect(sql.execute(reads)).rejects.toBe(other);
    expect(script.calls()).toBe(1);
  });

  it("gives up after the fixed number of attempts", async () => {
    const script = scripted(
      Array.from({ length: overloadAttempts + 1 }, () => overload),
    );
    const sql = remoteSql("db", join(root, "request.json"), unbound(script));
    await expect(sql.execute(reads)).rejects.toBe(overload);
    expect(script.calls()).toBe(overloadAttempts);
    expect(script.pauses).toEqual([15_000, 30_000, 45_000]);
  });
});
