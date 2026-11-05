const diceScale = 20_000;
const scoreMaximum = 1_000_000;
const nonexactMaximum = 999_999;
const preferenceScale = 499_999;
const preferenceTier = 500_000;
const lexicalMixtureWeight = 7;
const characterMixtureWeight = 3;
const mixtureDenominator = 10;
const scoreUnit = 100;
const readingExactBase = 900_000;
const readingExactWeight = 9;
const readingLiteralWeight = 20;
const readingPhoneticWeight = 60;
const conservativeLexicalMaximum = 600_000;
const readingRatioThreshold = 1250;
const kanaShareThreshold = 500;
const binarySearchBranches = 2;

export function packedMidpoint(low: number, high: number): number {
  //@ verify
  //@ requires low >= 0 && low < high && high <= 268435456
  //@ ensures \result >= low && \result < high
  return low + Math.floor((high - low) / binarySearchBranches);
}

export const rankingLimits = {
  queryPoints: 256,
  results: 100,
  lexicalCandidates: 200,
  readingCandidates: 512,
  readingPaths: 8,
  readingGrams: 6,
  inverseFrequency: 100_000,
  nameWeight: 100_000_000_000_000,
  ratio: 4000,
  fraction: 1000,
  exactScore: scoreMaximum,
  aliasScore: 990_000,
} as const;

export function diceScore(shared: number, query: number, name: number): number {
  //@ verify
  //@ requires query >= 0 && query <= 25600000 && name >= 0 && name <= 100000000000000
  //@ requires shared >= 0 && shared <= query && shared <= name
  //@ ensures \result >= 0 && \result <= 10000
  //@ ensures query + name === 0 ==> \result === 0
  const total = query + name;
  if (total === 0) return 0;
  //@ assert total >= 1
  const numerator = diceScale * shared;
  //@ assert 2 * shared <= total
  //@ assert numerator >= 0 && numerator <= 10000 * total
  return boundedDiceQuotient(numerator, total);
}

export function boundedDiceQuotient(
  numerator: number,
  denominator: number,
): number {
  //@ verify
  //@ requires numerator >= 0 && numerator <= 512000000000
  //@ requires denominator >= 1 && denominator <= 100000025600000
  //@ requires numerator <= 10000 * denominator
  //@ ensures \result >= 0 && \result <= 10000
  const score = Math.floor(numerator / denominator);
  //@ assert score >= 0
  //@ ghost let remainder = numerator % denominator
  //@ assert remainder >= 0 && remainder < denominator
  //@ assert numerator === score * denominator + remainder
  //@ assert score * denominator <= 10000 * denominator
  //@ ghost let gap = score - 10000
  //@ assert gap * denominator <= 0
  //@ assert gap <= 0 || (gap - 1) * denominator >= 0
  //@ assert gap <= 0 || gap * denominator >= denominator
  //@ assert score <= 10000
  return score;
}

export function mixedNameScore(bigram: number, unigram: number): number {
  //@ verify
  //@ requires bigram >= 0 && bigram <= 10000 && unigram >= 0 && unigram <= 10000
  //@ ensures \result >= 0 && \result <= 1000000
  return (
    Math.floor(
      (bigram * lexicalMixtureWeight + unigram * characterMixtureWeight) /
        mixtureDenominator,
    ) * scoreUnit
  );
}

export function readingNameScore(
  literal: boolean,
  exactKana: boolean,
  lexical: number,
  kana: number,
): number {
  //@ verify
  //@ requires lexical >= 0 && lexical <= 10000 && kana >= 0 && kana <= 10000
  //@ ensures \result >= 0 && \result <= 1000000
  //@ ensures literal ==> \result === 1000000
  //@ ensures !literal && exactKana ==> \result >= 900000 && \result <= 990000
  //@ ensures !literal && !exactKana ==> \result <= 800000
  if (literal) return scoreMaximum;
  if (exactKana) return readingExactBase + lexical * readingExactWeight;
  return lexical * readingLiteralWeight + kana * readingPhoneticWeight;
}

export function nonexactSignalScore(score: number): number {
  //@ verify
  //@ requires score >= 0 && score <= 1000000
  //@ ensures \result >= 0 && \result < 1000000
  return score === scoreMaximum ? nonexactMaximum : score;
}

export function preferredNameScore(score: number, preferred: boolean): number {
  //@ verify
  //@ requires score >= 0 && score <= 1000000
  //@ ensures \result >= 0 && \result < 1000000
  //@ ensures preferred ==> \result >= 500000
  //@ ensures !preferred ==> \result < 500000
  return (
    Math.floor((score * preferenceScale) / scoreMaximum) +
    (preferred ? preferenceTier : 0)
  );
}

export function conservativeReading(
  han: boolean,
  lexical: number,
  reading: number,
): boolean {
  //@ verify
  //@ requires lexical >= 0 && lexical <= 1000000 && reading >= 0 && reading <= 1000000
  //@ ensures \result === (reading >= 900000 && lexical <= 600000 && (!han || reading > 900000))
  return (
    reading >= readingExactBase &&
    lexical <= conservativeLexicalMaximum &&
    (!han || reading > readingExactBase)
  );
}

export function readingGate(
  ratio: number,
  kanaShare: number,
  alias: boolean,
  conservative: boolean,
  present: boolean,
  locked: boolean,
): boolean {
  //@ verify
  //@ requires ratio >= 0 && ratio <= 4000 && kanaShare >= 0 && kanaShare <= 1000
  //@ ensures \result ==> present && !locked
  //@ ensures \result === (present && !locked && (alias || conservative || (ratio > 1250 && kanaShare > 500)))
  return (
    present &&
    !locked &&
    (alias ||
      conservative ||
      (ratio > readingRatioThreshold && kanaShare > kanaShareThreshold))
  );
}

export function unweightedDice(
  query: readonly string[],
  name: readonly string[],
): number {
  const own = new Set(name);
  let shared = 0;
  for (const gram of query) if (own.has(gram)) shared += 1;
  return diceScore(shared, query.length, name.length);
}

export function compareSearchText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
