export function packedSectionFits(
  offset: number,
  length: number,
  size: number,
): boolean {
  //@ verify
  //@ requires offset >= 0 && offset <= 268435456 && length >= 0 && length <= 268435456 && size >= 0 && size <= 268435456
  //@ ensures \result === (offset + length <= size)
  return offset <= size && length <= size - offset;
}

export function packedShortCount(count: number): number {
  //@ verify
  //@ requires count >= 0 && count <= 2000000
  //@ ensures \result >= 0 && \result <= 100 && \result <= count
  //@ ensures count <= 100 ==> \result === count
  //@ ensures count > 100 ==> \result === 100
  return count > maximumShortMatches ? maximumShortMatches : count;
}

export function packedScratchSum(
  total: number,
  increment: number,
  _limit: number,
): number {
  //@ verify
  //@ requires _limit >= 1 && _limit <= 25600000 && increment >= 1 && increment <= _limit && total >= 0 && total <= _limit - increment
  //@ ensures \result === total + increment
  //@ ensures \result >= 1 && \result <= _limit && \result < 4294967296
  return total + increment;
}
const maximumShortMatches = 100;
