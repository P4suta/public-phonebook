import { describe, expect, it } from "vitest";
import { type LocalQuery, matchIndex } from "../../src/core/local-search.ts";
import {
  decodeSearchIndex,
  type SearchIndex,
} from "../../src/core/search-index.ts";
import { searchWork } from "../../tools/search-performance.ts";
import { type ModelContact, modelDirectory } from "./local-search-fixture.ts";

const snapshot = "b".repeat(64);
const contacts: ModelContact[] = [
  "Ａ図書館",
  "a図書館",
  "ABC分室",
  "北診療所",
].map((name, position) => ({
  id: `c:${position}`,
  name,
  category: "library",
  prefectureCode: "13",
  municipalityCode: null,
  phones: [{ e164: "+81774981200" }],
}));
const index = decodeSearchIndex(modelDirectory(contacts, snapshot).bytes);

describe("search work", () => {
  it("counts the index rows that the matcher reads and the rows it matches", () => {
    expect(searchWork(index, ["図書館", "", "0774981200"])).toEqual({
      queries: 3,
      rowsScanned: { count: 3, p50: 4, p95: 4, max: 4, total: 8 },
      rowsMatched: { count: 3, p50: 2, p95: 4, max: 4, total: 6 },
    });
  });

  it("counts every row read of the matcher it runs", () => {
    const readsTwice = (
      searched: SearchIndex,
      query: LocalQuery,
    ): ReturnType<typeof matchIndex> => {
      let phones = 0;
      for (let position = 0; position < searched.rows.length; position += 1)
        phones += searched.rows[position]?.phones.length ?? 0;
      expect(phones).toBe(contacts.length);
      return matchIndex(searched, query);
    };
    expect(searchWork(index, ["図書館"], readsTwice).rowsScanned.total).toBe(
      2 * contacts.length,
    );
    expect(() => searchWork(index, ["図書館\0"])).toThrow(
      "The sampled query is invalid",
    );
  });
});
