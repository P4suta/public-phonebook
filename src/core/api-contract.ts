import * as v from "valibot";
import { DigestSchema } from "./models.ts";

const PinnedEndpointSchema = v.pipe(
  v.string(),
  v.regex(/^\/api\/v1\/[a-z-]+\?snapshot=[a-f0-9]{64}$/),
);

export const UnversionedDiscoverySchema = v.strictObject({
  name: v.literal("Public Phonebook API"),
  contacts: v.literal("/api/contacts"),
  contactGroups: v.literal("/api/contact-groups"),
  catalog: v.literal("/api/catalog"),
  sources: v.literal("/api/sources"),
  datasets: v.literal("/api/datasets"),
  datasetDeltas: v.literal("/api/dataset-deltas"),
  openapi: v.literal("/api/openapi.json"),
  docs: v.literal("/developers"),
});

export type UnversionedDiscovery = v.InferOutput<
  typeof UnversionedDiscoverySchema
>;

export const DirectoryDiscoverySchema = v.pipe(
  v.strictObject({
    name: v.literal("Public Phonebook API"),
    version: v.literal("1"),
    snapshot: DigestSchema,
    generatedAt: v.string(),
    contacts: PinnedEndpointSchema,
    contactGroups: PinnedEndpointSchema,
    catalog: PinnedEndpointSchema,
    sources: PinnedEndpointSchema,
    datasets: PinnedEndpointSchema,
    datasetDeltas: PinnedEndpointSchema,
    openapi: v.literal("/api/v1/openapi.json"),
    docs: v.literal("/developers"),
  }),
  v.check((value) =>
    Object.entries({
      contacts: value.contacts,
      "contact-groups": value.contactGroups,
      catalog: value.catalog,
      sources: value.sources,
      datasets: value.datasets,
      "dataset-deltas": value.datasetDeltas,
    }).every(
      ([key, path]) => path === `/api/v1/${key}?snapshot=${value.snapshot}`,
    ),
  ),
);

export type DirectoryDiscovery = v.InferOutput<typeof DirectoryDiscoverySchema>;
