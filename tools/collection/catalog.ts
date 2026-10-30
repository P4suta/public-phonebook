import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { PrefectureCodeSchema } from "../../src/core/catalog.ts";
import { PublicUrlSchema } from "../../src/core/models.ts";
import { ArtifactStore } from "./artifacts.ts";
import {
  CollectionManifestSchema,
  type DirectorySource,
  DirectorySourceSchema,
} from "./models.ts";

const catalogBase = "https://odm.bodik.jp";
const publicDataLicenseUrl =
  "https://www.digital.go.jp/resources/open_data/public_data_license_v1.0";
const attributionLicenseUrl = "https://creativecommons.org/licenses/by/4.0/";
const japaneseAttributionLicenseUrl =
  "https://creativecommons.org/licenses/by/2.1/jp/";
const catalogPageSize = 500;
const maximumCatalogResults = 5000;
const prefectureCodeWidth = 2;
const jsonIndentation = 2;
const licensedIds = new Set([
  "cc-by",
  "CC-BY-4.0",
  "cc-by-4.0",
  "cc-by-40",
  "cc-by-40-intl",
  "CC-BY-2.1-JP",
  "cc-by-21-jp",
  "pdl",
  "PDL1.0",
  "PDL-1.0",
]);
const PackageSchema = v.object({
  id: v.string(),
  title: v.string(),
  license_id: v.nullable(v.string()),
  organization: v.nullable(v.object({ name: v.string(), title: v.string() })),
  resources: v.array(
    v.object({
      id: v.string(),
      name: v.optional(v.nullable(v.string())),
      format: v.string(),
      url: v.string(),
    }),
  ),
});
const SearchResponseSchema = v.object({
  success: v.literal(true),
  result: v.object({ count: v.number(), results: v.array(PackageSchema) }),
});

export async function discoverCatalog(input: {
  baseManifest: string;
  output: string;
  cache: string;
  offline: boolean;
  query: string;
}): Promise<void> {
  const baseValue: unknown = JSON.parse(
    await readFile(input.baseManifest, "utf8"),
  );
  const base = v.parse(CollectionManifestSchema, baseValue);
  const store = new ArtifactStore(input.cache, { offline: input.offline });
  const sources = new Map<string, DirectorySource>(
    base.sources
      .filter((source) => !source.id.startsWith("odm:"))
      .map((source) => [source.id, source]),
  );
  const excluded: Record<string, number> = {};
  for (const query of input.query.split(",")) {
    for (
      let start = 0;
      start < maximumCatalogResults;
      start += catalogPageSize
    ) {
      const url = new URL("/api/3/action/package_search", catalogBase);
      url.search = new URLSearchParams({
        q: query,
        rows: String(catalogPageSize),
        start: String(start),
        sort: "id asc",
      }).toString();
      const artifact = await store.get(url.href);
      const responseValue: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await store.read(artifact),
        ),
      );
      const response = v.parse(SearchResponseSchema, responseValue);
      if (response.result.count > maximumCatalogResults)
        throw new Error("The catalog query exceeds its bounded result budget");
      for (const item of response.result.results) {
        if (
          /統計|調査|通学区域|給食|児童数|生徒数|教員数|職員数|学校数|校区|面積|公会計|固定資産|財政|財務|人口|市勢|決算|予算|水質|利用状況|会議|研究|計画|入札|登録制度|健康診断|学校保健|白書|年鑑/u.test(
            item.title,
          )
        ) {
          excluded.unrelated_dataset = (excluded.unrelated_dataset ?? 0) + 1;
          continue;
        }
        if (!item.license_id || !licensedIds.has(item.license_id)) {
          excluded.unrecognized_reuse_terms =
            (excluded.unrecognized_reuse_terms ?? 0) + 1;
          continue;
        }
        const prefecture = v.safeParse(
          PrefectureCodeSchema,
          item.organization?.name.slice(0, prefectureCodeWidth),
        );
        const indexUrl = new URL(`/dataset/${item.id}`, catalogBase).href;
        const pdl = item.license_id.toLowerCase().includes("pdl");
        const licenseUrl = pdl
          ? publicDataLicenseUrl
          : item.license_id.toLowerCase().includes("4")
            ? attributionLicenseUrl
            : item.license_id.toLowerCase().includes("21") ||
                item.license_id.includes("2.1")
              ? japaneseAttributionLicenseUrl
              : indexUrl;
        for (const resource of item.resources) {
          if (
            /統計|調査|通学区域|給食|児童数|生徒数|教員数|学校数|面積|財政|財務|人口|決算|予算|健康|体育|募集|行事|イベント|献立|学力|図書|就学/u.test(
              resource.name ?? "",
            )
          )
            continue;
          const format =
            resource.format.toLowerCase() === "csv"
              ? "csv"
              : ["xlsx", "xls"].includes(resource.format.toLowerCase())
                ? "workbook"
                : null;
          if (
            !format ||
            !v.safeParse(PublicUrlSchema, resource.url).success ||
            !resource.url.startsWith("https:")
          )
            continue;
          const id = `odm:${item.id}:${resource.id}`;
          sources.set(
            id,
            v.parse(DirectorySourceSchema, {
              id,
              title: item.title,
              resourceName: resource.name ?? item.title,
              url: resource.url,
              indexUrl,
              provenanceUrl: artifact.url,
              publisher: item.organization?.title ?? item.title,
              license: pdl
                ? "PDL 1.0"
                : item.license_id === "cc-by"
                  ? "CC BY (publisher metadata)"
                  : item.license_id,
              licenseUrl,
              dataAsOf: "Not specified by publisher",
              ...(prefecture.success
                ? { prefectureCode: prefecture.output }
                : {}),
              category: "public_facility",
              format,
              minimumContacts: 0,
            }),
          );
        }
      }
      if (start + response.result.results.length >= response.result.count)
        break;
      if (!response.result.results.length)
        throw new Error("Catalog pagination ended before its declared count");
    }
  }
  const manifest = v.parse(CollectionManifestSchema, {
    ...base,
    sources: Array.from(sources.values()),
  });
  await writeFile(
    input.output,
    JSON.stringify(manifest, null, jsonIndentation) + "\n",
  );
  console.info(
    JSON.stringify({
      phase: "catalog.discovered",
      sources: sources.size,
      excluded,
    }),
  );
}
