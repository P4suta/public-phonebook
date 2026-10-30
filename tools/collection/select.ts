import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { CollectionManifestSchema } from "./models.ts";

const jsonIndentation = 2;
const PlanResultSchema = v.object({
  plan: v.string(),
  contacts: v.number(),
  rows: v.number(),
  missingPhone: v.number(),
  invalid: v.number(),
});

export async function selectCollectedSources(input: {
  manifest: string;
  report: string;
  output: string;
  acceptedOnly: boolean;
}): Promise<void> {
  const manifestValue: unknown = JSON.parse(
    await readFile(input.manifest, "utf8"),
  );
  const manifest = v.parse(CollectionManifestSchema, manifestValue);
  const reportValue: unknown = JSON.parse(await readFile(input.report, "utf8"));
  const report = v.parse(
    v.object({ plans: v.array(PlanResultSchema) }),
    reportValue,
  );
  const counts = new Map<string, number>();
  for (const plan of report.plans)
    if (
      input.acceptedOnly
        ? plan.contacts > 0
        : plan.rows > plan.missingPhone + plan.invalid
    )
      counts.set(plan.plan, (counts.get(plan.plan) ?? 0) + plan.contacts);
  const sources = manifest.sources
    .filter((source) => counts.has(source.id))
    .map((source) => ({
      ...source,
      ...(input.acceptedOnly
        ? { minimumContacts: counts.get(source.id) ?? 1 }
        : {}),
      ...(source.id.startsWith("odm:")
        ? { category: "public_facility" as const }
        : {}),
    }));
  if (!sources.length) throw new Error("No usable collection source selected");
  await writeFile(
    input.output,
    JSON.stringify(
      v.parse(CollectionManifestSchema, { ...manifest, sources }),
      null,
      jsonIndentation,
    ) + "\n",
  );
  console.info(
    JSON.stringify({ phase: "collection.selected", sources: sources.length }),
  );
}
