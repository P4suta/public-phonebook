import { describe, expect, it } from "vitest";
import {
  kanjiVariants,
  searchForm,
  searchWords,
} from "../../src/core/search-text.ts";
import { rankWords } from "../../src/core/word-match.ts";
import type { SourceTable } from "../../tools/collection/read-tables.ts";
import { joyoTraditionalForms } from "../../tools/joyo-traditional-forms.ts";
import {
  checkKanjiVariantProvenance,
  joyoKanjiTable,
  kanjiVariantTable,
  readTraditionalForms,
  requireTraditionalForms,
  requireUnihanAgreement,
  swiftSource,
  traditionalFormsOf,
  traditionalFormsSource,
  typeScriptSource,
} from "../../tools/kanji-variants.ts";
import { referenceForm } from "./search-reference.ts";

const pairs = kanjiVariants();
const traditional = joyoTraditionalForms.split(" ").map((pair) => {
  const [form = "", character = ""] = pair.split(":");
  return [Number.parseInt(form, 16), Number.parseInt(character, 16)] as const;
});

function finds(name: string, query: string): boolean {
  return rankWords(searchForm(name), searchWords(query), () => false) >= 0;
}

function characters(table: ReadonlyMap<number, number>): object {
  return Object.fromEntries(
    Array.from(table, ([from, to]) => [
      String.fromCodePoint(from),
      String.fromCodePoint(to),
    ]),
  );
}

/** Rows as `readPdfTables` gives them, each text after its x coordinate, in a page of the notice's layout. */
const noticePage = [
  ["290:本", "362:表"],
  ["111:漢", "143:字", "190:音", "211:訓", "315:例", "450:備", "513:考"],
  ["105:亜", "116:（亞） ア", "247:亜流"],
  ["173:あわれ", "247:哀れ"],
  ["94:イ"],
  ["105:剤", "116:（", "134:劑", "152:） ザイ", "247:薬剤師"],
  ["105:亀", "116:（", "152:） キ", "247:亀裂"],
  ["105:弁", "135:辨", "173:ベン", "247:弁償"],
  ["135:瓣"],
  ["135:辯"],
  ["104:餅", "115:［餅］", "172:ヘイ", "246:煎餅", "397:［", "408:餅"],
  ["115:（餠） もち", "246:餅屋"],
  ["105:呉", "173:ゴ", "247:呉服"],
  ["404:父（とう）さん"],
  ["290:付", "362:表"],
  ["105:明", "173:あす"],
];

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
    expect(characters(kanjiVariantTable(mappings, variants, []))).toEqual({
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

  it("joins the notice's traditional forms before any Unihan edge, and a table without them folds them into other characters", () => {
    const mappings = [
      "U+4E00\tkJoyoKanji\t2010",
      "U+58F1\tkJoyoKanji\t2010",
      "U+6D5C\tkJoyoKanji\t2010",
      "U+7015\tkJinmeiyoKanji\t2010",
    ].join("\n");
    const variants = [
      "U+58F9\tkSemanticVariant\tU+4E00<kLau,kMatthews,kMeyerWempe U+5F0C<kLau,kMatthews,kMeyerWempe",
      "U+6FF1\tkSemanticVariant\tU+6FF5<kMatthews,kMeyerWempe U+7015<kFenn",
    ].join("\n");
    expect(characters(kanjiVariantTable(mappings, variants, []))).toEqual({
      壹: "一",
      濱: "瀕",
    });
    expect(
      characters(
        kanjiVariantTable(mappings, variants, [
          [0x58f9, 0x58f1],
          [0x6ff1, 0x6d5c],
        ]),
      ),
    ).toEqual({ 壹: "壱", 濱: "浜" });
    expect(() =>
      kanjiVariantTable(mappings, variants, [[0x4e00, 0x58f1]]),
    ).toThrow("U+4E00 doesn't fold into U+58F1");
  });

  it("reads the notice's bracketed, split, drawn, stacked, and continued forms and leaves the permitted forms out", () => {
    const read = traditionalFormsOf([{ name: "Page 1", rows: noticePage }]);
    expect(read.characters.map((point) => String.fromCodePoint(point))).toEqual(
      ["亜", "剤", "亀", "弁", "餅", "呉"],
    );
    expect(
      read.pairs.map(([form, character]) =>
        String.fromCodePoint(form, character),
      ),
    ).toEqual(["亞亜", "劑剤", "龜亀", "辨弁", "瓣弁", "辯弁", "餠餅"]);
    expect(() =>
      readTraditionalForms([{ name: "Page 1", rows: noticePage }]),
    ).toThrow(
      "The notice gives 6 characters and 7 traditional forms beside 5 of them",
    );
  });

  it("refuses notice text that it doesn't expect", () => {
    const page = (row: readonly string[]): SourceTable[] => [
      { name: "Page 1", rows: [["290:本表"], ["105:亜"], row, ["290:付表"]] },
    ];
    expect(() =>
      traditionalFormsOf(page(["105:哀", "116:（", "152:） アイ"])),
    ).toThrow("Empty round brackets beside U+54C0");
    expect(() => traditionalFormsOf(page(["135:瓣"]))).toThrow(
      "Unexpected text in the bracket column",
    );
    expect(() => traditionalFormsOf(page(["105:亜亜"]))).toThrow(
      "Unexpected text in the character column",
    );
    expect(() =>
      traditionalFormsOf([{ name: "Page 1", rows: [["290:本表"]] }]),
    ).toThrow("The notice lacks its main table or its appendix title");
  });

  it("requires Unihan to list the notice's characters and traditional forms", () => {
    const notice = {
      characters: [0x4e9c, 0x54c0],
      pairs: [[0x4e9e, 0x4e9c]] as const,
    };
    const mappings = "U+4E9C\tkJoyoKanji\t2010\nU+54C0\tkJoyoKanji\t2010";
    const variants =
      "U+4E9E\tkJapaneseNewVariant\tU+4E9C\nU+4E9C\tkJapaneseOldVariant\tU+4E9E";
    expect(() =>
      requireUnihanAgreement(notice, mappings, variants),
    ).not.toThrow();
    expect(() =>
      requireUnihanAgreement(
        notice,
        mappings,
        "U+4E9C\tkJapaneseOldVariant\tU+4E9E",
      ),
    ).toThrow(
      "The notice's traditional forms and kJapaneseNewVariant differ: U+4E9E>U+4E9C",
    );
    expect(() =>
      requireUnihanAgreement(notice, "U+4E9C\tkJoyoKanji\t2010", variants),
    ).toThrow("The notice's characters and kJoyoKanji differ: U+54C0");
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
    expect(traditionalFormsSource([[0x6fa4, 0x6ca2]])).toContain(
      'joyoTraditionalForms =\n  "6fa4:6ca2";',
    );
  });

  it("keeps the notice's 364 traditional forms beside 362 characters and folds each into its standard character", () => {
    expect(traditional).toHaveLength(joyoKanjiTable.traditionalForms);
    expect(traditional).toHaveLength(364);
    expect(new Set(traditional.map(([, character]) => character)).size).toBe(
      362,
    );
    for (const [form, character] of traditional) {
      const standard = String.fromCodePoint(character);
      expect(searchForm(String.fromCodePoint(form)), standard).toBe(standard);
      expect(referenceForm(String.fromCodePoint(form)), standard).toBe(
        standard,
      );
    }
  });

  it("refuses a table that skips the notice's traditional forms, as a negative control", () => {
    const table = new Map(
      pairs.map(([from, to]) => [
        from.codePointAt(0) ?? 0,
        to.codePointAt(0) ?? 0,
      ]),
    );
    expect(() => requireTraditionalForms(table, traditional)).not.toThrow();
    for (const [form] of traditional) table.delete(form);
    expect(() => requireTraditionalForms(table, traditional)).toThrow(
      "doesn't fold into",
    );
    expect(() => requireTraditionalForms(table, traditional.slice(1))).toThrow(
      "holds 363 forms beside 361 characters",
    );
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

  it("maps the owner's examples and leaves the variant that no source joins", () => {
    expect(searchForm("髙")).toBe("高");
    expect(searchForm("\u{fa11}")).toBe("崎");
    expect(searchForm("崎")).not.toBe(searchForm("埼"));
    expect(searchForm("葛\u{e0100}")).toBe(searchForm("葛"));
    expect(searchForm("澤")).toBe("沢");
    expect(searchForm("邊")).toBe("辺");
    expect(searchForm("齋")).toBe("斎");
    expect(searchForm("國")).toBe("国");
    expect(searchForm("壹")).toBe("壱");
    expect(searchForm("濱")).toBe("浜");
    expect(searchForm("龜")).toBe("亀");
    expect(searchForm("辨 瓣 辯")).toBe("弁 弁 弁");
    expect(searchForm("邉")).toBe("邉");
  });

  it("finds a name from either form of a variant, in both directions", () => {
    expect(finds("山崎図書館", "山\u{fa11}")).toBe(true);
    expect(finds("山\u{fa11}図書館", "山崎")).toBe(true);
    expect(finds("高田医院", "髙田")).toBe(true);
    expect(finds("髙田医院", "高田")).toBe(true);
    for (const [old, standard] of [
      ["澤田", "沢田"],
      ["渡邊", "渡辺"],
      ["齋藤", "斎藤"],
      ["國立", "国立"],
    ] as const) {
      expect(finds(`${old}会館`, standard), old).toBe(true);
      expect(finds(`${standard}会館`, old), standard).toBe(true);
    }
  });

  it("fails the owner's examples without the table, as a negative control", () => {
    expect(referenceForm("山\u{fa11}", false)).not.toBe(
      referenceForm("山崎", false),
    );
    expect(referenceForm("髙", false)).not.toBe(referenceForm("高", false));
    expect(referenceForm("澤田", false)).not.toBe(referenceForm("沢田", false));
    expect(referenceForm("山\u{fa11}")).toBe(referenceForm("山崎"));
    expect(referenceForm("澤田")).toBe(referenceForm("沢田"));
  });
});
