// A missing first position, last position, or suffix length.
const absent = -1;

export type RangeVerdict = "whole" | "partial" | "unsatisfiable";

/**
 * Judges one `first-last`, `first-`, or `-suffix` range of RFC 9110 against an object of `size` bytes, where -1 marks a missing number.
 */
export function rangeVerdict(
  first: number,
  last: number,
  suffix: number,
  size: number,
): RangeVerdict {
  //@ verify
  //@ requires size >= 0 && first >= -1 && last >= -1 && suffix >= -1
  //@ ensures (\result === "partial") === ((first >= 0 && suffix === -1 && (last === -1 || first <= last) && first < size) || (first === -1 && last === -1 && suffix >= 1 && size >= 1))
  //@ ensures (\result === "unsatisfiable") === ((first >= 0 && suffix === -1 && (last === -1 || first <= last) && first >= size) || (first === -1 && last === -1 && (suffix === 0 || (suffix >= 1 && size === 0))))
  //@ ensures \result === "partial" ==> size >= 1
  if (first >= 0 && suffix === absent) {
    if (last !== absent && last < first) return "whole";
    return first < size ? "partial" : "unsatisfiable";
  }
  if (first === absent && last === absent && suffix >= 0)
    return suffix >= 1 && size >= 1 ? "partial" : "unsatisfiable";
  return "whole";
}

/** The first byte that a partial range serves. */
export function rangeStart(
  first: number,
  suffix: number,
  size: number,
): number {
  //@ verify
  //@ requires size >= 1 && ((first >= 0 && first < size && suffix === -1) || (first === -1 && suffix >= 1))
  //@ ensures \result >= 0 && \result < size
  //@ ensures first >= 0 ==> \result === first
  //@ ensures first === -1 ==> \result === (suffix < size ? size - suffix : 0)
  if (first >= 0) return first;
  return suffix < size ? size - suffix : 0;
}

/** The last byte that a partial range serves, which never passes the object's end. */
export function rangeEnd(start: number, last: number, size: number): number {
  //@ verify
  //@ requires size >= 1 && start >= 0 && start < size && (last === -1 || last >= start)
  //@ ensures \result >= start && \result < size
  //@ ensures \result === (last !== -1 && last < size ? last : size - 1)
  if (last === absent || last >= size) return size - 1;
  return last < start ? start : last;
}
