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
