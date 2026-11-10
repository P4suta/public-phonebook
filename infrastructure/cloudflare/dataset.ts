import { DigestSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";
import production from "./production-dataset.json" with { type: "json" };

export const ProductionDatasetSchema = v.strictObject({
  manifestSha256: DigestSchema,
  snapshot: DigestSchema,
  databaseSha256: DigestSchema,
  databaseId: v.pipe(v.string(), v.uuid()),
});

export const productionDataset = v.parse(ProductionDatasetSchema, production);
