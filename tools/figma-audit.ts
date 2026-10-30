import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";

const auditPath = "docs/figma-layout.json";
const commandArgumentOffset = 2;
const jsonIndentation = 2;

const PlacementSchema = v.tuple([
  v.string(),
  v.string(),
  v.picklist(["SECTION", "FRAME", "INSTANCE", "COMPONENT", "COMPONENT_SET"]),
  v.number(),
  v.number(),
  v.number(),
  v.number(),
  v.string(),
  v.nullable(v.number()),
  v.nullable(v.number()),
]);
const TextSchema = v.tuple([
  v.string(),
  v.number(),
  v.number(),
  v.number(),
  v.picklist([0, 1]),
  v.picklist([0, 1]),
]);
const ReferencesSchema = v.object({
  instances: v.number(),
  resolved: v.number(),
});
const PageSchema = v.looseObject({
  id: v.string(),
  observedNodes: v.number(),
  references: ReferencesSchema,
  placements: v.array(PlacementSchema),
  texts: v.array(TextSchema),
});
const AuditSchema = v.looseObject({ pages: v.array(PageSchema) });
export const CaptureSchema = v.strictObject({
  page: v.string(),
  observedNodes: v.number(),
  references: ReferencesSchema,
  texts: v.record(v.string(), v.array(TextSchema)),
  singles: v.array(TextSchema),
  placements: v.array(PlacementSchema),
});

export type AuditPage = v.InferOutput<typeof PageSchema>;
export type Capture = v.InferOutput<typeof CaptureSchema>;

function replaceById<T extends readonly [string, ...unknown[]]>(
  entries: readonly T[],
  updates: readonly T[],
): T[] {
  const byId = new Map(updates.map((entry) => [entry[0], entry]));
  const present = new Set(entries.map((entry) => entry[0]));
  return [
    ...entries.map((entry) => byId.get(entry[0]) ?? entry),
    ...updates.filter((entry) => !present.has(entry[0])),
  ];
}

export function mergeCapture(page: AuditPage, capture: Capture): AuditPage {
  let texts = page.texts;
  for (const [root, captured] of Object.entries(capture.texts)) {
    const capturedIds = new Set(captured.map((entry) => entry[0]));
    texts = [
      ...texts.filter(
        (entry) =>
          !entry[0].startsWith(`I${root};`) && !capturedIds.has(entry[0]),
      ),
      ...captured,
    ];
  }
  return {
    ...page,
    observedNodes: capture.observedNodes,
    references: capture.references,
    placements: replaceById(page.placements, capture.placements),
    texts: replaceById(texts, capture.singles),
  };
}

async function merge(capturePath: string): Promise<void> {
  const capture = v.parse(
    CaptureSchema,
    JSON.parse(await readFile(capturePath, "utf8")),
  );
  const source: unknown = JSON.parse(await readFile(auditPath, "utf8"));
  const audit = v.parse(AuditSchema, source);
  if (
    !v.is(
      v.looseObject({ pages: v.array(v.looseObject({ id: v.string() })) }),
      source,
    )
  )
    throw new Error("The audit has no pages");
  const index = audit.pages.findIndex((page) => page.id === capture.page);
  const page = audit.pages[index];
  const sourcePage = source.pages[index];
  if (!page || !sourcePage)
    throw new Error(`The audit has no page ${capture.page}`);
  const updated = {
    ...source,
    pages: source.pages.map((entry, position) =>
      position === index
        ? { ...sourcePage, ...mergeCapture(page, capture) }
        : entry,
    ),
  };
  await writeFile(
    auditPath,
    `${JSON.stringify(updated, null, jsonIndentation)}\n`,
  );
  console.info(
    JSON.stringify({ operation: "figma.audit.merge", page: capture.page }),
  );
}

if (import.meta.main) {
  const [command, capturePath] = process.argv.slice(commandArgumentOffset);
  if (command !== "merge" || !capturePath)
    throw new Error("Usage: figma-audit merge CAPTURE_JSON");
  await merge(capturePath);
}
