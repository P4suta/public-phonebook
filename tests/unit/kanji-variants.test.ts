import { describe, expect, it } from "vitest";
import {
  kanjiVariants,
  searchForm,
  searchWords,
} from "../../src/core/search-text.ts";
import { rankWords } from "../../src/core/word-match.ts";
import {
  checkKanjiVariantProvenance,
  kanjiVariantTable,
  swiftSource,
  typeScriptSource,
} from "../../tools/kanji-variants.ts";
import { referenceForm } from "./search-reference.ts";

const pairs = kanjiVariants();

function finds(name: string, query: string): boolean {
  return rankWords(searchForm(name), searchWords(query), () => false) >= 0;
}

describe("kanji variants", () => {
  it("joins Unihan's list pointers, z-variants, and single standard semantic variants without joining two standard forms", () => {
    const mappings = [
      "U+4E9C\tkJoyoKanji\t2010",
      "U+4E9E\tkJinmeiyoKanji\t2010:U+4E9C",
      "U+5D0E\tkJoyoKanji\t2010",
      "U+57FC\tkJoyoKanji\t2010",
      "U+9AD8\tkJoyoKanji\t2010",
      "U+5265\tkJoyoKanji\tU+525D",
      "U+525D\tkJoyoKanji\t2010",
    ].join("\n");
    const variants = [
      "# A comment line",
      "U+FA11\tkSemanticVariant\tU+57FC U+5D0E<kMorohashi:Z U+5D5C",
      "U+9AD9\tkSemanticVariant\tU+9AD8<kFenn",
      "U+5D5C\tkZVariant\tU+5D0E",
      "U+5D0E\tkSemanticVariant\tU+57FC<kMorohashi:TZ",
      "U+4E00\tkZVariant\tU+F900",
      "U+3588\tkZVariant\tU+439B",
    ].join("\n");
    expect(
      Object.fromEntries(
        Array.from(kanjiVariantTable(mappings, variants), ([from, to]) => [
          String.fromCodePoint(from),
          String.fromCodePoint(to),
        ]),
      ),
    ).toEqual({
      亞: "亜",
      剥: "剝",
      﨑: "崎",
      嵜: "崎",
      髙: "高",
      䎛: "㖈",
      // Compatibility composition turns U+F900 into 豈 before it joins.
      豈: "一",
    });
  });

  it("finds the same committed pairs under the pinned provenance without the network", async () => {
    await expect(checkKanjiVariantProvenance()).resolves.toBeUndefined();
  });

  it("writes the same table for TypeScript and Swift", () => {
    const table = new Map([[0x9ad9, 0x9ad8]]);
    expect(typeScriptSource(table)).toContain(
      'kanjiVariantPairs =\n  "9ad9:9ad8";',
    );
    expect(swiftSource(table)).toContain('static let pairs =\n    "9ad9:9ad8"');
  });

  it("folds every table entry to a representative that folding keeps", () => {
    const representatives = new Set(pairs.map(([, to]) => to));
    expect(pairs.length).toBeGreaterThan(1000);
    for (const [from = "", to = ""] of pairs) {
      expect(representatives.has(from), from).toBe(false);
      expect(searchForm(from), from).toBe(to);
      expect(searchForm(to), to).toBe(to);
      expect(searchForm(searchForm(from))).toBe(searchForm(from));
      expect(referenceForm(from)).toBe(to);
    }
  });

  it("maps the owner's examples and leaves the variants that Unihan doesn't join", () => {
    expect(searchForm("髙")).toBe("高");
    expect(searchForm("\u{fa11}")).toBe("崎");
    expect(searchForm("崎")).not.toBe(searchForm("埼"));
    expect(searchForm("葛\u{e0100}")).toBe(searchForm("葛"));
    for (const unjoined of ["澤", "邊", "邉", "齋"])
      expect(searchForm(unjoined)).toBe(unjoined);
  });

  it("finds a name from either form of a variant, in both directions", () => {
    expect(finds("山崎図書館", "山\u{fa11}")).toBe(true);
    expect(finds("山\u{fa11}図書館", "山崎")).toBe(true);
    expect(finds("高田医院", "髙田")).toBe(true);
    expect(finds("髙田医院", "高田")).toBe(true);
  });

  it("fails the owner's examples without the table, as a negative control", () => {
    expect(referenceForm("山\u{fa11}", false)).not.toBe(
      referenceForm("山崎", false),
    );
    expect(referenceForm("髙", false)).not.toBe(referenceForm("高", false));
    expect(referenceForm("山\u{fa11}")).toBe(referenceForm("山崎"));
  });
});
