import * as v from "valibot";
import { DigestSchema } from "./models.ts";

const PinnedEndpointSchema = v.pipe(
  v.string(),
  v.regex(/^\/api\/v1\/[a-z-]+\?snapshot=[a-f0-9]{64}$/),
);

export const DirectoryDiscoverySchema = v.pipe(
  v.strictObject({
    name: v.literal("Public Phonebook API"),
    version: v.literal("1"),
    snapshot: DigestSchema,
    generatedAt: v.string(),
    datasets: PinnedEndpointSchema,
    datasetDeltas: PinnedEndpointSchema,
  }),
  v.check((value) =>
    Object.entries({
      datasets: value.datasets,
      "dataset-deltas": value.datasetDeltas,
    }).every(
      ([key, path]) => path === `/api/v1/${key}?snapshot=${value.snapshot}`,
    ),
  ),
);

export type DirectoryDiscovery = v.InferOutput<typeof DirectoryDiscoverySchema>;
