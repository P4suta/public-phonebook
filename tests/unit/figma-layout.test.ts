import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { expect, it } from "vitest";

const finite = v.pipe(v.number(), v.finite());
const dimension = v.pipe(finite, v.minValue(0.01));
const count = v.pipe(finite, v.integer(), v.minValue(0));
const placement = v.pipe(
  v.tuple([
    v.string(),
    v.string(),
    v.picklist(["SECTION", "FRAME", "INSTANCE", "COMPONENT", "COMPONENT_SET"]),
    finite,
    finite,
    dimension,
    dimension,
    v.picklist(["NONE", "VERTICAL", "HORIZONTAL", "BOTH"]),
    v.nullable(finite),
    v.nullable(finite),
  ]),
  v.transform(
    ([id, parent, kind, x, y, width, height, scroll, left, right]) => ({
      id,
      parent,
      kind,
      x,
      y,
      width,
      height,
      scroll,
      left,
      right,
    }),
  ),
);
const layoutSchema = v.object({
  schema: v.literal(1),
  designFile: v.literal("86k2lR3poqbl2lU6bqQG8V"),
  tupleFields: v.object({
    placement: v.array(v.string()),
    text: v.array(v.string()),
  }),
  pages: v.array(
    v.object({
      id: v.string(),
      observedNodes: count,
      references: v.object({ instances: count, resolved: count }),
      placements: v.array(placement),
      texts: v.array(
        v.tuple([
          v.string(),
          dimension,
          dimension,
          dimension,
          v.picklist([0, 1]),
          v.picklist([0, 1]),
        ]),
      ),
      issues: v.array(v.unknown()),
    }),
  ),
  before: v.array(v.object({ id: v.string(), placements: v.array(placement) })),
});

const originalPages = ["0:1", "14:2", "14:3", "14:4"];
const removedFrames = new Set(["202:1073", "203:594"]);
const textMeasurements = [
  ["14:2", 551],
  ["0:1", 359],
  ["14:3", 22],
  ["14:4", 103],
  ["468:1270", 232],
  ["316:1010", 134],
] as const;
const dialogGutter = 480;
const desktopGutter = 240;
const mobileGutter = 24;
const iphoneViewport = { width: 393, height: 852, gutter: 0 } as const;
const iphoneScreens = new Set([
  "470:1302",
  "470:1361",
  "470:1410",
  "470:1454",
  "470:1490",
  "503:1953",
  "470:1522",
  "470:1749",
  "471:1628",
  "471:1699",
  "471:1728",
  "512:1982",
  "471:1768",
]);

async function readLayout(): Promise<v.InferOutput<typeof layoutSchema>> {
  const raw: unknown = JSON.parse(
    await readFile("docs/figma-layout.json", "utf8"),
  );
  return v.parse(layoutSchema, raw);
}

it("rejects the original canvas overlaps and keeps every retained original artifact in separated sections", async () => {
  const audit = await readLayout();
  expect(audit.pages.map((page) => page.id).sort()).toEqual([
    ...originalPages,
    "316:1010",
    "468:1270",
  ]);
  expect(audit.before.map((page) => page.id).sort()).toEqual(originalPages);
  expect(audit.tupleFields.placement).toEqual([
    "id",
    "parent",
    "kind",
    "x",
    "y",
    "width",
    "height",
    "scroll",
    "leftInset",
    "rightInset",
  ]);
  for (const page of audit.pages) {
    expect(page.observedNodes, page.id).toBeGreaterThan(0);
    expect(page.issues, page.id).toEqual([]);
    expect(page.references.resolved, page.id).toBe(page.references.instances);
    const original = audit.before.find((item) => item.id === page.id);
    const byId = new Map(page.placements.map((node) => [node.id, node]));
    expect(byId.size, page.id).toBe(page.placements.length);
    for (const artifact of original?.placements ?? []) {
      expect(byId.get(artifact.id)?.kind, artifact.id).toBe(
        removedFrames.has(artifact.id) ? undefined : artifact.kind,
      );
    }
    for (const [phase, nodes] of [
      ["before", original?.placements ?? []],
      ["after", page.placements],
    ] as const) {
      const overlaps: string[] = [];
      for (const [index, a] of nodes.entries()) {
        for (const b of nodes.slice(index + 1)) {
          if (a.parent !== b.parent) continue;
          const width =
            Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const height =
            Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (width > 0.5 && height > 0.5) overlaps.push(`${a.id}/${b.id}`);
        }
      }
      expect(overlaps, `${page.id}/${phase}`).toHaveLength(
        phase === "before" && page.id === "14:2" ? 10 : 0,
      );
    }
    for (const node of page.placements) {
      if (node.parent === page.id) {
        expect(node.kind, node.id).toBe("SECTION");
        continue;
      }
      const parent = byId.get(node.parent);
      if (!parent) throw new Error(`Missing section ${node.parent}`);
      expect(parent.kind, node.id).toBe("SECTION");
      expect(node.x, node.id).toBeGreaterThanOrEqual(parent.x - 0.5);
      expect(node.y, node.id).toBeGreaterThanOrEqual(parent.y - 0.5);
      expect(node.x + node.width, node.id).toBeLessThanOrEqual(
        parent.x + parent.width + 0.5,
      );
      expect(node.y + node.height, node.id).toBeLessThanOrEqual(
        parent.y + parent.height + 0.5,
      );
    }
  }
});

it("fits the native Figma text measurements and keeps text distinct from its opaque background", async () => {
  const audit = await readLayout();
  expect(audit.tupleFields.text).toEqual([
    "id",
    "width",
    "height",
    "requiredHeight",
    "foreground",
    "background",
  ]);
  expect(audit.pages.map((page) => [page.id, page.texts.length])).toEqual(
    textMeasurements,
  );
  for (const page of audit.pages) {
    expect(new Set(page.texts.map(([id]) => id)).size, page.id).toBe(
      page.texts.length,
    );
    for (const [
      id,
      ,
      height,
      requiredHeight,
      foreground,
      background,
    ] of page.texts) {
      expect(requiredHeight, id).toBeLessThanOrEqual(height + 0.5);
      expect(foreground, id).not.toBe(background);
    }
  }
});

it("keeps canonical screen viewports, scrolling, and symmetric gutters consistent", async () => {
  const audit = await readLayout();
  const desktop = new Set([
    "197:145",
    "142:2",
    "144:2",
    "146:2",
    "148:2",
    "228:1670",
    "228:1698",
    "228:1726",
    "152:2",
    "311:2238",
    "438:2882",
  ]);
  const mobile = new Set([
    "198:145",
    "141:2",
    "143:2",
    "145:2",
    "147:2",
    "150:2",
    "228:1781",
    "228:1809",
    "151:2",
    "233:1676",
    "438:2901",
  ]);
  const screens = audit.pages
    .flatMap((page) => page.placements)
    .filter(
      (node) =>
        desktop.has(node.id) ||
        mobile.has(node.id) ||
        iphoneScreens.has(node.id),
    );
  expect(screens).toHaveLength(desktop.size + mobile.size + iphoneScreens.size);
  for (const node of screens) {
    if (iphoneScreens.has(node.id)) {
      expect(
        [node.width, node.height, node.left, node.right, node.scroll],
        node.id,
      ).toEqual([
        iphoneViewport.width,
        iphoneViewport.height,
        iphoneViewport.gutter,
        iphoneViewport.gutter,
        "VERTICAL",
      ]);
      continue;
    }
    const compact = node.id === "233:1676";
    const wide = desktop.has(node.id);
    const gutter =
      node.id === "438:2882"
        ? dialogGutter
        : wide
          ? desktopGutter
          : mobileGutter;
    expect(
      [node.width, node.height, node.left, node.right, node.scroll],
      node.id,
    ).toEqual([
      wide ? 1440 : compact ? 320 : 390,
      wide || compact ? 900 : 844,
      gutter,
      gutter,
      "VERTICAL",
    ]);
  }
});
