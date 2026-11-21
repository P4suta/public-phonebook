import { readFile, writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
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
// Component set and variable keys published in Apple's iOS and iPadOS 27 library.
const appleComponents = {
  "_Buttons - 44pt": "0935d395b618d67b2f18032801e06c770dd4e891",
  "Liquid Glass - Regular - Small": "2ce2a0ecbf38d9ce2bfe50c3bf99cc28eb52d7b3",
  "_Button - Symbol": "121089384484c79cbbcbd8ce083b3c4b000c954f",
  "_Back Bar Button Item": "a5a40890112a1e94e671587fb5714db7f80d3d89",
  "Progress Bar - Determinate Linear":
    "2c3f3d32fb7b45c3b5c9c457cb91f44a5cb36f1c",
  "Sidebar Search Field": "36f66ff9efa4a6b7fe73789336378af7a8a9171a",
  "Text Field": "38117a30dd18e50d4c086b01121258a32567f920",
  Header: "bd20115b7590fd2829c6a16b6cc2c64555026517",
  Row: "da6c778eb113a68c7fd6f3828741ab33c3ec8f12",
  "Button - Content Area": "bba76d7e88d66c8704a07953ccc6056a185022b0",
  Alert: "f4cc12bab154ac2830f85336b02b62532f4fd980",
  "Menu Items": "ba927927265b8b66fcc587dbd5a4074117ae9159",
  Menu: "05a77c017ecd555207ab56a1cf529b6cc0b7b54d",
  "Status Bar - iPhone": "5dee83f81147a0100c0e9733155b809913c9cd38",
  "Sheet - iPhone": "b638240e95811750ac62526a67cc8e1d81a2c820",
  "Toolbar - Top - iPhone": "5a5c7f4643552b05f680c5ee9b1c085a942881cc",
};
const applePaints = {
  "Labels/Primary": "variable:f53b56d4ed0520da1fb2c8586d67d82113ae1dcb",
  "Labels/Secondary": "variable:4cd5aad6cbe2b035a0865fe9661e1e5458ab8f8c",
  "Backgrounds – Grouped/Primary":
    "variable:a90ed703166e4696edc327f717296a29491d2124",
  "Backgrounds/Primary": "variable:0c1a82745bdff17e14d0d78142c756a4d97a74eb",
  "Backgrounds – Grouped/Secondary":
    "variable:8b0a221303d2f2bb0871eddd4274517a90e17762",
  "Separators/Non-opaque": "variable:2ed3eb6b8b90d811c2605945c6edfa2f829cf405",
};

export const NativeAppearanceSchema = v.strictObject({
  id: v.string(),
  components: v.pipe(
    v.array(v.picklist(Object.values(appleComponents))),
    v.nonEmpty(),
  ),
  paints: v.array(v.picklist(Object.values(applePaints))),
  toolbarOverrides: v.pipe(v.array(v.string()), v.empty()),
});
export const TextTone = v.picklist([0, 1, "system"]);

const TextSchema = v.tuple([
  v.string(),
  v.number(),
  v.number(),
  v.number(),
  TextTone,
  TextTone,
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
  nativeAppearance: v.optional(v.array(NativeAppearanceSchema)),
});
const AuditSchema = v.looseObject({ pages: v.array(PageSchema) });
export const CaptureSchema = v.strictObject({
  page: v.string(),
  observedNodes: v.number(),
  references: ReferencesSchema,
  texts: v.record(v.string(), v.array(TextSchema)),
  singles: v.array(TextSchema),
  nativeAppearance: v.optional(v.array(NativeAppearanceSchema)),
  placements: v.array(PlacementSchema),
  scope: v.optional(v.picklist(["subtrees", "page"]), "subtrees"),
});

export type AuditPage = v.InferOutput<typeof PageSchema>;
export type Capture = v.InferInput<typeof CaptureSchema>;

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
  if (capture.scope === "page")
    return {
      ...page,
      observedNodes: capture.observedNodes,
      references: capture.references,
      placements: capture.placements,
      texts: capture.singles,
      nativeAppearance: capture.nativeAppearance,
    };
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
  const appearance = new Map(
    page.nativeAppearance?.map((entry) => [entry.id, entry]),
  );
  for (const entry of capture.nativeAppearance ?? [])
    appearance.set(entry.id, entry);
  return {
    ...page,
    nativeAppearance: appearance.size ? [...appearance.values()] : undefined,
    observedNodes: capture.observedNodes,
    references: capture.references,
    placements: replaceById(page.placements, capture.placements),
    texts: replaceById(texts, capture.singles),
  };
}

export function nativeInspection(ids: string[]): string {
  if (!ids.length || ids.some((id) => !/^\d+:\d+$/u.test(id)))
    throw new Error("Select one or more Figma screen or component IDs");
  return `
const library = new Set(${JSON.stringify(Object.values(appleComponents))});
const toolbar = ${JSON.stringify(appleComponents["Toolbar - Top - iPhone"])};
const variables = new Map();
const appearanceFields = new Set(["fills", "strokes", "effects", "opacity", "blendMode", "fillStyleId", "effectStyleId"]);
async function inspect(root) {
  const components = new Set(), paints = new Set(), toolbarOverrides = new Set(), overridden = new Map();
  async function readPaints(node, fields) {
    const changed = field => !fields || fields.has(field);
    for (const field of ["fills", "strokes"]) {
      if (!changed(field) || !Array.isArray(node[field])) continue;
      for (const paint of node[field]) {
        if (paint.visible === false) continue;
        if ((paint.blendMode ?? "NORMAL") !== "NORMAL") paints.add("blend:" + node.id + "/" + field);
        const id = paint.boundVariables?.color?.id;
        if (id) {
          if (!variables.has(id)) variables.set(id, await figma.variables.getVariableByIdAsync(id));
          const variable = variables.get(id);
          const color = variable?.resolveForConsumer(node).value;
          if ((paint.opacity ?? 1) !== (color?.a ?? 1)) paints.add("opacity:" + node.id + "/" + field);
          paints.add("variable:" + variable?.key);
        } else if (paint.type === "SOLID") {
          const rgba = [paint.color.r, paint.color.g, paint.color.b, paint.opacity ?? 1];
          paints.add("#" + rgba.map(value => Math.round(value * 255).toString(16).padStart(2, "0")).join(""));
        } else paints.add("paint:" + paint.type);
      }
    }
    if (changed("effects") && node.effects?.some(effect => effect.visible !== false)) paints.add("effect:" + node.id);
    if (changed("opacity") && node.opacity !== undefined && node.opacity !== 1) paints.add("opacity:" + node.id);
    if (changed("blendMode") && node.blendMode && !["PASS_THROUGH", "NORMAL"].includes(node.blendMode)) paints.add("blend:" + node.id);
  }
  async function visit(node, inherited) {
    if (node.visible === false) return;
    if (node.type === "INSTANCE") {
      const master = await node.getMainComponentAsync();
      if (!master) throw new Error("Missing component " + node.id);
      const key = master.parent?.type === "COMPONENT_SET" ? master.parent.key : master.key;
      if (!master.remote) inherited = false;
      if (master.remote && (!inherited || library.has(key))) {
        components.add(key);
        inherited = library.has(key);
        for (const item of node.overrides) {
          if (!item.overriddenFields.some(field => appearanceFields.has(field))) continue;
          const fields = overridden.get(item.id) ?? new Set();
          for (const field of item.overriddenFields) fields.add(field);
          if (fields.has("fillStyleId")) fields.add("fills");
          if (fields.has("effectStyleId")) fields.add("effects");
          overridden.set(item.id, fields);
          const target = await figma.getNodeByIdAsync(item.id);
          if (key === toolbar && target?.type !== "TEXT") toolbarOverrides.add(item.id);
        }
      }
    }
    if (!inherited || overridden.has(node.id)) await readPaints(node, inherited ? overridden.get(node.id) : null);
    for (const child of node.children ?? []) await visit(child, inherited && node.type !== "SLOT");
  }
  await visit(root, false);
  return {id: root.id, components: [...components].sort(), paints: [...paints].sort(), toolbarOverrides: [...toolbarOverrides].sort()};
}
const results = [];
for (const id of ${JSON.stringify(ids)}) {
  const root = await figma.getNodeByIdAsync(id);
  if (!root) throw new Error("Missing Figma node " + id);
  results.push(await inspect(root));
}
return results;`;
}

function readCapture(capturePath: string): Promise<string> {
  return capturePath === "-"
    ? text(process.stdin)
    : readFile(capturePath, "utf8");
}

async function merge(capturePath: string): Promise<void> {
  const capture = v.parse(
    CaptureSchema,
    JSON.parse(await readCapture(capturePath)),
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
  const [command, ...args] = process.argv.slice(commandArgumentOffset);
  if (command === "inspect-native") console.info(nativeInspection(args));
  else if (command === "merge" && args.length === 1 && args[0])
    await merge(args[0]);
  else
    throw new Error(
      "Usage: figma-audit inspect-native NODE_ID... | merge CAPTURE_JSON|-",
    );
}
