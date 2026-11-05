import type { RankedHit } from "./forgiving-search.ts";
import {
  diceScore,
  mixedNameScore,
  rankingLimits,
} from "./forgiving-search-policy.ts";
import { packedScratchSum } from "./packed-ranking-policy.ts";
import type { RankingArtifact } from "./search-ranking-artifact.ts";
import { compactSearchText, searchGrams } from "./search-ranking-text.ts";

interface Candidate extends RankedHit {
  readonly bigram: number;
}
const bigramWidth = 2;
const unigramWidth = 1;
const heapBranches = 2;

function worse(left: Candidate, right: Candidate): boolean {
  return (
    left.bigram < right.bigram ||
    (left.bigram === right.bigram && left.row > right.row)
  );
}

function retainCandidate(heap: Candidate[], row: number, bigram: number): void {
  const minimum = heap[0];
  if (
    heap.length >= rankingLimits.lexicalCandidates &&
    (!minimum ||
      bigram < minimum.bigram ||
      (bigram === minimum.bigram && row >= minimum.row))
  )
    return;
  const item: Candidate = { row, score: 0, bigram };
  if (heap.length < rankingLimits.lexicalCandidates) {
    heap.push(item);
    let at = heap.length - 1;
    while (at > 0) {
      const parent = Math.floor((at - 1) / heapBranches);
      const previous = heap[parent];
      if (!previous || !worse(item, previous)) break;
      heap[at] = previous;
      heap[parent] = item;
      at = parent;
    }
    return;
  }
  const root = heap[0];
  if (!root || !worse(root, item)) return;
  heap[0] = item;
  let at = 0;
  for (;;) {
    const left = at * heapBranches + 1;
    const right = left + 1;
    let chosen = at;
    const current = heap[chosen];
    const leftItem = heap[left];
    if (current && leftItem && worse(leftItem, current)) chosen = left;
    const selected = heap[chosen];
    const rightItem = heap[right];
    if (selected && rightItem && worse(rightItem, selected)) chosen = right;
    if (chosen === at) break;
    const child = heap[chosen];
    const parent = heap[at];
    if (!child || !parent) throw new Error("Missing lexical heap entry");
    heap[at] = child;
    heap[chosen] = parent;
    at = chosen;
  }
}

export function lexicalSearch(
  names: readonly string[],
  artifact: RankingArtifact,
): (query: string) => readonly RankedHit[] {
  const postings = new Map(
    artifact.lexical.map(([gram, weight, rows]) => [gram, { weight, rows }]),
  );
  const norms = Array.from(
    { length: artifact.packed ? 0 : names.length },
    () => 0,
  );
  for (const [, weight, rows] of artifact.packed ? [] : artifact.lexical) {
    if (
      !Number.isSafeInteger(weight) ||
      weight < 1 ||
      weight > rankingLimits.inverseFrequency
    )
      throw new Error("Invalid lexical integer weight");
    for (const row of rows) {
      const norm = norms[row];
      if (norm === undefined)
        throw new Error("Lexical posting outside snapshot");
      norms[row] = norm + weight;
      if ((norms[row] ?? 0) > rankingLimits.nameWeight)
        throw new Error("Lexical norm exceeds exact arithmetic");
    }
  }
  const characterCounts =
    artifact.packed?.characters ??
    names.map((name) => searchGrams(name, unigramWidth).length);
  const sums = artifact.packed ? new Uint32Array(names.length) : null;
  const touched = artifact.packed ? new Uint32Array(names.length) : null;
  return (query) => {
    const folded = compactSearchText(query);
    const grams = searchGrams(folded, bigramWidth);
    const shared = new Map<number, number>();
    let touchedCount = 0;
    let queryWeight = 0;
    if (artifact.packed && grams.length > rankingLimits.queryPoints) return [];
    const heap: Candidate[] = [];
    try {
      for (const gram of grams) {
        if (artifact.packed && sums && touched) {
          const weight = artifact.packed.dictionaries.lexical.visit(
            gram,
            (row, weight) => {
              const previous = sums[row];
              if (previous === undefined)
                throw new Error("Lexical posting outside snapshot");
              if (previous === 0) touched[touchedCount++] = row;
              sums[row] = packedScratchSum(
                previous,
                weight,
                rankingLimits.queryPoints * rankingLimits.inverseFrequency,
              );
            },
          );
          queryWeight += weight ?? artifact.unknownWeight;
        } else {
          const posting = postings.get(gram);
          queryWeight += posting?.weight ?? artifact.unknownWeight;
          for (const row of posting?.rows ?? [])
            shared.set(row, (shared.get(row) ?? 0) + (posting?.weight ?? 0));
        }
      }
      const retain = (row: number, sum: number): void => {
        retainCandidate(
          heap,
          row,
          diceScore(
            sum,
            queryWeight,
            artifact.packed ? artifact.packed.norm(row) : (norms[row] ?? 0),
          ),
        );
      };
      if (sums && touched)
        for (let at = 0; at < touchedCount; at += 1) {
          const row = touched[at];
          if (row !== undefined) retain(row, sums[row] ?? 0);
        }
      else for (const [row, sum] of shared) retain(row, sum);
    } finally {
      if (sums && touched)
        for (let at = 0; at < touchedCount; at += 1) {
          const row = touched[at];
          if (row !== undefined) sums[row] = 0;
        }
    }
    const queryCharacters = searchGrams(folded, unigramWidth);
    return heap
      .map((candidate) => {
        const name = artifact.packed
          ? artifact.packed.name(candidate.row)
          : (names[candidate.row] ?? "");
        let overlap = 0;
        for (const character of queryCharacters)
          if (name.includes(character)) overlap += 1;
        return {
          row: candidate.row,
          score: mixedNameScore(
            candidate.bigram,
            diceScore(
              overlap,
              queryCharacters.length,
              artifact.packed
                ? artifact.packed.characterCount(candidate.row)
                : (characterCounts[candidate.row] ?? 0),
            ),
          ),
        };
      })
      .sort((left, right) => right.score - left.score || left.row - right.row)
      .slice(0, rankingLimits.results);
  };
}
