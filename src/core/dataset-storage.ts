import * as v from "valibot";
import {
  CountSchema,
  DatasetListingSchema,
  type DatasetManifest,
  DatasetManifestSchema,
  DigestSchema,
} from "./models.ts";
import { searchIndexFile, searchIndexLimits } from "./search-index.ts";

export const SearchIndexArtifactSchema = v.strictObject({
  file: v.literal(searchIndexFile),
  sha256: DigestSchema,
  bytes: v.pipe(CountSchema, v.maxValue(searchIndexLimits.compressedBytes)),
  uncompressedSha256: DigestSchema,
  uncompressedBytes: CountSchema,
});

const PublicListingSchema = v.object(DatasetListingSchema.entries);

export const PreparedDatasetManifestSchema = v.pipe(
  v.strictObject({
    ...DatasetListingSchema.entries,
    searchIndex: SearchIndexArtifactSchema,
  }),
  v.check((manifest) => {
    const listing = v.safeParse(PublicListingSchema, manifest);
    return listing.success && v.is(DatasetManifestSchema, listing.output);
  }, "A prepared manifest must hold a complete public dataset listing"),
);
export type PreparedDatasetManifest = v.InferOutput<
  typeof PreparedDatasetManifestSchema
>;

export function publicDatasetManifest(
  manifest: PreparedDatasetManifest,
): DatasetManifest {
  return v.parse(DatasetManifestSchema, v.parse(PublicListingSchema, manifest));
}

export function manifestObjectKey(
  snapshot: string,
  manifestSha256?: string,
): string {
  const checkedSnapshot = v.parse(DigestSchema, snapshot);
  return manifestSha256 === undefined
    ? `${checkedSnapshot}/manifest.json`
    : `${checkedSnapshot}/${v.parse(DigestSchema, manifestSha256)}/manifest.json`;
}
