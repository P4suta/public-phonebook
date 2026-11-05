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

  it("reads complete numbers in every spelling like a plain restatement of the rule", () => {
    const { telephones } = searchContract();
    for (const item of telephones)
      expect(item.number, JSON.stringify(item.text)).toBe(
        referenceNumber(item.text),
      );
    const complete = telephones
      .filter((item) => item.number !== null)
      .map((item) => item.text);
    for (const spelling of [/[0-9]-[0-9]/u, /[０-９]/u, /[(（]/u, /[+＋]/u])
      expect(complete.some((text) => spelling.test(text))).toBe(true);
    expect(telephones.filter((item) => item.number === null).length).toBe(
      telephones.length - complete.length,
    );
    expect(complete.length).toBeGreaterThan(0);
    expect(complete.length).toBeLessThan(telephones.length);
    const byText = new Map(telephones.map((item) => [item.text, item.number]));
    const byteOrderMark = String.fromCodePoint(0xfeff);
    const nextLine = String.fromCodePoint(0x85);
    expect(byText.get(`${byteOrderMark}03-3581-2331${byteOrderMark}`)).toBe(
      "+81335812331",
    );
    expect(byText.get(`${nextLine}03-3581-2331${nextLine}`)).toBeNull();
  });
});

/** After compatibility composition, every accepted character other than a digit or `+` separates digit groups. */
function referenceNumber(text: string): string | null {
  const trimmed = text.trim();
  if (
    trimmed.length > maximumTelephoneLength ||
    !/^[0-9０-９+＋()（）.． \t 　\-－‐‑‒–—―−⁻₋﹣ーｰ]+$/u.test(trimmed)
  )
    return null;
  const kept = trimmed.normalize("NFKC").replace(/[^0-9+]/gu, "");
  const domestic = kept.startsWith("+81") ? `0${kept.slice(3)}` : kept;
  return /^0[1-9][0-9]{8,9}$/u.test(domestic)
    ? `+81${domestic.slice(1)}`
    : null;
}

const maximumTelephoneLength = 80;
