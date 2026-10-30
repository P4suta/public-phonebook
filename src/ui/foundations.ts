const pixelsPerRem = 16;

export const scale = {
  grid: 4,
  bodySize: 16,
  lineRatio: 1.5,
  weight: { regular: 400, bold: 700 },
  border: 1,
  focusBorders: 3,
  characters: { content: 60, columns: 50, reference: 100 },
  lines: { compact: 25, phoneColumn: 15 },
} as const;

export interface TextStyle {
  readonly size: number;
  readonly lineHeight: number;
  readonly weight: number;
}

function typeStep(step: number): number {
  return scale.bodySize + scale.grid * step;
}

function ceilToGrid(value: number): number {
  return Math.ceil(value / scale.grid) * scale.grid;
}

function text(size: number, weight: number): TextStyle {
  return { size, lineHeight: ceilToGrid(size * scale.lineRatio), weight };
}

const smallSize = scale.bodySize - scale.grid / 2;
const { regular, bold } = scale.weight;

const font = {
  brand: text(typeStep(3), bold),
  page: text(typeStep(2), bold),
  facility: text(typeStep(1), bold),
  section: text(typeStep(1), bold),
  rowHeading: text(typeStep(0), bold),
  body: text(typeStep(0), regular),
  label: text(typeStep(0), regular),
  meta: text(smallSize, regular),
  action: text(smallSize, bold),
  phone: text(typeStep(2), bold),
  phoneDetail: text(typeStep(4), bold),
  brandCompact: text(typeStep(2), bold),
};

const line = font.body.lineHeight;

function lines(numerator: number, denominator = 1): number {
  return (line * numerator) / denominator;
}

const space = {
  "4": lines(1, 6),
  "8": lines(1, 3),
  "12": lines(1, 2),
  "16": lines(2, 3),
  "24": lines(1),
  "32": lines(4, 3),
  "48": lines(2),
  "64": lines(8, 3),
};

const both = 2;

function characters(count: number): number {
  return count * scale.bodySize;
}

export const foundation = {
  font,
  space,
  control: {
    height: font.action.lineHeight + both * space["12"],
    searchHeight: font.label.lineHeight + both * space["16"],
    icon: font.action.size + scale.grid,
    selectIcon: font.label.size + scale.grid,
    categoryIcon: font.body.size,
    border: scale.border,
    focus: scale.focusBorders * scale.border,
    focusOffset: scale.focusBorders * scale.border,
  },
  layout: {
    width: characters(scale.characters.content),
    gutter: line,
    columnsAt: characters(scale.characters.columns),
    compactUntil: lines(scale.lines.compact),
    phoneColumn: lines(scale.lines.phoneColumn),
    referenceWidth: characters(scale.characters.reference),
  },
} as const;

export type TextRole = keyof typeof foundation.font;

export function rem(value: number): `${number}rem` {
  return `${value / pixelsPerRem}rem`;
}

export function px(value: number): `${number}px` {
  return `${value}px`;
}

export const viewport = {
  compact: `(max-width: ${px(foundation.layout.compactUntil)})`,
  columns: `(min-width: ${px(foundation.layout.columnsAt)})`,
} as const;
