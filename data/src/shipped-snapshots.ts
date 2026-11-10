import { readFile } from "node:fs/promises";
import { maximumShippedDeltaBases } from "@public-phonebook/directory/dataset-storage";
import { DigestSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";

export const shippedSnapshotsFile = "data/sources/shipped-snapshots.json";

const AppVersionSchema = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,2}$/u),
);
export const ShippedSnapshotsSchema = v.pipe(
  v.strictObject({
    datasets: v.pipe(
      v.array(
        v.strictObject({
          manifestSha256: DigestSchema,
          snapshot: DigestSchema,
          firstAppVersion: AppVersionSchema,
        }),
      ),
      v.maxLength(maximumShippedDeltaBases),
    ),
  }),
  v.check(
    (list) =>
      new Set(list.datasets.map((dataset) => dataset.manifestSha256)).size ===
      list.datasets.length,
    "A shipped dataset must appear once",
  ),
  v.check(
    (list) =>
      new Set(list.datasets.map((dataset) => dataset.snapshot)).size ===
      list.datasets.length,
    "A shipped snapshot must appear once",
  ),
);
export type ShippedSnapshots = v.InferOutput<typeof ShippedSnapshotsSchema>;

export async function readShippedSnapshots(
  path: string = shippedSnapshotsFile,
): Promise<ShippedSnapshots> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  return v.parse(ShippedSnapshotsSchema, decoded);
}
