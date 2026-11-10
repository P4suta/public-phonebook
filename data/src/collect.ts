import { parseArgs } from "node:util";
import { ArtifactStore } from "@public-phonebook/data/collection/artifacts";
import { discoverCatalog } from "@public-phonebook/data/collection/catalog";
import { profileHeaders } from "@public-phonebook/data/collection/profile";
import { readPdfTables } from "@public-phonebook/data/collection/read-pdf";
import {
  decodeSourceText,
  readCsvTables,
  readHtmlTables,
  readWorkbookTables,
} from "@public-phonebook/data/collection/read-tables";
import { collectDirectories } from "@public-phonebook/data/collection/run";
import { selectCollectedSources } from "@public-phonebook/data/collection/select";
import { load } from "cheerio";
import * as v from "valibot";

const commandArgumentOffset = 2;
const defaultCache = ".local/collection/cache";
const inspectionRowCount = 8;
const jsonIndentation = 2;

const options = parseArgs({
  args: process.argv.slice(commandArgumentOffset),
  allowPositionals: true,
  options: {
    cache: { type: "string", default: defaultCache },
    offline: { type: "boolean", default: false },
    format: { type: "string" },
    sheet: { type: "string" },
    row: { type: "string" },
    columns: { type: "string" },
    "pdf-columns": { type: "string" },
    "record-column": { type: "string" },
    limit: { type: "string" },
    summary: { type: "boolean", default: false },
    pattern: { type: "string" },
    output: { type: "string" },
    only: { type: "string" },
    query: { type: "string", default: "学校,公共施設" },
    report: { type: "string" },
    "accepted-only": { type: "boolean", default: false },
    "reuse-cache": { type: "boolean", default: false },
  },
});
const [command, url] = options.positionals;
if (command === "profile") {
  if (!url || !options.values.output || !options.values.report)
    throw new Error(
      "Usage: collect profile MANIFEST --report REPORT --output REPORT",
    );
  await profileHeaders({
    manifest: url,
    report: options.values.report,
    output: options.values.output,
    cache: options.values.cache,
  });
} else if (command === "select") {
  if (!url || !options.values.output || !options.values.report)
    throw new Error(
      "Usage: collect select MANIFEST --report REPORT --output MANIFEST [--accepted-only]",
    );
  await selectCollectedSources({
    manifest: url,
    report: options.values.report,
    output: options.values.output,
    acceptedOnly: options.values["accepted-only"],
  });
} else if (command === "catalog") {
  if (!url || !options.values.output)
    throw new Error(
      "Usage: collect catalog BASE_MANIFEST --output MANIFEST [--query QUERY,...] [--pattern PATTERN]",
    );
  await discoverCatalog({
    baseManifest: url,
    output: options.values.output,
    cache: options.values.cache,
    offline: options.values.offline,
    query: options.values.query,
    ...(options.values.pattern ? { pattern: options.values.pattern } : {}),
  });
} else if (command === "run") {
  if (!url || !options.values.output)
    throw new Error(
      "Usage: collect run MANIFEST --output DIRECTORY [--offline] [--only PATTERN]",
    );
  await collectDirectories({
    manifest: url,
    output: options.values.output,
    cache: options.values.cache,
    offline: options.values.offline,
    preferCached: options.values["reuse-cache"],
    ...(options.values.only ? { only: options.values.only } : {}),
  });
} else {
  if ((command !== "inspect" && command !== "links") || !url)
    throw new Error(
      "Usage: collect inspect URL --format csv|workbook|html [--sheet NAME] [--row INDEX] [--columns INDEX,...]",
    );
  const store = new ArtifactStore(options.values.cache, {
    offline: options.values.offline,
  });
  const artifact = await store.get(url);
  const bytes = await store.read(artifact);
  if (command === "links") {
    const $ = load(decodeSourceText(bytes));
    const pattern = new RegExp(options.values.pattern ?? ".", "iu");
    const links = $("a[href]")
      .toArray()
      .flatMap((node) => {
        const href = $(node).attr("href");
        if (!href) return [];
        const target = new URL(href, artifact.resolvedUrl);
        const label =
          $(node).text().trim() || $(node).find("img").attr("alt") || "";
        return target.protocol === "https:" &&
          pattern.test(`${label} ${target.href}`)
          ? [{ label, url: target.href }]
          : [];
      });
    console.info(JSON.stringify(links, null, jsonIndentation));
    process.exitCode = 0;
  } else {
    const format = v.parse(
      v.picklist(["csv", "workbook", "html", "pdf"]),
      options.values.format,
    );
    const tables =
      format === "csv"
        ? readCsvTables(bytes)
        : format === "workbook"
          ? readWorkbookTables(bytes)
          : format === "pdf"
            ? await readPdfTables(
                bytes,
                options.values["pdf-columns"]
                  ?.split(",")
                  .map((value) =>
                    v.parse(
                      v.pipe(v.number(), v.finite(), v.minValue(0)),
                      Number(value),
                    ),
                  ),
                options.values["record-column"] === undefined
                  ? undefined
                  : v.parse(
                      v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
                      Number(options.values["record-column"]),
                    ),
              )
            : readHtmlTables(decodeSourceText(bytes));
    const start = v.parse(
      v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
      Number(options.values.row ?? 0),
    );
    const columns = options.values.columns
      ?.split(",")
      .map((value) =>
        v.parse(
          v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
          Number(value),
        ),
      );
    const limit = v.parse(
      v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1000)),
      Number(options.values.limit ?? inspectionRowCount),
    );
    console.info(
      JSON.stringify(
        (options.values.summary
          ? tables
          : options.values.sheet
            ? tables.filter((table) => table.name === options.values.sheet)
            : tables.slice(0, 1)
        ).map((table) => ({
          name: table.name,
          rowCount: table.rows.length,
          rows: options.values.summary
            ? []
            : table.rows.slice(start, start + limit).map((row) =>
                columns
                  ? columns.map((column) => ({
                      column,
                      value: row[column] ?? "",
                    }))
                  : row
                      .map((value, column) => ({ column, value }))
                      .filter((cell) => cell.value !== ""),
              ),
        })),
        null,
        jsonIndentation,
      ),
    );
  }
}
