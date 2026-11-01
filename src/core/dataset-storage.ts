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

export const SearchIndexLocationSchema = v.pipe(
  v.strictObject({
    snapshot: DigestSchema,
    url: v.string(),
    sha256: DigestSchema,
    bytes: SearchIndexArtifactSchema.entries.bytes,
    uncompressedSha256: DigestSchema,
    uncompressedBytes: CountSchema,
  }),
  v.check(
    (location) =>
      location.url ===
      `/api/search-index/${location.snapshot}/${location.sha256}`,
    "A search index URL must name its snapshot and digest",
  ),
);
export type SearchIndexLocation = v.InferOutput<
  typeof SearchIndexLocationSchema
>;

export function searchIndexLocation(
  manifest: PreparedDatasetManifest,
): SearchIndexLocation {
  const { sha256, bytes, uncompressedSha256, uncompressedBytes } =
    manifest.searchIndex;
  return v.parse(SearchIndexLocationSchema, {
    snapshot: manifest.snapshot,
    url: `/api/search-index/${manifest.snapshot}/${sha256}`,
    sha256,
    bytes,
    uncompressedSha256,
    uncompressedBytes,
  });
}

export function searchIndexObjectKey(snapshot: string, sha256: string): string {
  return `${v.parse(DigestSchema, snapshot)}/${v.parse(DigestSchema, sha256)}/${searchIndexFile}`;
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
