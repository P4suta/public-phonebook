import * as v from "valibot";
import {
  CategorySchema,
  PrefectureCodeSchema,
} from "../../src/core/catalog.ts";
import { PublicUrlSchema } from "../../src/core/models.ts";

const maximumColumnIndex = 255;
const maximumDiscoveryDepth = 2;
const maximumDiscoveryPages = 256;
const ColumnSchema = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(0),
  v.maxValue(maximumColumnIndex),
);
const ColumnsSchema = v.array(ColumnSchema);

export const SourceFormatSchema = v.picklist([
  "csv",
  "workbook",
  "html",
  "pdf",
]);
export type SourceFormat = v.InferOutput<typeof SourceFormatSchema>;

export const DirectorySourceSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1)),
  url: PublicUrlSchema,
  indexUrl: v.optional(PublicUrlSchema),
  provenanceUrl: v.optional(PublicUrlSchema),
  title: v.optional(v.string()),
  resourceName: v.optional(v.string()),
  publisher: v.pipe(v.string(), v.minLength(1)),
  license: v.pipe(v.string(), v.minLength(1)),
  licenseUrl: PublicUrlSchema,
  dataAsOf: v.pipe(v.string(), v.minLength(1)),
  prefectureCode: v.optional(PrefectureCodeSchema),
  category: v.union([
    CategorySchema,
    v.literal("school"),
    v.literal("public_facility"),
  ]),
  format: SourceFormatSchema,
  tablePattern: v.optional(v.string()),
  pdfColumns: v.optional(v.array(v.pipe(v.number(), v.minValue(0)))),
  selector: v.optional(v.string(), "table"),
  columns: v.optional(
    v.strictObject({
      name: ColumnsSchema,
      address: ColumnsSchema,
      phone: ColumnsSchema,
      phoneAreaCode: v.optional(ColumnsSchema),
      postalCode: v.optional(ColumnsSchema),
      municipality: v.optional(ColumnsSchema),
      prefecture: v.optional(ColumnsSchema),
      kind: v.optional(ColumnsSchema),
      recordId: v.optional(ColumnsSchema),
      website: v.optional(ColumnsSchema),
    }),
  ),
  kindValues: v.optional(v.record(v.string(), CategorySchema), {}),
  phonePrefix: v.optional(v.pipe(v.string(), v.regex(/^0[0-9]+$/u))),
  minimumContacts: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    1,
  ),
  discovery: v.optional(
    v.strictObject({
      pattern: v.string(),
      depth: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(1),
        v.maxValue(maximumDiscoveryDepth),
      ),
      maxPages: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(1),
        v.maxValue(maximumDiscoveryPages),
      ),
      formats: v.array(SourceFormatSchema),
    }),
  ),
});
export type DirectorySource = v.InferOutput<typeof DirectorySourceSchema>;
export type SourceColumns = NonNullable<DirectorySource["columns"]>;

export const CollectionManifestSchema = v.strictObject({
  formatVersion: v.literal(1),
  registryAsOf: v.pipe(v.string(), v.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)),
  schoolRegistry: v.array(PublicUrlSchema),
  sources: v.array(DirectorySourceSchema),
});
export type CollectionManifest = v.InferOutput<typeof CollectionManifestSchema>;
