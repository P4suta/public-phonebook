import { describe, expect, it } from "vitest";
import {
  encodedSearchContract,
  readSearchContract,
  searchContract,
} from "../../tools/search-contract.ts";
import {
  referenceForm,
  referenceRank,
  referenceWords,
} from "./search-reference.ts";

describe("search contract", () => {
  it("keeps the committed iPhone contract equal to the website's answers", async () => {
    expect(await readSearchContract()).toBe(encodedSearchContract());
  });

  it("answers every contract case like the reference", () => {
    const contract = searchContract();
    for (const item of contract.words)
      expect(item.words, item.text).toEqual(referenceWords(item.text));
    for (const item of contract.ranks)
      expect(item.rank, item.query).toBe(
        referenceRank(item.name, item.places, referenceWords(item.query)),
      );
    expect(new Set(contract.ranks.map((item) => item.rank))).toEqual(
      new Set([-1, 0, 1, 2, 3]),
    );
    expect(referenceForm("市ヶ谷")).toBe(referenceForm("市ケ谷"));
  });
});
