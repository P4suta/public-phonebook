const pixelsPerRem = 16;

export const foundation = {
  font: {
    brand: { size: 28, lineHeight: 36, weight: 700 },
    page: { size: 24, lineHeight: 32, weight: 700 },
    facility: { size: 20, lineHeight: 32, weight: 700 },
    section: { size: 20, lineHeight: 28, weight: 700 },
    rowHeading: { size: 16, lineHeight: 24, weight: 700 },
    body: { size: 16, lineHeight: 24, weight: 400 },
    label: { size: 16, lineHeight: 24, weight: 400 },
    meta: { size: 14, lineHeight: 20, weight: 400 },
    action: { size: 14, lineHeight: 20, weight: 700 },
    phone: { size: 24, lineHeight: 32, weight: 700 },
    phoneDetail: { size: 32, lineHeight: 48, weight: 700 },
    brandCompact: { size: 24, lineHeight: 32, weight: 700 },
  },
  control: {
    height: 44,
    searchHeight: 56,
    icon: 18,
    categoryIcon: 16,
    border: 1,
    focus: 3,
    focusOffset: 3,
  },
  layout: { width: 960, gutter: 24, columnsAt: 800 },
} as const;

export type TextRole = keyof typeof foundation.font;

export function rem(value: number): `${number}rem` {
  return `${value / pixelsPerRem}rem`;
}
