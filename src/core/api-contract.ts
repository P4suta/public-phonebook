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
    contacts: PinnedEndpointSchema,
    contactGroups: PinnedEndpointSchema,
    catalog: PinnedEndpointSchema,
    sources: PinnedEndpointSchema,
    datasets: PinnedEndpointSchema,
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
    }).every(
      ([key, path]) => path === `/api/v1/${key}?snapshot=${value.snapshot}`,
    ),
  ),
);

export type DirectoryDiscovery = v.InferOutput<typeof DirectoryDiscoverySchema>;
