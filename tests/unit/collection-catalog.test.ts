import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { afterEach, expect, it, vi } from "vitest";
import { discoverCatalog } from "../../tools/collection/catalog.ts";
import {
  type CollectionManifest,
  DirectorySourceSchema,
} from "../../tools/collection/models.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("retains reviewed sources and admits only matching licensed directory candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-catalog-"));
  roots.push(root);
  const reviewed = v.parse(DirectorySourceSchema, {
    id: "odm:schools:reviewed",
    url: "https://example.go.jp/reviewed.csv",
    publisher: "Example Prefecture",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    dataAsOf: "2026-05-01",
    prefectureCode: "13",
    category: "public_facility",
    format: "csv",
    selector: "table",
    kindValues: {},
    minimumContacts: 42,
    columns: { name: [1], address: [2], phone: [4] },
  });
  const manifest: CollectionManifest = {
    formatVersion: 1,
    registryAsOf: "2026-05-01",
    schoolRegistry: [],
    sources: [reviewed],
  };
  const resource = (
    id: string,
    name: string,
  ): {
    id: string;
    name: string;
    format: string;
    url: string;
  } => ({ id, name, format: "CSV", url: `https://example.go.jp/${id}.csv` });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: {
          count: 3,
          results: [
            {
              id: "schools",
              title: "学校一覧",
              license_id: "cc-by-40-intl",
              organization: { name: "130001", title: "東京都" },
              resources: [
                resource("reviewed", "学校一覧"),
                resource("added", "中学校一覧"),
                resource("sports", "体育館一覧"),
              ],
            },
            {
              id: "unrelated",
              title: "消防の動き",
              license_id: "cc-by-40-intl",
              organization: null,
              resources: [resource("events", "広報資料")],
            },
            {
              id: "restricted",
              title: "学校一覧",
              license_id: "all-rights-reserved",
              organization: null,
              resources: [resource("restricted", "学校一覧")],
            },
          ],
        },
      }),
    ),
  );
  const source = join(root, "sources.json");
  const output = join(root, "candidates.json");
  await writeFile(source, JSON.stringify(manifest));
  await discoverCatalog({
    baseManifest: source,
    output,
    cache: join(root, "cache"),
    offline: false,
    query: "学校",
    pattern: "一覧",
  });
  const result: unknown = JSON.parse(await readFile(output, "utf8"));
  expect(result).toMatchObject({
    sources: [
      reviewed,
      { id: "odm:schools:added", minimumContacts: 0 },
      { id: "odm:schools:sports", minimumContacts: 0 },
    ],
  });
  expect(result).toHaveProperty("sources.length", 3);
});
