import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as v from "valibot";
import type { SourceTable } from "./read-tables.ts";

const maximumPdfPages = 1000;
const sameLineTolerance = 2;
const horizontalCoordinate = 4;
const verticalCoordinate = 5;
const PdfPointSchema = v.tuple([
  v.pipe(v.number(), v.finite()),
  v.pipe(v.number(), v.finite()),
]);
type PdfCell = { readonly y: number; text: string }[];

export async function readPdfTables(
  bytes: Uint8Array,
  boundaries?: readonly number[],
  recordColumn?: number,
): Promise<readonly SourceTable[]> {
  if (recordColumn !== undefined && !boundaries)
    throw new Error("PDF record markers require reviewed column boundaries");
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
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines: { y: number; items: { x: number; text: string }[] }[] = [];
      const streamItems: { x: number; y: number; text: string }[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const rawX: unknown = item.transform[horizontalCoordinate];
        const rawY: unknown = item.transform[verticalCoordinate];
        if (
          typeof rawX !== "number" ||
          typeof rawY !== "number" ||
          !Number.isFinite(rawX) ||
          !Number.isFinite(rawY)
        )
          throw new Error("Invalid PDF text coordinates");
        const point: unknown =
          page.rotate === 0
            ? [rawX, viewport.height - rawY]
            : viewport.convertToViewportPoint(rawX, rawY);
        const [x, top] = v.parse(PdfPointSchema, point);
        const y = viewport.height - top;
        streamItems.push({ x, y, text: item.str });
        let line = lines.find(
          (candidate) => Math.abs(candidate.y - y) <= sameLineTolerance,
        );
        if (!line) {
          line = { y, items: [] };
          lines.push(line);
        }
        line.items.push({ x, text: item.str });
      }
      const orderedLines = lines.sort((a, b) => b.y - a.y);
      let rows = orderedLines.map((line) => {
        const items = line.items.sort((a, b) => a.x - b.x);
        if (!boundaries)
          return items.map((item) => `${Math.round(item.x)}:${item.text}`);
        const cells: string[] = Array.from(boundaries, () => "");
        for (const item of items) {
          const column = boundaries.findLastIndex(
            (boundary) => item.x >= boundary,
          );
          if (column >= 0) cells[column] = `${cells[column] ?? ""}${item.text}`;
        }
        return cells;
      });
      if (recordColumn !== undefined && boundaries) {
        const highestMarkerY = orderedLines.reduce(
          (highest, line, index) =>
            rows[index]?.[recordColumn]?.trim()
              ? Math.max(highest, line.y)
              : highest,
          Number.NEGATIVE_INFINITY,
        );
        const folios = orderedLines.filter(
          (_, index) =>
            rows[index]?.filter(Boolean).join("").replace(/\s/gu, "") ===
            `${number}/${pdf.numPages}`,
        );
        const groups: PdfCell[][] = [];
        let current: PdfCell[] | undefined;
        let markerY: number | undefined;
        let pending = Array.from(boundaries, (): PdfCell => []);
        for (const item of streamItems) {
          if (
            markerY !== undefined &&
            markerY < highestMarkerY - sameLineTolerance &&
            item.y > highestMarkerY + sameLineTolerance
          )
            continue;
          if (
            folios.some(
              (line) => Math.abs(line.y - item.y) <= sameLineTolerance,
            )
          )
            continue;
          const column = boundaries.findLastIndex(
            (boundary) => item.x >= boundary,
          );
          if (column < 0) continue;
          if (
            column === recordColumn &&
            (markerY === undefined ||
              Math.abs(markerY - item.y) > sameLineTolerance)
          ) {
            current = pending;
            pending = Array.from(boundaries, (): PdfCell => []);
            groups.push(current);
            markerY = item.y;
          }
          const cell = (column < recordColumn ? pending : current)?.[column];
          if (!cell) continue;
          const previous = cell.at(-1);
          if (previous && Math.abs(previous.y - item.y) <= sameLineTolerance)
            previous.text += item.text;
          else cell.push({ y: item.y, text: item.text });
        }
        rows = groups.map((group) =>
          group.map((cells) => cells.map((cell) => cell.text).join("\n")),
        );
      }
      tables.push({ name: `Page ${number}`, rows });
      page.cleanup();
    }
    return tables;
  } finally {
    await task.destroy();
  }
}
