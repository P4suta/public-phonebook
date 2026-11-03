import { rangeEnd, rangeStart, rangeVerdict } from "./byte-range-policy.ts";

// A missing first position, last position, or suffix length.
const absent = -1;
const rangeUnit = "bytes=";
// Up to 15 decimal digits stay a safe integer; a longer number exceeds every object.
const safeDigits = /^[0-9]{1,15}$/u;
const decimalDigits = /^[0-9]+$/u;
const largeNumber = Number.MAX_SAFE_INTEGER;

export type ByteRange =
  | { readonly kind: "whole" }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number };

/** Reads a position, or returns -1 for an empty one and null for text that isn't a decimal number. */
function position(text: string): number | null {
  if (text === "") return absent;
  if (safeDigits.test(text)) return Number(text);
  return decimalDigits.test(text) ? largeNumber : null;
}

/**
 * Reads a `Range` header for an object of `size` bytes.
 * A missing, malformed, or multiple-range header serves the whole object, as RFC 9110 lets a server ignore it.
 */
export function byteRange(header: string | undefined, size: number): ByteRange {
  const whole: ByteRange = { kind: "whole" };
  const spec = header?.trim() ?? "";
  if (spec.slice(0, rangeUnit.length).toLowerCase() !== rangeUnit) return whole;
  const set = spec.slice(rangeUnit.length);
  const separator = set.indexOf("-");
  if (separator < 0 || set.includes(",")) return whole;
  const before = position(set.slice(0, separator));
  const after = position(set.slice(separator + 1));
  if (before === null || after === null) return whole;
  const first = before;
  const last = before === absent ? absent : after;
  const suffix = before === absent ? after : absent;
  const verdict = rangeVerdict(first, last, suffix, size);
  if (verdict !== "partial") return { kind: verdict };
  const start = rangeStart(first, suffix, size);
  return { kind: "partial", start, end: rangeEnd(start, last, size) };
}
