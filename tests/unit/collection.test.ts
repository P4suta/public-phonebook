import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import {
  decodeSourceText,
  readCsvTables,
  readHtmlTables,
  readWorkbookTables,
} from "../../tools/collection/read-tables.ts";

describe("official directory table readers", () => {
  it("preserves CSV telephone and fax columns, quoted addresses, and blank rows", () => {
    const bytes = new TextEncoder().encode(
      '\ufeff学校名,住所,電話番号,FAX番号\r\n第一小学校,"東京都千代田区1,2",03-1234-5678,03-1234-9999\r\n,,,\r\n',
    );
    expect(readCsvTables(bytes)[0]?.rows).toEqual([
      ["学校名", "住所", "電話番号", "FAX番号"],
      ["第一小学校", "東京都千代田区1,2", "03-1234-5678", "03-1234-9999"],
      ["", "", "", ""],
    ]);
  });

  it("decodes Windows Japanese data and refuses lossy text conversion", () => {
    expect(decodeSourceText(Uint8Array.from([0x93, 0x64, 0x98, 0x62]))).toBe(
      "電話",
    );
    expect(() => decodeSourceText(Uint8Array.from([0x81]))).toThrow();
  });

  it("expands only explicit HTML spans without mixing nested tables", () => {
    const html = `<table id="schools"><tr><th>地域</th><th>学校名</th><th>電話番号</th><th>FAX番号</th></tr>
      <tr><td rowspan="2">東京都</td><td>第一小学校</td><td>03-1234-5678</td><td>03-1234-9999</td></tr>
      <tr><td>第二小学校</td><td>03-2345-6789</td><td>03-2345-9999</td></tr></table>
      <table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>`;
    expect(readHtmlTables(html, "#schools")[0]?.rows).toEqual([
      ["地域", "学校名", "電話番号", "FAX番号"],
      ["東京都", "第一小学校", "03-1234-5678", "03-1234-9999"],
      ["東京都", "第二小学校", "03-2345-6789", "03-2345-9999"],
    ]);
  });

  it("clips an overhanging row span to published rows and keeps the hard bound", () => {
    const html = `<table><tr><td rowspan="35">東京税関</td><td>本関</td><td>03-3529-0700</td></tr>
      <tr><td>出張所</td><td>03-5665-3755</td></tr></table>`;
    expect(readHtmlTables(html)[0]?.rows).toEqual([
      ["東京税関", "本関", "03-3529-0700"],
      ["東京税関", "出張所", "03-5665-3755"],
    ]);
    expect(() =>
      readHtmlTables(
        '<table><tr><td rowspan="100001">oversized</td></tr></table>',
      ),
    ).toThrow("bounds");
    expect(() =>
      readHtmlTables(
        '<table><tr><td colspan="257">oversized</td></tr></table>',
      ),
    ).toThrow("bounds");
  });

  it("reads labeled office records with their nearest published heading", () => {
    const html = `<h1>Regional Bureau</h1><div><table><tr><th>所在地</th><td>東京都千代田区</td></tr><tr><th>電話</th><td>03-1234-5678</td></tr></table></div>
      <h2>Branch Office</h2><div><table><tr><th>所在地</th><td>埼玉県さいたま市</td></tr><tr><th>電話</th><td>048-123-4567</td></tr></table></div>`;
    expect(readHtmlTables(html, "table", "definition")).toEqual([
      {
        name: "Regional Bureau",
        rows: [
          ["名称", "所在地", "電話"],
          ["Regional Bureau", "東京都千代田区", "03-1234-5678"],
        ],
      },
      {
        name: "Branch Office",
        rows: [
          ["名称", "所在地", "電話"],
          ["Branch Office", "埼玉県さいたま市", "048-123-4567"],
        ],
      },
    ]);
    expect(() =>
      readHtmlTables(
        "<table><tr><th>電話</th><td>03-1234-5678</td></tr></table>",
        "table",
        "definition",
      ),
    ).toThrow("heading");
  });

  it("uses the office heading before a map caption in a labeled record", () => {
    expect(
      readHtmlTables(
        "<h1>Branch Office</h1><table><caption>Access map</caption><tr><th>電話</th><td>03-1234-5678</td></tr></table>",
        "table",
        "definition",
      )[0],
    ).toEqual({
      name: "Branch Office",
      rows: [
        ["名称", "電話"],
        ["Branch Office", "03-1234-5678"],
      ],
    });
    expect(
      readHtmlTables(
        "<table><caption>Branch Office</caption><tr><th>電話</th><td>03-1234-5678</td></tr></table>",
        "table",
        "definition",
      )[0]?.name,
    ).toBe("Branch Office");
  });

  it.each(["xlsx", "xls"] as const)(
    "reads real %s workbook bytes and preserves merged regional context",
    (bookType) => {
      const workbook = utils.book_new();
      const sheet = utils.aoa_to_sheet([
        ["地域", "学校名", "電話番号", "FAX番号"],
        ["東京都", "第一小学校", "03-1234-5678", "03-1234-9999"],
        [null, "第二小学校", "03-2345-6789", "03-2345-9999"],
      ]);
      sheet["!merges"] = [{ s: { r: 1, c: 0 }, e: { r: 2, c: 0 } }];
      utils.book_append_sheet(workbook, sheet, "小学校");
      const bytes: unknown = write(workbook, { type: "buffer", bookType });
      if (!(bytes instanceof Uint8Array)) throw new Error("Missing workbook");
      expect(readWorkbookTables(bytes)[0]?.rows).toEqual([
        ["地域", "学校名", "電話番号", "FAX番号"],
        ["東京都", "第一小学校", "03-1234-5678", "03-1234-9999"],
        ["東京都", "第二小学校", "03-2345-6789", "03-2345-9999"],
      ]);
    },
  );
});
