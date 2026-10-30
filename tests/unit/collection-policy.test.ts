import { describe, expect, it } from "vitest";
import { extractPhones, findColumns } from "../../tools/collection/extract.ts";
import { SchoolRegistry } from "../../tools/collection/school-registry.ts";

const header =
  "学校コード,学校種,都道府県番号,設置区分,本分校,学校名,学校所在地,郵便番号,属性情報設定年月日,属性情報廃止年月日\n";
const registry = new SchoolRegistry(
  [
    new TextEncoder().encode(
      header +
        [
          "B123210000019,B1,23,2,1,名古屋市立春岡小学校,愛知県名古屋市千種区春岡２－５－３８,4640848,2020-12-22,2025-05-01",
          "B123210000019,B1,23,2,1,名古屋市立春岡小学校,愛知県名古屋市千種区春岡２－５－３８,4640848,2025-05-01,",
          "B123210000028,B1,23,2,9,名古屋市立廃止小学校,愛知県名古屋市千種区廃止１－１,4640000,2020-12-22,2025-05-01",
          "B123210000037,B1,23,2,1,他市立春岡小学校,愛知県他市春岡２－５－３８,4990000,2020-12-22,",
        ].join("\n"),
    ),
  ],
  "2026-10-30",
);

describe("official school reconciliation", () => {
  it("keeps an active attribute after a previous attribute ended", () => {
    expect(registry.schools).toHaveLength(2);
    expect(
      registry.match({
        name: "名古屋市立春岡小学校",
        address: "",
        prefectureCode: "23",
      })?.code,
    ).toBe("B123210000019");
  });
  it("joins a shortened name only with enough unique source evidence", () => {
    expect(
      registry.match({
        name: "春 岡",
        address: "春岡2-5-38",
        postalCode: "464-0848",
        prefectureCode: "23",
        category: "elementary_school",
      })?.code,
    ).toBe("B123210000019");
    expect(
      registry.match({
        name: "春 岡",
        address: "春岡2-5-38",
        prefectureCode: "23",
      }),
    ).toBeNull();
    expect(
      registry.match({ name: "春岡", address: "", prefectureCode: "23" }),
    ).toBeNull();
    expect(
      registry.match({ name: "", address: "春岡2-5-38", prefectureCode: "23" }),
    ).toBeNull();
  });
  it("rejects a conflicting address, category, region or code", () => {
    expect(
      registry.match({
        name: "名古屋市立春岡小学校",
        address: "他町1-1",
        prefectureCode: "23",
      }),
    ).toBeNull();
    expect(
      registry.match({
        name: "名古屋市立春岡小学校",
        address: "",
        prefectureCode: "22",
      }),
    ).toBeNull();
    expect(
      registry.match({
        name: "名古屋市立春岡小学校",
        address: "",
        prefectureCode: "23",
        category: "high_school",
      }),
    ).toBeNull();
    expect(
      registry.match({
        name: "名古屋市立春岡小学校",
        address: "",
        prefectureCode: "23",
        code: "B199999999999",
      }),
    ).toBeNull();
  });
});

describe("telephone columns", () => {
  it("selects the voice field and never a fax header", () => {
    expect(
      findColumns(["学校名", "所 在 地", "電話番号", "FAX番号"]),
    ).toMatchObject({ name: [0], address: [1], phone: [2] });
    expect(findColumns(["学校名", "所在地", "FAX番号"])).toBeNull();
  });
  it("normalizes explicit voice numbers and excludes fax in a mixed cell", () => {
    expect(
      extractPhones("ＴＥＬ：０５２－１２３－４５６７\nFAX：052-999-9999"),
    ).toEqual([{ display: "052-123-4567", e164: "+81521234567" }]);
    expect(extractPhones("0521234567 / 052-234-5678")).toHaveLength(2);
    expect(extractPhones("FAX:052-123-4567")).toEqual([]);
    expect(extractPhones("123-4567")).toEqual([]);
    expect(extractPhones("123-4567", "052")[0]?.e164).toBe("+81521234567");
  });
});
