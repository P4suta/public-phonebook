import {
  conservativeReading,
  nonexactSignalScore,
  preferredNameScore,
  rankingLimits,
  readingGate,
} from "./forgiving-search-policy.ts";
import { lexicalSearch } from "./lexical-search.ts";
import {
  matchesPlaces,
  parsePlaceQuery,
  placeDictionary,
} from "./place-search.ts";
import { readingSearch } from "./reading-search.ts";
import type { SearchIndex } from "./search-index.ts";
import type { RankingArtifact } from "./search-ranking-artifact.ts";
import {
  compactSearchText,
  rankingName,
  searchGrams,
} from "./search-ranking-text.ts";

export interface RankedHit {
  readonly row: number;
  readonly score: number;
}
export interface RankedSearch {
  search(query: string): readonly RankedHit[];
}
interface NameSignals {
  readonly hits: readonly RankedHit[];
  readonly lexical: readonly RankedHit[];
  readonly reading: readonly RankedHit[];
  readonly locked: boolean;
}
const shortQueryPoints = 2;
const shortGramWidth = 2;
const minimumPlacePrefix = 2;

function appendExact(
  map: Map<string, number[]>,
  key: string,
  row: number,
): void {
  const values = map.get(key) ?? [];
  values.push(row);
  map.set(key, values);
}

function originalNameKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{White_Space}+/gu, "")
    .normalize("NFC");
}

function unionHits(
  left: readonly RankedHit[],
  right: readonly RankedHit[],
): RankedHit[] {
  const hits = new Map<number, RankedHit>();
  for (const hit of [...left, ...right]) {
    const previous = hits.get(hit.row);
    if (!previous || previous.score < hit.score) hits.set(hit.row, hit);
  }
  return [...hits.values()];
}

function mergedSignals(
  primary: readonly RankedHit[],
  secondary: readonly RankedHit[],
): readonly RankedHit[] {
  const rows = new Set(primary.map((hit) => hit.row));
  return [
    ...primary.map((hit) => ({
      row: hit.row,
      score: nonexactSignalScore(hit.score),
    })),
    ...secondary
      .filter((hit) => !rows.has(hit.row))
      .map((hit) => ({ row: hit.row, score: 0 })),
  ].slice(0, rankingLimits.results);
}

export function createRankedSearch(
  index: SearchIndex,
  artifact: RankingArtifact,
): RankedSearch {
  if (
    index.header.snapshot !== artifact.snapshot ||
    index.rows.length !== artifact.contacts ||
    artifact.readings.length !== artifact.contacts
  )
    throw new Error("Ranking artifact snapshot or count mismatch");
  if (
    !Number.isSafeInteger(artifact.unknownWeight) ||
    artifact.unknownWeight < 1 ||
    artifact.unknownWeight > rankingLimits.inverseFrequency
  )
    throw new Error("Invalid unknown lexical weight");
  const variants = new Map(artifact.variants);
  const names = index.rows.map((row) => rankingName(row.name, variants));
  const lengths = names.map((name) => Array.from(name).length);
  const originalExact = new Map<string, number[]>();
  const writtenExact = new Map<string, number[]>();
  const foldedExact = new Map<string, number[]>();
  const shortPostings = new Map<string, number[]>();
  for (const [row, entry] of index.rows.entries()) {
    const name = names[row] ?? "";
    appendExact(originalExact, originalNameKey(entry.name), row);
    appendExact(
      writtenExact,
      compactSearchText(entry.name).normalize("NFC"),
      row,
    );
    appendExact(foldedExact, name, row);
    for (const key of new Set([
      ...Array.from(name),
      ...searchGrams(name, shortGramWidth),
    ]))
      appendExact(shortPostings, key, row);
  }
  for (const rows of shortPostings.values())
    rows.sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0) || a - b);
  const lexical = lexicalSearch(names, artifact);
  const reading = readingSearch(names, artifact);
  const dictionary = placeDictionary(index);
  const aliases = new Map<string, number[]>();
  for (const [row, kana] of artifact.aliases)
    appendExact(aliases, compactSearchText(kana), row);

  function base(query: string): NameSignals {
    const folded = rankingName(query, variants);
    const length = Array.from(folded).length;
    const empty = { hits: [], lexical: [], reading: [], locked: true } as const;
    if (!length || length > rankingLimits.queryPoints) return empty;
    const exact =
      originalExact.get(originalNameKey(query)) ??
      writtenExact.get(compactSearchText(query).normalize("NFC")) ??
      foldedExact.get(folded);
    if (exact)
      return {
        ...empty,
        hits: exact
          .slice(0, rankingLimits.results)
          .map((row) => ({ row, score: rankingLimits.exactScore })),
      };
    if (length <= shortQueryPoints)
      return {
        ...empty,
        hits: (shortPostings.get(folded) ?? [])
          .slice(0, rankingLimits.results)
          .map((row) => ({
            row,
            score: Math.floor(
              rankingLimits.exactScore / (1 + (lengths[row] ?? 0)),
            ),
          })),
      };
    const lexicalHits = lexical(folded);
    const readingHits = reading(folded);
    return {
      hits: mergedSignals(lexicalHits, readingHits),
      lexical: lexicalHits,
      reading: readingHits,
      locked: false,
    };
  }

  return {
    search: (query) => {
      const original = base(query);
      if (original.locked) return original.hits;
      const places = parsePlaceQuery(query, dictionary);
      const local = places.conditions.length ? base(places.stripped) : original;
      const folded = rankingName(places.stripped, variants);
      const points = Array.from(folded);
      const tiedPlaces = places.conditions.length
        ? places
        : {
            stripped: query,
            conditions: [...dictionary.values()]
              .filter(
                (condition) =>
                  condition.word.length >= minimumPlacePrefix &&
                  compactSearchText(query).startsWith(condition.word),
              )
              .sort((a, b) => b.word.length - a.word.length)
              .slice(0, 1),
          };
      const preferred = new Set<number>();
      const tiedRegion = new Set<number>();
      const order = (hits: readonly RankedHit[]): RankedHit[] => {
        for (const hit of hits) {
          const row = index.rows[hit.row];
          if (!row) throw new Error("Candidate outside snapshot");
          if (matchesPlaces(row, places)) preferred.add(hit.row);
          if (matchesPlaces(row, tiedPlaces)) tiedRegion.add(hit.row);
        }
        return hits
          .slice()
          .sort(
            (a, b) =>
              Number(preferred.has(b.row)) - Number(preferred.has(a.row)) ||
              b.score - a.score ||
              Number(tiedRegion.has(b.row)) - Number(tiedRegion.has(a.row)) ||
              a.row - b.row,
          );
      };
      const lexicalHits = order(
        unionHits(
          local.lexical.length ? local.lexical : local.hits,
          original.lexical,
        ),
      );
      let readingHits = order(
        unionHits(
          local.reading.length ? local.reading : local.hits,
          original.reading,
        ),
      );
      const alias = !/\p{Script=Han}/u.test(folded)
        ? aliases.get(folded)
        : undefined;
      if (alias?.length)
        readingHits = order(
          unionHits(
            alias.map((row) => ({ row, score: rankingLimits.aliasScore })),
            readingHits,
          ),
        );
      const topLexical = lexicalHits[0]?.score ?? 0;
      const topReading = readingHits[0]?.score ?? 0;
      const ratio = topLexical
        ? Math.min(
            rankingLimits.ratio,
            Math.floor((topReading * rankingLimits.fraction) / topLexical),
          )
        : rankingLimits.ratio;
      const kanaShare = points.length
        ? Math.floor(
            (points.filter((point) =>
              /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(point),
            ).length *
              rankingLimits.fraction) /
              points.length,
          )
        : 0;
      const conservative =
        !places.conditions.length &&
        conservativeReading(
          /\p{Script=Han}/u.test(rankingName(query, variants)),
          original.lexical[0]?.score ?? 0,
          original.reading[0]?.score ?? 0,
        );
      const takeReading = readingGate(
        ratio,
        kanaShare,
        !!alias?.length,
        conservative,
        readingHits.length > 0,
        original.locked,
      );
      const primary = takeReading ? readingHits : lexicalHits;
      const secondary = takeReading ? lexicalHits : readingHits;
      const raw = new Map(primary.map((hit) => [hit.row, hit.score]));
      return unionHits(primary, secondary)
        .map((hit) => ({
          row: hit.row,
          score: preferredNameScore(
            raw.get(hit.row) ?? 0,
            preferred.has(hit.row),
          ),
        }))
        .sort(
          (a, b) =>
            b.score - a.score ||
            (raw.get(b.row) ?? 0) - (raw.get(a.row) ?? 0) ||
            Number(tiedRegion.has(b.row)) - Number(tiedRegion.has(a.row)) ||
            a.row - b.row,
        )
        .slice(0, rankingLimits.results);
    },
  };
}
