import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { ArtifactStore } from "./artifacts.ts";
import { CollectionManifestSchema } from "./models.ts";
import { readCsvTables, readWorkbookTables } from "./read-tables.ts";

const headerRows = 12;
const maximumHeaderLength = 40;
const jsonIndentation = 2;

export async function profileHeaders(input: {
  manifest: string;
  report: string;
  output: string;
  cache: string;
}): Promise<void> {
  const manifestValue: unknown = JSON.parse(
    await readFile(input.manifest, "utf8"),
  );
  const manifest = v.parse(CollectionManifestSchema, manifestValue);
  const reportValue: unknown = JSON.parse(await readFile(input.report, "utf8"));
  const report = v.parse(
    v.object({
      plans: v.array(v.object({ plan: v.string(), rows: v.number() })),
    }),
    reportValue,
  );
  const ids = new Set(
    report.plans.filter((plan) => plan.rows === 0).map((plan) => plan.plan),
  );
  const store = new ArtifactStore(input.cache, { offline: true });
  const headers = new Map<string, { count: number; sample: string }>();
  let examined = 0;
  const failures: { source: string; error: string }[] = [];
  for (const source of manifest.sources.filter(
    (source) =>
      ids.has(source.id) &&
      !source.discovery &&
      ["csv", "workbook"].includes(source.format),
  )) {
    try {
      const artifact = await store.get(source.url);
      const bytes = await store.read(artifact);
      const tables =
        source.format === "csv"
          ? readCsvTables(bytes)
          : readWorkbookTables(bytes);
      const unique = new Set(
        tables
          .flatMap((table) => table.rows.slice(0, headerRows).flat())
          .map((text) => text.normalize("NFKC").replace(/\s/gu, ""))
          .filter(
            (text) =>
              text.length < maximumHeaderLength &&
              /電話|tel|名称|施設名|校名|学校名|所在地|住所|郵便/iu.test(text),
          ),
      );
      for (const text of unique)
        headers.set(text, {
          count: (headers.get(text)?.count ?? 0) + 1,
          sample: source.url,
        });
      examined += 1;
    } catch (error) {
      failures.push({
        source: source.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await writeFile(
    input.output,
    JSON.stringify(
      {
        examined,
        headers: Array.from(headers, ([text, value]) => ({
          text,
          ...value,
        })).sort((a, b) => b.count - a.count),
        failures,
      },
      null,
      jsonIndentation,
    ) + "\n",
  );
  console.info(
    JSON.stringify({
      phase: "collection.profiled",
      examined,
      fields: headers.size,
      failures: failures.length,
    }),
  );
}
