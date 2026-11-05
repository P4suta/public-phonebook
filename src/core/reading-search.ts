import type { RankedHit } from "./forgiving-search.ts";
import {
  compareSearchText,
  diceScore,
  rankingLimits,
  readingNameScore,
  unweightedDice,
} from "./forgiving-search-policy.ts";
import { lazyArray, type PackedRanking } from "./packed-ranking.ts";
import { packedScratchSum } from "./packed-ranking-policy.ts";
import type { RankingArtifact } from "./search-ranking-artifact.ts";
import { compactSearchText, searchGrams } from "./search-ranking-text.ts";

interface ReadingChoice {
  readonly reading: string;
  count: number;
}
interface ReadingNode {
  readonly children: Map<string, ReadingNode>;
  readonly choices: ReadingChoice[];
}
interface ReadingPath {
  readonly reading: string;
  readonly cost: number;
}
interface ReadingRow {
  readonly literal: string;
  readonly reading: string;
}
const trigramWidth = 3;
const unknownHanCost = 1000;
const maximumTokenPoints = 8192;

export function packedTrigramDice(
  query: readonly string[],
  name: string,
  count: number,
): number {
  let shared = 0;
  for (const gram of query) {
    let points = 0;
    for (const _point of gram) points += 1;
    if (
      points < trigramWidth
        ? name === gram
        : /\p{Surrogate}/u.test(gram)
          ? searchGrams(name, trigramWidth).includes(gram)
          : name.includes(gram)
    )
      shared += 1;
  }
  return diceScore(shared, query.length, count);
}

function readingNode(): ReadingNode {
  return { children: new Map(), choices: [] };
}

function readingTrie(lexicon: RankingArtifact["lexicon"]): ReadingNode {
  const root = readingNode();
  for (const [surface, value, count] of lexicon) {
    const key = compactSearchText(surface);
    const reading = compactSearchText(value);
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      Array.from(reading).length > maximumTokenPoints
    )
      throw new Error("Invalid reading lexicon entry");
    if (!key || !reading) continue;
    let node = root;
    for (const point of key) {
      const child = node.children.get(point) ?? readingNode();
      node.children.set(point, child);
      node = child;
    }
    const previous = node.choices.find((choice) => choice.reading === reading);
    if (previous) {
      if (!Number.isSafeInteger(previous.count + count))
        throw new Error("Reading lexicon count overflow");
      previous.count += count;
    } else node.choices.push({ reading, count });
  }
  return root;
}

function retainPath(paths: ReadingPath[], candidate: ReadingPath): void {
  const duplicate = paths.findIndex(
    (path) => path.reading === candidate.reading,
  );
  if (duplicate >= 0) {
    if ((paths[duplicate]?.cost ?? Infinity) <= candidate.cost) return;
    paths.splice(duplicate, 1);
  }
  paths.push(candidate);
  paths.sort(
    (a, b) => a.cost - b.cost || compareSearchText(a.reading, b.reading),
  );
  if (paths.length > rankingLimits.readingPaths)
    paths.length = rankingLimits.readingPaths;
}

function readingsFor(
  query: string,
  root: ReadingNode,
  packed?: PackedRanking,
): readonly string[] {
  const points = Array.from(compactSearchText(query));
  const paths: ReadingPath[][] = Array.from(
    { length: points.length + 1 },
    () => [],
  );
  paths[0]?.push({ reading: "", cost: 0 });
  const choiceCache = new Map<string, readonly string[] | null>();
  for (let at = 0; at < points.length; at += 1) {
    for (const path of paths[at] ?? []) {
      const point = points[at] ?? "";
      const fallback = paths[at + 1];
      if (!fallback) throw new Error("Reading path outside input bounds");
      retainPath(fallback, {
        reading: path.reading + point,
        cost: path.cost + (/\p{Script=Han}/u.test(point) ? unknownHanCost : 0),
      });
      let node: ReadingNode | undefined = root;
      let surface = "";
      for (let end = at; end < points.length; end += 1) {
        surface += points[end] ?? "";
        node = node?.children.get(points[end] ?? "");
        if (!packed && !node) break;
        if (packed && !choiceCache.has(surface))
          choiceCache.set(surface, packed.choices(surface) ?? null);
        const packedChoices = choiceCache.get(surface);
        if (packed && packedChoices === null) break;
        const choices = packed
          ? (packedChoices ?? []).map((reading) => ({ reading }))
          : (node?.choices ?? [])
              .toSorted(
                (a, b) =>
                  b.count - a.count || compareSearchText(a.reading, b.reading),
              )
              .slice(0, rankingLimits.readingPaths);
        const destination = paths[end + 1];
        if (!destination) throw new Error("Reading path outside input bounds");
        for (const [rank, choice] of choices.entries())
          retainPath(destination, {
            reading: path.reading + choice.reading,
            cost: path.cost + 1 + rank,
          });
      }
    }
  }
  return [...new Set((paths[points.length] ?? []).map((path) => path.reading))];
}

function addExact(map: Map<string, number[]>, key: string, row: number): void {
  const values = map.get(key) ?? [];
  values.push(row);
  map.set(key, values);
}

export function readingSearch(
  names: readonly string[],
  artifact: RankingArtifact,
): (query: string) => readonly RankedHit[] {
  const packed = artifact.packed;
  const trie = packed ? readingNode() : readingTrie(artifact.lexicon);
  const literalExact = new Map<string, number[]>();
  const readingExact = new Map<string, number[]>();
  const postings = new Map(
    (packed ? [] : artifact.phonetic).map(([gram, , rows]) => [gram, rows]),
  );
  const rowAt = (row: number): ReadingRow => ({
    literal: packed ? packed.literal(row) : compactSearchText(names[row] ?? ""),
    reading: packed
      ? packed.reading(row)
      : compactSearchText(artifact.readings[row] ?? ""),
  });
  const rows = packed
    ? lazyArray(names.length, rowAt)
    : names.map((name, row) => {
        const literal = compactSearchText(name);
        const reading = compactSearchText(artifact.readings[row] ?? "");
        addExact(literalExact, literal, row);
        addExact(readingExact, reading, row);
        return {
          literal,
          reading,
        };
      });
  const frequencies = packed ? new Uint8Array(names.length) : null;
  const touched = packed ? new Uint32Array(names.length) : null;
  return (query) => {
    const literal = compactSearchText(query);
    if (!literal || Array.from(literal).length > rankingLimits.queryPoints)
      return [];
    const readings = readingsFor(query, trie, packed);
    const exact = new Set(
      (packed
        ? packed.exact("literal", literal, packed.literal)
        : literalExact.get(literal)) ?? [],
    );
    for (const reading of readings)
      for (const row of (packed
        ? packed.exact("reading", reading, packed.reading)
        : readingExact.get(reading)) ?? [])
        exact.add(row);
    const lexical = searchGrams(literal, trigramWidth);
    const phonetic = readings.map((reading) =>
      searchGrams(reading, trigramWidth),
    );
    let candidates = [...exact];
    if (!candidates.length) {
      const selected = [...new Set([...lexical, ...phonetic.flat()])]
        .filter((gram) =>
          packed
            ? packed.dictionaries.phonetic.count(gram) > 0
            : postings.has(gram),
        )
        .sort(
          (a, b) =>
            (packed
              ? packed.dictionaries.phonetic.count(a) -
                packed.dictionaries.phonetic.count(b)
              : (postings.get(a)?.length ?? 0) -
                (postings.get(b)?.length ?? 0)) || compareSearchText(a, b),
        )
        .slice(0, rankingLimits.readingGrams);
      const counts = new Map<number, number>();
      if (packed && frequencies && touched) {
        let count = 0;
        try {
          for (const gram of selected)
            packed.dictionaries.phonetic.visit(gram, (row) => {
              const previous = frequencies[row];
              if (previous === undefined)
                throw new Error("Reading posting outside snapshot");
              if (previous === 0) touched[count++] = row;
              frequencies[row] = packedScratchSum(
                previous,
                1,
                rankingLimits.readingGrams,
              );
            });
          const ordered = touched.subarray(0, count);
          ordered.sort(
            (a, b) => (frequencies[b] ?? 0) - (frequencies[a] ?? 0) || a - b,
          );
          candidates = Array.from(
            ordered.subarray(0, rankingLimits.readingCandidates),
          );
        } finally {
          for (let at = 0; at < count; at += 1) {
            const row = touched[at];
            if (row !== undefined) frequencies[row] = 0;
          }
        }
      } else {
        for (const gram of selected)
          for (const row of postings.get(gram) ?? [])
            counts.set(row, (counts.get(row) ?? 0) + 1);
        candidates = [...counts.keys()]
          .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a - b)
          .slice(0, rankingLimits.readingCandidates);
      }
    }
    const queryRows = new Map(
      candidates.map((position) => [
        position,
        packed ? rowAt(position) : rows[position],
      ]),
    );
    return candidates
      .map((position) => {
        const row = queryRows.get(position);
        if (!row) throw new Error("Reading posting outside snapshot");
        let kana = 0;
        for (const grams of phonetic)
          kana = Math.max(
            kana,
            packed
              ? packedTrigramDice(
                  grams,
                  row.reading,
                  packed.trigramCount(position, true),
                )
              : unweightedDice(grams, searchGrams(row.reading, trigramWidth)),
          );
        return {
          row: position,
          score: readingNameScore(
            row.literal === literal,
            readings.includes(row.reading),
            packed
              ? packedTrigramDice(
                  lexical,
                  row.literal,
                  packed.trigramCount(position, false),
                )
              : unweightedDice(lexical, searchGrams(row.literal, trigramWidth)),
            kana,
          ),
        };
      })
      .filter((hit) => hit.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          compareSearchText(
            queryRows.get(a.row)?.literal ?? "",
            queryRows.get(b.row)?.literal ?? "",
          ) ||
          a.row - b.row,
      )
      .slice(0, rankingLimits.results);
  };
}
