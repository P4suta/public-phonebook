import { readPdfTables } from "@public-phonebook/data/collection/read-pdf";
import { describe, expect, it } from "vitest";

function directoryPdf(
  rotation: number,
  content = "BT /F1 10 Tf 1 0 0 1 100 50 Tm (Office) Tj 1 0 0 1 100 180 Tm (03-1234-5678) Tj ET",
  box = "0 0 300 500",
): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Rotate ${rotation} /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

describe("published PDF directory coordinates", () => {
  it("keeps tall records in text order without assigning a voice field to the next office", async () => {
    const bytes = directoryPdf(
      0,
      "BT /F1 10 Tf 1 0 0 1 10 200 Tm (Tokyo) Tj 1 0 0 1 50 200 Tm (A) Tj 1 0 0 1 100 200 Tm (First) Tj 1 0 0 1 200 130 Tm (03-1234-5678) Tj 1 0 0 1 50 100 Tm (B) Tj 1 0 0 1 100 100 Tm (Second) Tj 1 0 0 1 200 100 Tm (03-2345-6789) Tj 1 0 0 1 100 20 Tm (1 / 1) Tj 1 0 0 1 100 250 Tm (Directory title) Tj ET",
    );
    expect((await readPdfTables(bytes, [0, 40, 90, 190], 1))[0]?.rows).toEqual([
      ["Tokyo", "A", "First", "03-1234-5678"],
      ["", "B", "Second", "03-2345-6789"],
    ]);
  });

  it("preserves reviewed unrotated coordinates with a shifted page box", async () => {
    const bytes = directoryPdf(0, undefined, "-100 -20 300 500");
    expect((await readPdfTables(bytes, [0, 150]))[0]?.rows).toEqual([
      ["03-1234-5678", ""],
      ["Office", ""],
    ]);
  });

  it("keeps wrapped cells together around a reviewed record marker", async () => {
    const bytes = directoryPdf(
      0,
      "BT /F1 10 Tf 1 0 0 1 50 200 Tm (A) Tj 1 0 0 1 100 210 Tm (Fir) Tj /F2 10 Tf 1 0 0 1 112 210 Tm (st) Tj /F1 10 Tf 1 0 0 1 100 200 Tm (Office) Tj 1 0 0 1 200 200 Tm (03-1234-5678) Tj 1 0 0 1 100 190 Tm (Centre) Tj 1 0 0 1 50 170 Tm (B) Tj 1 0 0 1 100 170 Tm (Second) Tj 1 0 0 1 200 170 Tm (03-2345-6789) Tj 1 0 0 1 100 20 Tm (1 / 1) Tj ET",
    );
    expect((await readPdfTables(bytes, [0, 90, 190], 0))[0]?.rows).toEqual([
      ["A", "First\nOffice\nCentre", "03-1234-5678"],
      ["B", "Second", "03-2345-6789"],
    ]);
  });

  it("applies the published page rotation before grouping contacts", async () => {
    const tables = await readPdfTables(directoryPdf(90), [0, 150]);
    expect(tables[0]?.rows).toEqual([["Office", "03-1234-5678"]]);
  });

  it("keeps unrotated text at its published coordinates", async () => {
    const tables = await readPdfTables(directoryPdf(0), [0, 150]);
    expect(tables[0]?.rows).toEqual([
      ["03-1234-5678", ""],
      ["Office", ""],
    ]);
  });
});
