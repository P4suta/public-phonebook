import {
  extractPhones,
  extractTables,
  findColumns,
} from "@public-phonebook/data/collection/extract";
import { DirectorySourceSchema } from "@public-phonebook/data/collection/models";
import { SchoolRegistry } from "@public-phonebook/data/collection/school-registry";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

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
  it("restores an explicitly reviewed numeric trunk prefix without inferring it", () => {
    const source = v.parse(DirectorySourceSchema, {
      id: "numeric-fire-directory",
      url: "https://example.go.jp/fire.csv",
      publisher: "Tokyo Fire Department",
      license: "CC BY",
      licenseUrl: "https://example.go.jp/terms",
      dataAsOf: "2023-04",
      prefectureCode: "13",
      category: "fire_department",
      format: "csv",
      phonePrefix: "0",
    });
    expect(extractPhones("332122111", source.phonePrefix)).toEqual([
      { display: "03-3212-2111", e164: "+81332122111" },
    ]);
    expect(extractPhones("332122111")).toEqual([]);
    expect(extractPhones("12345678", source.phonePrefix)).toEqual([]);
    expect(extractPhones("FAX:332122111", source.phonePrefix)).toEqual([]);
    expect(extractPhones("03-3212-2111", source.phonePrefix)).toEqual([
      { display: "03-3212-2111", e164: "+81332122111" },
    ]);
  });

  it("uses only reviewed prefecture values for abbreviated directory regions", () => {
    const source = v.parse(DirectorySourceSchema, {
      id: "regional-fire-headquarters",
      url: "https://example.go.jp/fire.pdf",
      publisher: "FDMA",
      license: "PDL 1.0",
      licenseUrl: "https://example.go.jp/terms",
      dataAsOf: "2025",
      category: "fire_department",
      format: "pdf",
      columns: { name: [1], address: [2], phone: [3], prefecture: [0] },
      prefectureValues: { "1道西地区": "01" },
    });
    const result = extractTables({
      source,
      tables: [
        {
          name: "Page 528",
          rows: [
            [
              "1 道 西 地 区",
              "函館市消防本部",
              "函館市東雲町5-9",
              "0138-22-2142",
            ],
            ["Unknown", "Other", "Unknown", "03-1234-5678"],
          ],
        },
      ],
      registry,
      retrievedAt: "2026-11-08T00:00:00Z",
      sourceUrl: source.url,
      sourceId: "regional-fire-headquarters",
    });
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      prefectureCode: "01",
      address: "北海道函館市東雲町5-9",
    });
    expect(result.invalid).toBe(1);
  });

  it("keeps an existing facility identity when a prefecture label is supplied", () => {
    const source = v.parse(DirectorySourceSchema, {
      id: "facilities",
      url: "https://example.go.jp/facilities.csv",
      publisher: "Example Prefecture",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      dataAsOf: "2026-05-01",
      prefectureCode: "13",
      category: "community_center",
      format: "csv",
    });
    const input = {
      source,
      tables: [
        {
          name: "CSV",
          rows: [
            ["名称", "住所", "電話番号"],
            ["中央公民館", "千代田区1-1", "03-1234-5678"],
          ],
        },
      ],
      registry,
      retrievedAt: "2026-11-08T00:00:00Z",
      sourceUrl: source.url,
      sourceId: "facilities",
    };
    const before = extractTables(input).contacts[0];
    const after = extractTables({
      ...input,
      tables: [
        {
          name: "CSV",
          rows: [
            ["都道府県名", "名称", "住所", "電話番号"],
            ["東京都", "中央公民館", "千代田区1-1", "03-1234-5678"],
          ],
        },
      ],
    }).contacts[0];
    expect(before?.id).toBe(after?.id);
    expect(before?.address).toBe(after?.address);
    expect(after?.prefectureCode).toBe("13");
  });

  it("limits a branch directory to published branch names", () => {
    const source = v.parse(DirectorySourceSchema, {
      id: "legal-branches",
      url: "https://example.go.jp/branches.html",
      publisher: "MOJ",
      license: "PDL 1.0",
      licenseUrl: "https://example.go.jp/terms",
      dataAsOf: "Not specified by publisher",
      prefectureCode: "13",
      category: "legal_affairs",
      format: "html",
      namePattern: "支局|出張所",
    });
    const result = extractTables({
      source,
      tables: [
        {
          name: "Branches",
          rows: [
            ["名称", "所在地電話番号"],
            ["東京法務局", "東京都千代田区\n電話:03-1234-5678"],
            ["東京法務局 新宿出張所", "東京都新宿区\n電話:03-2345-6789"],
          ],
        },
      ],
      registry,
      retrievedAt: "2026-11-08T00:00:00Z",
      sourceUrl: source.url,
      sourceId: "legal-branches",
    });
    expect(result.contacts.map((contact) => contact.name)).toEqual([
      "東京法務局 新宿出張所",
    ]);
    expect(result.issues).toEqual({ excluded_name_filter: 1 });
  });

  it("carries a reviewed prefecture grouping across PDF pages", () => {
    const source = v.parse(DirectorySourceSchema, {
      id: "support-centres",
      url: "https://example.go.jp/centres.pdf",
      publisher: "Cabinet Office",
      license: "PDL 1.0",
      licenseUrl: "https://example.go.jp/terms",
      dataAsOf: "2026-10-20",
      category: "domestic_violence_support",
      format: "pdf",
      inheritPrefecture: true,
      columns: { name: [1], address: [], phone: [2], prefecture: [0] },
    });
    const result = extractTables({
      source,
      tables: [
        {
          name: "Page 1",
          rows: [
            ["", "Unknown", "011-123-4567"],
            ["北海道", "First", "FAX:011-123-4567"],
            ["", "Second", "011-234-5678"],
          ],
        },
        {
          name: "Page 2",
          rows: [
            ["", "Third", "011-345-6789"],
            ["東京都", "Fourth", "03-1234-5678"],
          ],
        },
      ],
      registry,
      retrievedAt: "2026-11-08T00:00:00Z",
      sourceUrl: source.url,
      sourceId: "support-centres",
    });
    expect(result.contacts.map((contact) => contact.prefectureCode)).toEqual([
      "01",
      "01",
      "13",
    ]);
    expect(result.invalid).toBe(1);
    expect(result.missingPhone).toBe(1);
  });

  it("keeps the published organization context with departmental voice numbers", () => {
    const result = extractTables({
      source: {
        id: "education-contacts",
        url: "https://example.go.jp/education.pdf",
        publisher: "MEXT",
        license: "PDL 1.0",
        licenseUrl: "https://example.go.jp/terms",
        dataAsOf: "2026-10-01",
        category: "education_board",
        format: "pdf",
        selector: "table",
        kindValues: {},
        minimumContacts: 1,
        namePrefix: "北海道",
        columns: {
          name: [2],
          nameContext: [1],
          address: [],
          phone: [3],
          prefecture: [0],
          website: [4],
        },
      },
      tables: [
        {
          name: "Page 1",
          rows: [
            [
              "北海道",
              "札幌市",
              "学校教育部\n教育推進課",
              "011-211-3851",
              "https://example.go.jp/first\nhttps://example.go.jp/second",
            ],
            [
              "北海道",
              "函館市",
              "函館市教育委員会学校教育部保健給食課",
              "0138-21-3547",
              "https://example.go.jp/hakodate",
            ],
            ["北海道", "小樽市", "学校教育課", "FAX:0134-32-4111"],
          ],
        },
      ],
      registry,
      retrievedAt: "2026-11-08T00:00:00Z",
      sourceUrl: "https://example.go.jp/education.pdf",
      sourceId: "education",
    });
    expect(result.contacts.map((contact) => contact.name)).toEqual([
      "北海道 札幌市 学校教育部 教育推進課",
      "北海道 函館市教育委員会学校教育部保健給食課",
    ]);
    expect(result.contacts.map((contact) => contact.prefectureCode)).toEqual([
      "01",
      "01",
    ]);
    expect(result.missingPhone).toBe(1);
    expect(result.contacts.map((contact) => contact.website)).toEqual([
      null,
      "https://example.go.jp/hakodate",
    ]);
  });

  it("selects the voice field and never a fax header", () => {
    expect(
      findColumns(["学校名", "所 在 地", "電話番号", "FAX番号"]),
    ).toMatchObject({ name: [0], address: [1], phone: [2] });
    expect(findColumns(["学校名", "所在地", "FAX番号"])).toBeNull();
    expect(
      findColumns(["都道府県名", "官署名", "所在地", "電話番号", "FAX番号"]),
    ).toMatchObject({ name: [1], address: [2], phone: [3], prefecture: [0] });
  });
  it("normalizes explicit voice numbers and excludes fax in a mixed cell", () => {
    expect(
      extractPhones("ＴＥＬ：０５２－１２３－４５６７\nFAX：052-999-9999"),
    ).toEqual([{ display: "052-123-4567", e164: "+81521234567" }]);
    expect(extractPhones("0521234567 / 052-234-5678")).toHaveLength(2);
    expect(extractPhones("FAX:052-123-4567")).toEqual([]);
    expect(extractPhones("0824-63-5181(2317)")).toEqual([
      { display: "0824-63-5181", e164: "+81824635181" },
    ]);
    expect(extractPhones("0824-63-51811(2317)")).toEqual([]);
    expect(extractPhones("03-5860-\n9510\n03-3579-1234")).toEqual([
      { display: "03-5860-9510", e164: "+81358609510" },
      { display: "03-3579-1234", e164: "+81335791234" },
    ]);
    expect(extractPhones("123-4567")).toEqual([]);
    expect(extractPhones("123-4567", "052")[0]?.e164).toBe("+81521234567");
  });
});
