export function qualityPasses(
  total: number,
  top1: number,
  top3: number,
  top10: number,
  expected: number,
  minimum1: number,
  minimum3: number,
  minimum10: number,
): boolean {
  //@ verify
  //@ requires total >= 0 && total <= 1000000 && expected >= 0 && expected <= 1000000
  //@ requires top1 >= 0 && top1 <= top3 && top3 <= top10 && top10 <= total
  //@ requires minimum1 >= 0 && minimum1 <= minimum3 && minimum3 <= minimum10 && minimum10 <= expected
  //@ ensures \result === (total > 0 && total === expected && top1 >= minimum1 && top3 >= minimum3 && top10 >= minimum10)
  return (
    total > 0 &&
    total === expected &&
    top1 >= minimum1 &&
    top3 >= minimum3 &&
    top10 >= minimum10
  );
}
