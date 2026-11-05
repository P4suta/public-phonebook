import {
  createRankedSearch,
  type RankedSearch,
} from "../core/forgiving-search.ts";
import type { SearchIndex } from "../core/search-index.ts";
import { decodeRankingArtifact } from "../core/search-ranking-artifact.ts";

export function createRanking(
  index: SearchIndex,
  bytes: Uint8Array,
): RankedSearch {
  return createRankedSearch(
    index,
    decodeRankingArtifact(bytes, index.header.snapshot, index.rows.length),
  );
}
