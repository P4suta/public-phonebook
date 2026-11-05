import type { RankedSearch } from "./local-search.ts";

export { qualityPasses } from "./search-quality-policy.ts";

const firstCutoff = 1;
const thirdCutoff = 3;
const tenthCutoff = 10;

export interface QualityCase {
  readonly query: string;
  readonly targets: readonly number[];
}

export interface QualityCounts {
  readonly queries: number;
  readonly top1: number;
  readonly top3: number;
  readonly top10: number;
}

export function measureSearchQuality(
  search: RankedSearch,
  cases: readonly QualityCase[],
): QualityCounts {
  if (!cases.length)
    throw new Error("Search quality needs a nonempty population");
  let top1 = 0;
  let top3 = 0;
  let top10 = 0;
  for (const record of cases) {
    if (!record.targets.length)
      throw new Error("A quality query needs target labels");
    const targets = new Set(record.targets);
    const position = search
      .search(record.query)
      .findIndex((hit) => targets.has(hit.row));
    if (position < 0) continue;
    if (position < firstCutoff) top1 += 1;
    if (position < thirdCutoff) top3 += 1;
    if (position < tenthCutoff) top10 += 1;
  }
  return { queries: cases.length, top1, top3, top10 };
}
