import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedProductionDataBundle } from "@public-phonebook/data/check-data";
import { PreparedDatasetManifestSchema } from "@public-phonebook/directory/dataset-storage";
import * as v from "valibot";
import { expect, it } from "vitest";
import { writeCheckFixture } from "../../tools/check-fixture.ts";

it("rejects a local ranking bundle before starting production data verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "production-data-"));
  try {
    const bundle = join(root, "bundle");
    await writeCheckFixture(bundle);
    const manifest = v.parse(
      PreparedDatasetManifestSchema,
      JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
    );
    await writeFile(
      join(bundle, "manifest.ready.json"),
      JSON.stringify({
        ...manifest,
        searchRanking: {
          ...manifest.searchIndex,
          file: "search-ranking.br",
          format: "public-phonebook-search-ranking/2",
        },
      }),
    );
    await expect(checkedProductionDataBundle(bundle)).rejects.toThrow(
      "omit ranking companions",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
