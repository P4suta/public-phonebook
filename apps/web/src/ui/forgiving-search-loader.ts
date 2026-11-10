import {
  createRankedSearch,
  type RankedSearch,
} from "@public-phonebook/directory/forgiving-search";
import type { SearchIndex } from "@public-phonebook/directory/search-index";
import { decodeRankingArtifact } from "@public-phonebook/directory/search-ranking-artifact";

export function createRanking(
  index: SearchIndex,
  bytes: Uint8Array,
): RankedSearch {
  return createRankedSearch(
    index,
    decodeRankingArtifact(bytes, index.header.snapshot, index.rows.length),
  );
}
