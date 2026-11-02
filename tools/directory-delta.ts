import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import * as v from "valibot";
import {
  type DirectoryDeltaArtifact,
  maximumDirectoryDeltas,
  PreparedDatasetManifestSchema,
} from "../src/core/dataset-storage.ts";
import { directoryArchiveFile } from "../src/core/directory-archive.ts";
import {
  applyDirectoryDelta,
  type DeltaDigest,
  type DirectoryText,
  directoryDeltaFile,
  encodeDirectoryDelta,
  readDirectoryText,
} from "../src/core/directory-delta.ts";
import { deltaPublication } from "../src/core/directory-delta-policy.ts";

// Over ten times the 80 MB decoded national archive, so a corrupt base can't exhaust memory.
const maximumDecodedArchiveBytes = 1_073_741_824;

export function sha256Digest(): DeltaDigest {
  const hash = createHash("sha256");
  return {
    update: (bytes): void => {
      hash.update(bytes);
    },
    digest: (): string => hash.digest("hex"),
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new Error(`The ${label} isn't UTF-8`, { cause: error });
  }
}

export function requireDirectoryText(text: string): DirectoryText {
  const parsed = readDirectoryText(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** One published archive with the decoded text a delta starts from or reproduces. */
export interface DeltaArchive {
  readonly snapshot: string;
  readonly archiveSha256: string;
  readonly archiveBytes: number;
  readonly text: string;
}

/** Reads a prepared bundle's archive after checking it against the bundle's ready manifest. */
export async function readDeltaBase(bundle: string): Promise<DeltaArchive> {
  const manifest = v.parse(
    PreparedDatasetManifestSchema,
    JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
  );
  const listed = manifest.files.find(
    (file) => file.file === directoryArchiveFile,
  );
  const bytes = await readFile(join(bundle, directoryArchiveFile));
  if (
    !listed ||
    bytes.byteLength !== listed.bytes ||
    sha256Hex(bytes) !== listed.sha256
  )
    throw new Error(
      `A delta base archive differs from its manifest: ${bundle}`,
    );
  let decoded: Uint8Array;
  try {
    decoded = brotliDecompressSync(bytes, {
      maxOutputLength: maximumDecodedArchiveBytes,
    });
  } catch (error) {
    throw new Error(`A delta base archive can't be decoded: ${bundle}`, {
      cause: error,
    });
  }
  const text = decodeUtf8(decoded, "delta base archive");
  if (requireDirectoryText(text).header.snapshot !== manifest.snapshot)
    throw new Error(`A delta base archive names another snapshot: ${bundle}`);
  return {
    snapshot: manifest.snapshot,
    archiveSha256: listed.sha256,
    archiveBytes: listed.bytes,
    text,
  };
}

function identity(archive: DeltaArchive): {
  readonly archiveSha256: string;
  readonly sha256: string;
  readonly bytes: number;
} {
  const bytes = new TextEncoder().encode(archive.text);
  return {
    archiveSha256: archive.archiveSha256,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
}

/**
 * Writes a delta from each base that is at most half the complete archive, after applying it to its base and requiring the exact target text.
 */
export async function writeDirectoryDeltas(
  destination: string,
  target: DeltaArchive,
  bases: readonly DeltaArchive[],
  compress: (text: string) => Uint8Array,
): Promise<readonly DirectoryDeltaArtifact[]> {
  const snapshots = new Set(bases.map((base) => base.snapshot));
  if (bases.length > maximumDirectoryDeltas)
    throw new Error(
      `At most ${maximumDirectoryDeltas} delta bases are allowed`,
    );
  if (snapshots.size !== bases.length || snapshots.has(target.snapshot))
    throw new Error("Delta bases must be distinct earlier snapshots");
  const targetText = requireDirectoryText(target.text);
  const targetIdentity = identity(target);
  const artifacts: DirectoryDeltaArtifact[] = [];
  for (const base of bases.toSorted((left, right) =>
    left.snapshot < right.snapshot ? -1 : 1,
  )) {
    const text = encodeDirectoryDelta(
      requireDirectoryText(base.text),
      targetText,
      { base: identity(base), target: targetIdentity },
    );
    const compressed = compress(text);
    const published = deltaPublication(
      compressed.byteLength,
      target.archiveBytes,
    );
    console.info(
      JSON.stringify({
        phase: "directory-delta",
        base: base.snapshot,
        bytes: compressed.byteLength,
        completeBytes: target.archiveBytes,
        published,
      }),
    );
    if (!published) continue;
    const decoded = decodeUtf8(
      brotliDecompressSync(compressed),
      "directory delta",
    );
    const applied = applyDirectoryDelta(base.text, decoded, sha256Digest);
    if (applied.admission !== "apply" || applied.text !== target.text)
      throw new Error(
        `The delta from ${base.snapshot} didn't reproduce its target: ${applied.admission}`,
      );
    const file = directoryDeltaFile(base.snapshot);
    await writeFile(join(destination, file), compressed, { flag: "wx" });
    const textBytes = new TextEncoder().encode(decoded);
    artifacts.push({
      file,
      base: base.snapshot,
      baseArchiveSha256: base.archiveSha256,
      sha256: sha256Hex(compressed),
      bytes: compressed.byteLength,
      uncompressedSha256: sha256Hex(textBytes),
      uncompressedBytes: textBytes.byteLength,
    });
  }
  return artifacts;
}
