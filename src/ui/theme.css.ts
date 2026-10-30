import {
  createGlobalTheme,
  createGlobalThemeContract,
} from "@vanilla-extract/css";
import { foundation, rem, type TextRole } from "./foundations.ts";

const primitiveSizes = [
  1, 3, 4, 8, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 960,
] as const;

function font(role: TextRole): { size: string; lineHeight: string } {
  return {
    size: rem(foundation.font[role].size),
    lineHeight: rem(foundation.font[role].lineHeight),
  };
}

const values = {
  primitive: {
    black: "#000000",
    white: "#ffffff",
    size: Object.fromEntries(
      primitiveSizes.map((value): [string, string] => [
        String(value),
        `${value}px`,
      ]),
    ),
  },
  color: {
    ink: "var(--dial-primitive-black)",
    paper: "var(--dial-primitive-white)",
  },
  space: {
    "4": "4px",
    "8": "8px",
    "12": "12px",
    "16": "16px",
    "24": "24px",
    "32": "32px",
    "48": "48px",
    "64": "64px",
  },
  font: {
    brand: font("brand"),
    page: font("page"),
    facility: font("facility"),
    section: font("section"),
    rowHeading: font("rowHeading"),
    body: font("body"),
    label: font("label"),
    meta: font("meta"),
    action: font("action"),
    phone: font("phone"),
    phoneDetail: font("phoneDetail"),
    brandCompact: font("brandCompact"),
  },
  control: {
    height: rem(foundation.control.height),
    searchHeight: rem(foundation.control.searchHeight),
    icon: rem(foundation.control.icon),
    categoryIcon: rem(foundation.control.categoryIcon),
    border: "1px",
    focus: "3px",
    focusOffset: "3px",
  },
  layout: { width: "960px", gutter: "24px" },
};

export const tokens = createGlobalThemeContract(
  values,
  (_value, path) =>
    `dial-${path.map((key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)).join("-")}`,
);
createGlobalTheme(":root", tokens, values);

export function typography(role: TextRole): {
  fontSize: string;
  lineHeight: string;
  fontWeight: number;
} {
  return {
    fontSize: tokens.font[role].size,
    lineHeight: tokens.font[role].lineHeight,
    fontWeight: foundation.font[role].weight,
  };
}
