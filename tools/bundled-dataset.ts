import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import {
  readShippedSnapshots,
  type ShippedSnapshots,
  shippedSnapshotsFile,
} from "./collection-store.ts";

/**
 * The national dataset that production and verification builds of the iPhone app bundle.
 * The fixture declaration beside it bundles the provider corpus in development builds alone, so the shipped list never names it.
 */
export const bundledDeclarationFile = "ios/bundled-dataset.json";

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
export const BundledDeclarationSchema = v.strictObject({
  release: v.pipe(v.string(), v.regex(/^[A-Za-z0-9.]+$/u)),
  manifestSha256: DigestSchema,
  snapshot: DigestSchema,
  contacts: CountSchema,
  bytes: CountSchema,
  sha256: DigestSchema,
});
export type BundledDeclaration = v.InferOutput<typeof BundledDeclarationSchema>;

/** Refuses a bundled dataset that the shipped list lacks, because preparation writes deltas only from listed datasets. */
export function requireShippedDeclaration(
  declaration: BundledDeclaration,
  shipped: ShippedSnapshots,
): void {
  const entry = shipped.datasets.find(
    (dataset) => dataset.manifestSha256 === declaration.manifestSha256,
  );
  if (!entry)
    throw new Error(
      `${bundledDeclarationFile} bundles dataset ${declaration.manifestSha256}, which ${shippedSnapshotsFile} lacks`,
    );
  if (entry.snapshot !== declaration.snapshot)
    throw new Error(
      `${bundledDeclarationFile} names snapshot ${declaration.snapshot}, and ${shippedSnapshotsFile} lists ${entry.snapshot} for its dataset`,
    );
}

export async function readBundledDeclaration(
  path: string = bundledDeclarationFile,
): Promise<BundledDeclaration> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  return v.parse(BundledDeclarationSchema, decoded);
}

export async function checkBundledDeclaration(): Promise<void> {
  requireShippedDeclaration(
    await readBundledDeclaration(),
    await readShippedSnapshots(),
  );
}
