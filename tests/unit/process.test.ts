import { describe, expect, it } from "vitest";
import { mapConcurrently, meterCount } from "../../tools/process.ts";

const items = [1, 2, 3, 4, 5, 6, 7];
const limit = 3;
const failingItem = 2;
const laterFailingItem = 5;

interface Gate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("step meter records", () => {
  it("reads a count and the descendant flag, and treats anything else as no count", () => {
    expect(
      meterCount('{"instructions":12345,"reapedDescendants":true}\n'),
    ).toEqual({ instructions: 12345, reapedDescendants: true });
    for (const record of [
      '{"instructions":null,"reapedDescendants":null,"reason":"Unsupported"}',
      '{"instructions":-1,"reapedDescendants":false}',
      '{"instructions":1.5,"reapedDescendants":false}',
      '{"instructions":1,"reapedDescendants":false,"extra":1}',
      "not json",
      "",
    ])
      expect(meterCount(record), record).toBeNull();
  });
});

describe("bounded concurrency", () => {
  it("never runs more than the limit at once and returns results in input order", async () => {
    const gates = new Map(items.map((item) => [item, gate()]));
    let running = 0;
    let peak = 0;
    const result = mapConcurrently(items, limit, async (item) => {
      running += 1;
      peak = Math.max(peak, running);
      await gates.get(item)?.opened;
      running -= 1;
      return item * item;
    });
    for (const item of [...items].reverse()) {
      await Promise.resolve();
      gates.get(item)?.open();
    }
    expect(await result).toEqual(items.map((item) => item * item));
    expect(peak).toBe(limit);
  });

  it("runs every item after a failure and rethrows the first failure in input order", async () => {
    const started: number[] = [];
    const run = mapConcurrently(items, limit, async (item) => {
      started.push(item);
      await Promise.resolve();
      if (item === laterFailingItem) throw new Error("later");
      if (item === failingItem) throw new Error("first");
      return item;
    });
    await expect(run).rejects.toThrow("first");
    expect(started.toSorted((left, right) => left - right)).toEqual(items);
  });

  it("accepts an empty list and refuses a limit below one", async () => {
    expect(await mapConcurrently([], limit, async () => 0)).toEqual([]);
    await expect(mapConcurrently(items, 0, async () => 0)).rejects.toThrow(
      "positive integer",
    );
  });
});
