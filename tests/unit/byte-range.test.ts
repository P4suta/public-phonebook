import { describe, expect, it } from "vitest";
import { type ByteRange, byteRange } from "../../src/core/byte-range.ts";
import {
  rangeEnd,
  rangeStart,
  rangeVerdict,
} from "../../src/core/byte-range-policy.ts";

const largestSize = 6;
const largestPosition = 8;
const absent = -1;

/** RFC 9110 section 14.1.2 for one range, written apart from the policy. */
function oracle(
  first: number | null,
  last: number | null,
  size: number,
): ByteRange {
  if (first === null) {
    if (last === null || last === 0 || size === 0)
      return last === null ? { kind: "whole" } : { kind: "unsatisfiable" };
    return {
      kind: "partial",
      start: Math.max(size - last, 0),
      end: size - 1,
    };
  }
  if (last !== null && last < first) return { kind: "whole" };
  if (first >= size) return { kind: "unsatisfiable" };
  return {
    kind: "partial",
    start: first,
    end: last === null ? size - 1 : Math.min(last, size - 1),
  };
}

describe("byte ranges", () => {
  it("matches RFC 9110 for every single range up to the bounds", () => {
    let checked = 0;
    for (let size = 0; size <= largestSize; size += 1)
      for (let first = absent; first <= largestPosition; first += 1)
        for (let last = absent; last <= largestPosition; last += 1) {
          const before = first === absent ? "" : String(first);
          const after = last === absent ? "" : String(last);
          const header = `bytes=${before}-${after}`;
          const expected = oracle(
            first === absent ? null : first,
            last === absent ? null : last,
            size,
          );
          expect(byteRange(header, size), `${header} of ${size}`).toEqual(
            expected,
          );
          const served = byteRange(header, size);
          if (served.kind === "partial") {
            expect(served.start).toBeGreaterThanOrEqual(0);
            expect(served.end).toBeLessThan(size);
            expect(served.start).toBeLessThanOrEqual(served.end);
          }
          checked += 1;
        }
    expect(checked).toBe((largestSize + 1) * (largestPosition + 2) ** 2);
  });

  it("serves the whole object for a missing, foreign, malformed, or multiple range", () => {
    for (const header of [
      undefined,
      "",
      "items=0-1",
      "bytes=",
      "bytes=-",
      "bytes=a-1",
      "bytes=1-a",
      "bytes=1.5-2",
      "bytes=+1-2",
      "bytes=0-1,4-5",
      "bytes=0-1, 4-5",
      "bytes=５-6",
      "bytes 0-1",
    ])
      expect(byteRange(header, 10), String(header)).toEqual({ kind: "whole" });
  });

  it("reads the unit without regard to case and around surrounding spaces", () => {
    expect(byteRange(" Bytes=2-3 ", 10)).toEqual({
      kind: "partial",
      start: 2,
      end: 3,
    });
  });

  it("treats a position beyond safe integers as larger than every object", () => {
    expect(byteRange("bytes=99999999999999999999-", 10)).toEqual({
      kind: "unsatisfiable",
    });
    expect(byteRange("bytes=-99999999999999999999", 10)).toEqual({
      kind: "partial",
      start: 0,
      end: 9,
    });
    expect(byteRange("bytes=0-99999999999999999999", 10)).toEqual({
      kind: "partial",
      start: 0,
      end: 9,
    });
  });

  it("keeps the verified arithmetic within the object", () => {
    expect(rangeVerdict(absent, absent, 0, 10)).toBe("unsatisfiable");
    expect(rangeVerdict(3, 2, absent, 10)).toBe("whole");
    expect(rangeStart(absent, 20, 10)).toBe(0);
    expect(rangeStart(absent, 4, 10)).toBe(6);
    expect(rangeEnd(6, absent, 10)).toBe(9);
    expect(rangeEnd(2, 30, 10)).toBe(9);
    expect(rangeEnd(2, 5, 10)).toBe(5);
  });
});
