import { load } from "cheerio";
import { parse } from "csv-parse/sync";
import * as v from "valibot";
import { read, utils } from "xlsx";

const maximumTableRows = 100000;
const maximumTableColumns = 256;
const defaultSpan = 1;

export interface SourceTable {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

export function decodeSourceText(bytes: Uint8Array): string {
  const failures: unknown[] = [];
  for (const encoding of ["utf-8", "shift_jis"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(
    failures,
    "The source has no supported lossless encoding",
  );
}

function checkedRows(value: unknown): string[][] {
  const rows = v.parse(
    v.pipe(
      v.array(
        v.pipe(
          v.array(v.union([v.string(), v.number(), v.boolean(), v.null()])),
          v.maxLength(maximumTableColumns),
        ),
      ),
      v.maxLength(maximumTableRows),
    ),
    value,
  );
  return rows.map((row) =>
    row.map((cell) => (cell === null ? "" : String(cell))),
  );
}

export function readCsvTables(bytes: Uint8Array): readonly SourceTable[] {
  const raw: unknown = parse(decodeSourceText(bytes), {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
  });
  return [{ name: "CSV", rows: checkedRows(raw) }];
}

export function readWorkbookTables(bytes: Uint8Array): readonly SourceTable[] {
  const workbook = read(bytes, {
    type: "array",
    cellFormula: false,
    bookVBA: false,
    sheetRows: maximumTableRows + 1,
  });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (!sheet) throw new Error(`Missing worksheet: ${name}`);
    const fullRange: unknown = sheet["!fullref"] ?? sheet["!ref"];
    if (fullRange !== undefined) {
      const range = utils.decode_range(v.parse(v.string(), fullRange));
      if (range.e.r >= maximumTableRows || range.e.c >= maximumTableColumns)
        throw new Error(`Worksheet exceeds the table bounds: ${name}`);
    }
    const raw: unknown = utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
    });
    const rows = checkedRows(raw);
    for (const range of sheet["!merges"] ?? []) {
      if (range.e.r >= maximumTableRows || range.e.c >= maximumTableColumns)
        throw new Error(`Merged cells exceed the table bounds: ${name}`);
      const text = rows[range.s.r]?.[range.s.c] ?? "";
      if (!text) continue;
      for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
        const row = rows[rowIndex] ?? [];
        rows[rowIndex] = row;
        for (let column = range.s.c; column <= range.e.c; column += 1) {
          row[column] = text;
        }
      }
    }
    return { name, rows };
  });
}

function span(value: string | undefined, remaining: number): number {
  if (value === undefined) return defaultSpan;
  if (!/^[0-9]+$/u.test(value)) throw new Error("Invalid table span");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > remaining)
    throw new Error("Table span exceeds its bounds");
  return number === 0 ? remaining : number;
}

export function readHtmlTables(
  html: string,
  selector = "table",
): readonly SourceTable[] {
  const $ = load(html);
  $("br").replaceWith("\n");
  return $(selector)
    .toArray()
    .map((table, tableIndex) => {
      const elements = $(table)
        .find("tr")
        .toArray()
        .filter((row) => $(row).closest("table").get(0) === table);
      if (elements.length > maximumTableRows)
        throw new Error("HTML table exceeds its row bounds");
      const rows: string[][] = [];
      for (const [rowIndex, element] of elements.entries()) {
        const row = rows[rowIndex] ?? [];
        rows[rowIndex] = row;
        let column = 0;
        for (const cell of $(element).children("td, th").toArray()) {
          while (row[column] !== undefined) column += 1;
          if (column >= maximumTableColumns)
            throw new Error("HTML table exceeds its column bounds");
          const width = span(
            $(cell).attr("colspan"),
            maximumTableColumns - column,
          );
          const height = span(
            $(cell).attr("rowspan"),
            elements.length - rowIndex,
          );
          const text = $(cell).text().replaceAll("\u00a0", " ").trim();
          for (
            let nextRow = rowIndex;
            nextRow < rowIndex + height;
            nextRow += 1
          ) {
            const target = rows[nextRow] ?? [];
            rows[nextRow] = target;
            for (let offset = 0; offset < width; offset += 1) {
              if (target[column + offset] !== undefined)
                throw new Error("Overlapping HTML table cells");
              target[column + offset] = text;
            }
          }
          column += width;
        }
      }
      return {
        name:
          $(table).find("caption").first().text().trim() ||
          `table-${tableIndex + 1}`,
        rows: rows.map((row) => Array.from(row, (cell) => cell ?? "")),
      };
    });
}
