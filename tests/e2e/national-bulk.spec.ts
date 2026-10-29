import { createReadStream } from "node:fs";
import { expect, test } from "@playwright/test";
import { parse } from "csv-parse";
import { coverage, download, object, string } from "./support.js";

test("the complete national CSV download reconciles all records and coverage cells", async ({
  page,
  request,
}, info) => {
  test.setTimeout(240_000);
  const report = coverage(await (await request.get("/coverage.json")).json());
  await page.goto("/?page=2");
  const file = await download(page, "CSV ↓");
  const path = info.outputPath("national-contacts.csv");
  await file.saveAs(path);
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  const publishers = new Map([
    ["nursing_care", "Ministry of Health, Labour and Welfare"],
    ["disability_support", "WAM NET"],
    ["library", "National Diet Library"],
    ["museum", "National Diet Library"],
    ["archive", "National Diet Library"],
  ]);
  let total = 0;
  for await (const raw of createReadStream(path).pipe(
    parse({ columns: true }),
  )) {
    const record: unknown = raw;
    object(record);
    const id = string(record.id);
    if (ids.has(id)) throw new Error(`Duplicate exported ID: ${id}`);
    ids.add(id);
    const category = string(record.category);
    const key = `${string(record.prefecture_code)}:${category}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const publisher = publishers.get(category);
    if (publisher && !string(record.attribution).includes(publisher))
      throw new Error(`Missing publisher attribution: ${id}`);
    if (
      !/^\+81[1-9][0-9]{8,9}( \| \+81[1-9][0-9]{8,9})*$/.test(
        string(record.phone_e164),
      )
    )
      throw new Error(`Invalid exported phone: ${id}`);
    total += 1;
  }
  expect(total).toBe(report.total_contacts);
  expect(counts.size).toBe(
    report.cells.filter((cell) => cell.contacts > 0).length,
  );
  for (const cell of report.cells)
    expect(counts.get(`${cell.prefecture_code}:${cell.category}`) ?? 0).toBe(
      cell.contacts,
    );
});
