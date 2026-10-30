import {
  createGlobalTheme,
  createGlobalThemeContract,
} from "@vanilla-extract/css";
import { foundation, px, rem, type TextRole } from "./foundations.ts";

const { control, layout, space } = foundation;

const primitiveSizes = [
  ...new Set([
    ...Object.values(foundation.font).flatMap((role) => [
      role.size,
      role.lineHeight,
    ]),
    ...Object.values(space),
    ...Object.values(control),
    layout.width,
    layout.gutter,
  ]),
].sort((left, right) => left - right);

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
        px(value),
      ]),
    ),
  },
  color: {
    ink: "var(--dial-primitive-black)",
    paper: "var(--dial-primitive-white)",
  },
  space: {
    "4": px(space["4"]),
    "8": px(space["8"]),
    "12": px(space["12"]),
    "16": px(space["16"]),
    "24": px(space["24"]),
    "32": px(space["32"]),
    "48": px(space["48"]),
    "64": px(space["64"]),
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
    height: rem(control.height),
    searchHeight: rem(control.searchHeight),
    icon: rem(control.icon),
    selectIcon: rem(control.selectIcon),
    categoryIcon: rem(control.categoryIcon),
    border: px(control.border),
    focus: px(control.focus),
    focusOffset: px(control.focusOffset),
  },
  layout: { width: px(layout.width), gutter: px(layout.gutter) },
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
