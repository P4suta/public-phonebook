import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  foundation,
  scale,
  type TextRole,
  viewport,
} from "../../src/ui/foundations.ts";

const styleDirectory = "src/ui";
const requiredStyleSheets = ["styles.css.ts", "api-reference.css.ts"];

const approved = {
  font: {
    brand: { size: 28, lineHeight: 44, weight: 700 },
    page: { size: 24, lineHeight: 36, weight: 700 },
    facility: { size: 20, lineHeight: 32, weight: 700 },
    section: { size: 20, lineHeight: 32, weight: 700 },
    rowHeading: { size: 16, lineHeight: 24, weight: 700 },
    body: { size: 16, lineHeight: 24, weight: 400 },
    label: { size: 16, lineHeight: 24, weight: 400 },
    meta: { size: 14, lineHeight: 24, weight: 400 },
    action: { size: 14, lineHeight: 24, weight: 700 },
    phone: { size: 24, lineHeight: 36, weight: 700 },
    phoneDetail: { size: 32, lineHeight: 48, weight: 700 },
    brandCompact: { size: 24, lineHeight: 36, weight: 700 },
  },
  space: {
    "4": 4,
    "8": 8,
    "12": 12,
    "16": 16,
    "24": 24,
    "32": 32,
    "48": 48,
    "64": 64,
  },
  control: {
    height: 48,
    searchHeight: 56,
    icon: 18,
    selectIcon: 20,
    categoryIcon: 16,
    border: 1,
    focus: 3,
    focusOffset: 3,
  },
  layout: {
    width: 960,
    gutter: 24,
    columnsAt: 800,
    compactUntil: 600,
    phoneColumn: 360,
    referenceWidth: 1600,
  },
};

const typeSteps: Readonly<Record<TextRole, number | "small">> = {
  brand: 3,
  page: 2,
  facility: 1,
  section: 1,
  rowHeading: 0,
  body: 0,
  label: 0,
  meta: "small",
  action: "small",
  phone: 2,
  phoneDetail: 4,
  brandCompact: 2,
};
const regularText = new Set<TextRole>(["body", "label", "meta"]);
const spaceFractions = {
  "4": 1 / 6,
  "8": 1 / 3,
  "12": 1 / 2,
  "16": 2 / 3,
  "24": 1,
  "32": 4 / 3,
  "48": 2,
  "64": 8 / 3,
} as const;

function lengthLiterals(source: string): readonly string[] {
  const selectorFree = source.replace(/\[[\w-]+[~|^$*]?="[^"]*"\]/g, "[]");
  return [
    ...selectorFree.matchAll(
      /(?<![\w$.#-])-?(?:\d+\.?\d*|\.\d+)\s*(?:px|rem)\b|\}(?:px|rem)\b|\b(?:px|rem)\(\s*-?[\d.]/g,
    ),
  ].map((match) => match[0]);
}

it("derives every type role, spacing step, control size, and breakpoint from the scale parameters", () => {
  const { grid, bodySize } = scale;
  const ceilToGrid = (value: number): number => Math.ceil(value / grid) * grid;
  const roles = Object.keys(typeSteps).filter(
    (role): role is TextRole => role in foundation.font,
  );
  expect(roles.sort()).toEqual(Object.keys(foundation.font).sort());
  for (const role of roles) {
    const step = typeSteps[role];
    const size =
      step === "small" ? bodySize - grid / 2 : bodySize + grid * step;
    expect(foundation.font[role], role).toEqual({
      size,
      lineHeight: ceilToGrid(size * scale.lineRatio),
      weight: regularText.has(role) ? scale.weight.regular : scale.weight.bold,
    });
    expect(foundation.font[role].lineHeight % grid, role).toBe(0);
  }
  const line = foundation.font.body.lineHeight;
  for (const [key, fraction] of Object.entries(spaceFractions)) {
    expect(foundation.space, key).toHaveProperty([key], line * fraction);
    expect(Number(key), key).toBe(line * fraction);
    expect((line * fraction) % grid, key).toBe(0);
  }
  expect(Object.keys(foundation.space).sort()).toEqual(
    Object.keys(spaceFractions).sort(),
  );
  const { font, space } = foundation;
  expect(foundation.control).toEqual({
    height: font.action.lineHeight + 2 * space["12"],
    searchHeight: font.label.lineHeight + 2 * space["16"],
    icon: font.action.size + grid,
    selectIcon: font.label.size + grid,
    categoryIcon: font.body.size,
    border: scale.border,
    focus: scale.focusBorders * scale.border,
    focusOffset: scale.focusBorders * scale.border,
  });
  expect(foundation.layout).toEqual({
    width: scale.characters.content * bodySize,
    gutter: line,
    columnsAt: scale.characters.columns * bodySize,
    compactUntil: scale.lines.compact * line,
    phoneColumn: scale.lines.phoneColumn * line,
    referenceWidth: scale.characters.reference * bodySize,
  });
  expect(viewport).toEqual({
    compact: `(max-width: ${foundation.layout.compactUntil}px)`,
    columns: `(min-width: ${foundation.layout.columnsAt}px)`,
  });
  expect(foundation).toEqual(approved);
});

it("rejects hand-typed pixel and rem lengths in the style sheets", async () => {
  for (const planted of [
    'padding: "12px"',
    "rem(88)",
    "(max-width: 600px)",
    'margin: "0 0 1.5rem"',
    'outlineOffset: "-1px"',
    "`${value}px`",
    "px(360)",
  ])
    expect(lengthLiterals(planted), planted).not.toEqual([]);
  for (const derived of [
    '[class~="border-[1px]"]',
    'tokens.space["12"]',
    'textUnderlineOffset: "0.18em"',
    "calc(-1 * ${tokens.control.border})",
    "px(foundation.layout.phoneColumn)",
    '"#000"',
  ])
    expect(lengthLiterals(derived), derived).toEqual([]);
  const sheets = (await readdir(styleDirectory)).filter((name) =>
    name.endsWith(".css.ts"),
  );
  expect(sheets).toEqual(expect.arrayContaining(requiredStyleSheets));
  for (const sheet of sheets)
    expect(
      lengthLiterals(await readFile(join(styleDirectory, sheet), "utf8")),
      sheet,
    ).toEqual([]);
});
