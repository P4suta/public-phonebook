import * as v from "valibot";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "./catalog.ts";
import { IdentifierSchema, SortableNameSchema } from "./identity.ts";
import { normalizePhone } from "./phone.ts";

const completeArchiveCount = 3;
const sha256HexLength = 64;

export const DigestSchema = v.pipe(
  v.string(),
  v.length(sha256HexLength),
  v.regex(/^[a-f0-9]{64}$/u),
);
const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const TextSchema = v.pipe(v.string(), v.minLength(1));
export const PublicUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.check((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  }),
);
export const PhoneSchema = v.pipe(
  v.strictObject({
    display: TextSchema,
    e164: v.pipe(v.string(), v.regex(/^\+81[1-9][0-9]{8,9}$/)),
  }),
  v.check((phone) => {
    const normalized = normalizePhone(phone.display);
    return normalized.ok && normalized.value === phone.e164;
  }, "The source telephone spelling must match its dial destination"),
);
export const ContactSchema = v.strictObject({
  id: IdentifierSchema,
  name: SortableNameSchema,
  category: CategorySchema,
  prefectureCode: PrefectureCodeSchema,
  municipalityCode: v.nullable(MunicipalityCodeSchema),
  address: v.string(),
  phones: v.pipe(v.array(PhoneSchema), v.minLength(1)),
  website: v.nullable(PublicUrlSchema),
  sourceId: TextSchema,
  sourceRecordId: TextSchema,
  sourceUrls: v.pipe(v.array(PublicUrlSchema), v.minLength(1)),
  license: TextSchema,
  licenseUrl: PublicUrlSchema,
  dataAsOf: v.string(),
  retrievedAt: TextSchema,
  phoneConfirmed: v.boolean(),
  phoneConfirmationUrl: v.nullable(PublicUrlSchema),
});
export type Contact = v.InferOutput<typeof ContactSchema>;

export const SourceSchema = v.strictObject({
  id: TextSchema,
  publisher: v.optional(TextSchema),
  title: v.optional(TextSchema),
  url: PublicUrlSchema,
  sha256: DigestSchema,
  dataAsOf: v.string(),
  retrievedAt: TextSchema,
  indexUrl: v.nullable(PublicUrlSchema),
  indexSha256: v.nullable(DigestSchema),
  licenseUrl: v.nullable(PublicUrlSchema),
  licenseSha256: v.nullable(DigestSchema),
  artifacts: v.array(
    v.strictObject({
      url: PublicUrlSchema,
      sha256: DigestSchema,
      retrievedAt: TextSchema,
    }),
  ),
  rows: CountSchema,
  accepted: CountSchema,
  missingPhone: CountSchema,
  invalid: CountSchema,
  duplicate: CountSchema,
  issues: v.record(v.string(), CountSchema),
});
export type Source = v.InferOutput<typeof SourceSchema>;

export const CatalogSchema = v.strictObject({
  snapshot: DigestSchema,
  generatedAt: TextSchema,
  contacts: CountSchema,
  phones: CountSchema,
  sourceCount: CountSchema,
  categories: v.array(
    v.strictObject({
      id: CategorySchema,
      label: TextSchema,
      contacts: CountSchema,
      publisher: TextSchema,
      license: TextSchema,
      licenseUrl: PublicUrlSchema,
    }),
  ),
  prefectures: v.array(
    v.strictObject({
      code: PrefectureCodeSchema,
      name: TextSchema,
      contacts: CountSchema,
    }),
  ),
  municipalities: v.array(
    v.strictObject({
      code: MunicipalityCodeSchema,
      prefectureCode: PrefectureCodeSchema,
      name: TextSchema,
    }),
  ),
});
export type Catalog = v.InferOutput<typeof CatalogSchema>;

export const DatasetFileSchema = v.strictObject({
  file: v.picklist(["contacts.jsonl.gz", "contacts.csv.gz", "contacts.vcf.gz"]),
  sha256: DigestSchema,
  bytes: CountSchema,
  url: v.string(),
});
const CompleteDatasetManifestSchema = v.pipe(
  v.strictObject({
    snapshot: DigestSchema,
    generatedAt: TextSchema,
    contacts: CountSchema,
    phones: CountSchema,
    sourceCount: CountSchema,
    sourceDatabaseSha256: DigestSchema,
    databaseSha256: DigestSchema,
    files: v.pipe(v.array(DatasetFileSchema), v.length(completeArchiveCount)),
  }),
  v.check(
    (manifest) =>
      new Set(manifest.files.map((file) => file.file)).size ===
      completeArchiveCount,
  ),
);
export const DatasetManifestSchema = v.pipe(
  CompleteDatasetManifestSchema,
  v.check((manifest) =>
    manifest.files.every(
      (file) =>
        file.url ===
        `/api/datasets/${manifest.snapshot}/${file.sha256}/${file.file}`,
    ),
  ),
);
export type DatasetManifest = v.InferOutput<typeof DatasetManifestSchema>;

export const VersionedDatasetManifestSchema = v.pipe(
  CompleteDatasetManifestSchema,
  v.check((manifest) =>
    manifest.files.every(
      (file) =>
        file.url ===
        `/api/v1/datasets/${manifest.snapshot}/${file.sha256}/${file.file}`,
    ),
  ),
);

export const SearchResponseSchema = v.strictObject({
  data: v.array(ContactSchema),
  meta: v.strictObject({
    snapshot: DigestSchema,
    total: CountSchema,
    nextCursor: v.nullable(v.string()),
  }),
  links: v.strictObject({
    self: PublicUrlSchema,
    next: v.nullable(PublicUrlSchema),
  }),
});
export type SearchResponse = v.InferOutput<typeof SearchResponseSchema>;

export const GroupedSearchResponseSchema = v.pipe(
  v.strictObject({
    groups: v.array(
      v.strictObject({
        category: CategorySchema,
        results: SearchResponseSchema,
      }),
    ),
    meta: v.strictObject({ snapshot: DigestSchema, total: CountSchema }),
  }),
  v.check((response) => {
    const categories = new Set<string>();
    const contacts = new Set<string>();
    let total = 0;
    for (const group of response.groups) {
      if (
        categories.has(group.category) ||
        group.results.meta.snapshot !== response.meta.snapshot
      )
        return false;
      categories.add(group.category);
      if (group.results.data.length > group.results.meta.total) return false;
      if (
        (group.results.meta.nextCursor === null) !==
        (group.results.links.next === null)
      )
        return false;
      for (const contact of group.results.data) {
        if (contact.category !== group.category || contacts.has(contact.id))
          return false;
        contacts.add(contact.id);
      }
      total += group.results.meta.total;
    }
    return total === response.meta.total;
  }, "Category previews must be disjoint and belong to one dataset and total"),
);
export type GroupedSearchResponse = v.InferOutput<
  typeof GroupedSearchResponseSchema
>;

export const ProblemSchema = v.strictObject({
  type: v.string(),
  title: v.string(),
  status: v.number(),
  code: v.picklist([
    "invalid_query",
    "conflicting_region",
    "invalid_cursor",
    "snapshot_changed",
    "not_found",
    "method_not_allowed",
    "unavailable",
  ]),
  requestId: v.string(),
});
export type Problem = v.InferOutput<typeof ProblemSchema>;
