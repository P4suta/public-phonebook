import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectCollectedSources } from "@public-phonebook/data/collection/select";
import { expect, it } from "vitest";

it("excludes partially failed plans and preserves reviewed contact floors", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-selection-"));
  try {
    const source = {
      url: "https://example.go.jp/directory.csv",
      publisher: "Example Prefecture",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      dataAsOf: "2026-05-01",
      prefectureCode: "13",
      category: "public_facility",
      format: "csv",
      minimumContacts: 10,
    };
    const manifest = join(root, "manifest.json");
    const report = join(root, "report.json");
    const output = join(root, "selected.json");
    await writeFile(
      manifest,
      JSON.stringify({
        formatVersion: 1,
        registryAsOf: "2026-05-01",
        schoolRegistry: [],
        sources: [
          { ...source, id: "reviewed" },
          { ...source, id: "partial" },
        ],
      }),
    );
    await writeFile(
      report,
      JSON.stringify({
        plans: [
          {
            plan: "reviewed",
            contacts: 8,
            rows: 8,
            missingPhone: 0,
            invalid: 0,
          },
          {
            plan: "partial",
            contacts: 20,
            rows: 20,
            missingPhone: 0,
            invalid: 0,
          },
        ],
        failures: [{ id: "partial", error: "A later resource failed" }],
      }),
    );
    await selectCollectedSources({
      manifest,
      report,
      output,
      acceptedOnly: true,
    });
    const selected: unknown = JSON.parse(await readFile(output, "utf8"));
    expect(selected).toMatchObject({
      sources: [{ id: "reviewed", minimumContacts: 10 }],
    });
    expect(selected).toHaveProperty("sources.length", 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
