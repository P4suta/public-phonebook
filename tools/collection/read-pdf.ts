import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { SourceTable } from "./read-tables.ts";

const maximumPdfPages = 1000;
const sameLineTolerance = 2;
const horizontalCoordinate = 4;
const verticalCoordinate = 5;

export async function readPdfTables(
  bytes: Uint8Array,
  boundaries?: readonly number[],
): Promise<readonly SourceTable[]> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
  });
  const pdf = await task.promise;
  try {
    if (pdf.numPages > maximumPdfPages)
      throw new Error("The PDF exceeds the page limit");
    const tables: SourceTable[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const lines: { y: number; items: { x: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const x: unknown = item.transform[horizontalCoordinate];
        const y: unknown = item.transform[verticalCoordinate];
        if (
          typeof x !== "number" ||
          typeof y !== "number" ||
          !Number.isFinite(x) ||
          !Number.isFinite(y)
        )
          throw new Error("Invalid PDF text coordinates");
        let line = lines.find(
          (candidate) => Math.abs(candidate.y - y) <= sameLineTolerance,
        );
        if (!line) {
          line = { y, items: [] };
          lines.push(line);
        }
        line.items.push({ x, text: item.str });
      }
      const rows = lines
        .sort((a, b) => b.y - a.y)
        .map((line) => {
          const items = line.items.sort((a, b) => a.x - b.x);
          if (!boundaries)
            return items.map((item) => `${Math.round(item.x)}:${item.text}`);
          const cells: string[] = Array.from(boundaries, () => "");
          for (const item of items) {
            const column = boundaries.findLastIndex(
              (boundary) => item.x >= boundary,
            );
            if (column >= 0)
              cells[column] = `${cells[column] ?? ""}${item.text}`;
          }
          return cells;
        });
      tables.push({ name: `Page ${number}`, rows });
      page.cleanup();
    }
    return tables;
  } finally {
    await task.destroy();
  }
}
