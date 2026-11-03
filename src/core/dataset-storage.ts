import * as v from "valibot";
import {
  directoryArchiveFile,
  directoryArchiveFormat,
} from "./directory-archive.ts";
import {
  directoryDeltaFile,
  directoryDeltaFilePattern,
  directoryDeltaFormat,
} from "./directory-delta.ts";
import {
  CountSchema,
  DatasetFileNameSchema,
  DatasetListingSchema,
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

export const datasetListingPath = "/api/datasets";
export const deltaListingPath = "/api/dataset-deltas";

function datasetUrl(snapshot: string, sha256: string, file: string): string {
  return `${datasetListingPath}/${snapshot}/${sha256}/${file}`;
}

/**
 * The format of each complete file: an identifier, a slash, and the version of the bytes as served, compression included.
 * A changed representation ships as another file with a new identifier beside the old one.
 */
export const datasetFileFormats = {
  "contacts.jsonl.gz": "public-phonebook-contacts-jsonl/1",
  "contacts.csv.gz": "public-phonebook-contacts-csv/1",
  "contacts.vcf.gz": "public-phonebook-contacts-vcard/1",
  [directoryArchiveFile]: directoryArchiveFormat,
} as const satisfies Record<
  v.InferOutput<typeof DatasetFileNameSchema>,
  string
>;

const { files: _storedFiles, ...listedFields } = DatasetListingSchema.entries;

export const DatasetFileListingSchema = v.pipe(
  v.strictObject({
    ...listedFields,
    files: v.array(
      v.strictObject({
        file: DatasetFileNameSchema,
        format: v.string(),
        sha256: DigestSchema,
        bytes: CountSchema,
        url: v.string(),
      }),
    ),
    datasetDeltas: v.string(),
  }),
  v.check(
    ({ datasetDeltas: _link, files, ...listing }) =>
      v.is(DatasetManifestSchema, {
        ...listing,
        files: files.map(({ format: _format, ...file }) => file),
      }),
    "A dataset listing must list each complete file once at its immutable URL",
  ),
  v.check(
    (listing) =>
      listing.files.every(
        (file) => file.format === datasetFileFormats[file.file],
      ),
    "Each listed file must declare its format",
  ),
  v.check(
    (listing) =>
      listing.datasetDeltas ===
      `${deltaListingPath}?snapshot=${listing.snapshot}`,
    "The delta link must pin the listed snapshot",
  ),
);
export type DatasetFileListing = v.InferOutput<typeof DatasetFileListingSchema>;

/** Lists the complete files of the bound manifest with their formats, and links the deltas to the same snapshot. */
export function datasetFileListing(
  manifest: PreparedDatasetManifest,
): DatasetFileListing {
  const { files, ...listing } = v.parse(PublicListingSchema, manifest);
  return v.parse(DatasetFileListingSchema, {
    ...listing,
    files: files.map((file) => ({
      file: file.file,
      format: datasetFileFormats[file.file],
      sha256: file.sha256,
      bytes: file.bytes,
      url: file.url,
    })),
    datasetDeltas: `${deltaListingPath}?snapshot=${manifest.snapshot}`,
  });
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

export const DirectoryDeltaListingSchema = v.pipe(
  v.strictObject({
    snapshot: DigestSchema,
    archiveSha256: DigestSchema,
    deltas: v.array(
      v.strictObject({
        base: DirectoryDeltaEntries.base,
        baseArchiveSha256: DirectoryDeltaEntries.baseArchiveSha256,
        file: DirectoryDeltaEntries.file,
        format: v.literal(directoryDeltaFormat),
        sha256: DirectoryDeltaEntries.sha256,
        bytes: DirectoryDeltaEntries.bytes,
        uncompressedSha256: DirectoryDeltaEntries.uncompressedSha256,
        uncompressedBytes: DirectoryDeltaEntries.uncompressedBytes,
        url: v.string(),
      }),
    ),
  }),
  v.check(
    (listing) =>
      listing.deltas.every(
        (delta) =>
          delta.url === datasetUrl(listing.snapshot, delta.sha256, delta.file),
      ),
    "A directory delta URL must name its target snapshot and digest",
  ),
);
export type DirectoryDeltaListing = v.InferOutput<
  typeof DirectoryDeltaListingSchema
>;

export function directoryDeltaListing(
  manifest: PreparedDatasetManifest,
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
      format: directoryDeltaFormat,
      url: datasetUrl(manifest.snapshot, delta.sha256, delta.file),
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
