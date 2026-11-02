import * as v from "valibot";
import { directoryArchiveFile } from "./directory-archive.ts";
import {
  directoryDeltaFile,
  directoryDeltaFilePattern,
} from "./directory-delta.ts";
import {
  CountSchema,
  DatasetListingSchema,
  type DatasetManifest,
  DatasetManifestSchema,
  DigestSchema,
} from "./models.ts";
import { searchIndexFile, searchIndexLimits } from "./search-index.ts";

// A year of monthly snapshots; a client further behind downloads the complete archive.
export const maximumDirectoryDeltas = 12;

export const SearchIndexArtifactSchema = v.strictObject({
  file: v.literal(searchIndexFile),
  sha256: DigestSchema,
  bytes: v.pipe(CountSchema, v.maxValue(searchIndexLimits.compressedBytes)),
  uncompressedSha256: DigestSchema,
  uncompressedBytes: CountSchema,
});

const DirectoryDeltaEntries = {
  base: DigestSchema,
  baseArchiveSha256: DigestSchema,
  file: v.pipe(v.string(), v.regex(directoryDeltaFilePattern)),
  sha256: DigestSchema,
  bytes: CountSchema,
  uncompressedSha256: DigestSchema,
  uncompressedBytes: CountSchema,
};

export const DirectoryDeltaArtifactSchema = v.pipe(
  v.strictObject(DirectoryDeltaEntries),
  v.check(
    (artifact) => artifact.file === directoryDeltaFile(artifact.base),
    "A directory delta file must name its base snapshot",
  ),
);
export type DirectoryDeltaArtifact = v.InferOutput<
  typeof DirectoryDeltaArtifactSchema
>;

const PublicListingSchema = v.object(DatasetListingSchema.entries);

export const PreparedDatasetManifestSchema = v.pipe(
  v.strictObject({
    ...DatasetListingSchema.entries,
    searchIndex: SearchIndexArtifactSchema,
    deltas: v.optional(
      v.pipe(
        v.array(DirectoryDeltaArtifactSchema),
        v.maxLength(maximumDirectoryDeltas),
      ),
      [],
    ),
  }),
  v.check((manifest) => {
    const listing = v.safeParse(PublicListingSchema, manifest);
    return listing.success && v.is(DatasetManifestSchema, listing.output);
  }, "A prepared manifest must hold a complete public dataset listing"),
  v.check(
    (manifest) =>
      manifest.deltas.every(
        (delta, index) =>
          delta.base !== manifest.snapshot &&
          (index === 0 ||
            (manifest.deltas[index - 1]?.base ?? "") < delta.base),
      ),
    "Directory deltas must start from distinct earlier snapshots in ascending order",
  ),
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

type DatasetApiBase = "/api" | "/api/v1";

function datasetUrl(
  base: DatasetApiBase,
  snapshot: string,
  sha256: string,
  file: string,
): string {
  return `${base}/datasets/${snapshot}/${sha256}/${file}`;
}

export const DirectoryDeltaListingSchema = v.pipe(
  v.strictObject({
    snapshot: DigestSchema,
    archiveSha256: DigestSchema,
    deltas: v.array(
      v.strictObject({ ...DirectoryDeltaEntries, url: v.string() }),
    ),
  }),
  v.check(
    (listing) =>
      listing.deltas.every((delta) =>
        (["/api", "/api/v1"] as const).some(
          (base) =>
            delta.url ===
            datasetUrl(base, listing.snapshot, delta.sha256, delta.file),
        ),
      ),
    "A directory delta URL must name its target snapshot and digest",
  ),
);
export type DirectoryDeltaListing = v.InferOutput<
  typeof DirectoryDeltaListingSchema
>;

export function directoryDeltaListing(
  manifest: PreparedDatasetManifest,
  base: DatasetApiBase,
): DirectoryDeltaListing {
  const archive = manifest.files.find(
    (file) => file.file === directoryArchiveFile,
  );
  if (!archive)
    throw new Error("The prepared manifest has no directory archive");
  return v.parse(DirectoryDeltaListingSchema, {
    snapshot: manifest.snapshot,
    archiveSha256: archive.sha256,
    deltas: manifest.deltas.map((delta) => ({
      ...delta,
      url: datasetUrl(base, manifest.snapshot, delta.sha256, delta.file),
    })),
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
