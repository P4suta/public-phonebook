import { globalFontFace, globalStyle, style } from "@vanilla-extract/css";

import { foundation, rem } from "./foundations.ts";
import { tokens, typography } from "./theme.css.ts";

const bodyLineHeight = 1.5;
const skipLinkLayer = 10;

globalFontFace("Noto Sans JP", {
  src: 'url("/fonts/noto-sans-jp.woff2") format("woff2")',
  fontWeight: "100 900",
  fontStyle: "normal",
  fontDisplay: "swap",
});
globalStyle("*", { boxSizing: "border-box" });
globalStyle("html", {
  color: tokens.color.ink,
  background: tokens.color.paper,
  fontFamily: '"Noto Sans JP", sans-serif',
  fontSize: "100%",
  lineHeight: bodyLineHeight,
  colorScheme: "light",
});
globalStyle("body", { margin: 0 });
globalStyle("h1, h2, h3, p", { margin: 0 });
globalStyle("h1, h2, h3", { overflowWrap: "anywhere" });
globalStyle("button, input, select", {
  font: "inherit",
  color: tokens.color.ink,
  background: tokens.color.paper,
  borderRadius: 0,
});
globalStyle("button, a, select", { touchAction: "manipulation" });
globalStyle("a", { color: "inherit" });
globalStyle(":focus-visible", {
  outline: `${tokens.control.focus} solid ${tokens.color.ink}`,
  outlineOffset: tokens.control.focusOffset,
});
globalStyle("::selection", {
  color: tokens.color.paper,
  background: tokens.color.ink,
});
globalStyle(".skip-link", {
  position: "absolute",
  left: "24px",
  top: "-100px",
  background: tokens.color.paper,
  border: `1px solid ${tokens.color.ink}`,
  padding: "12px",
  zIndex: skipLinkLayer,
});
globalStyle(".skip-link:focus", { top: "16px" });

export const page = style({
  width: `min(${tokens.layout.width}, calc(100% - 2 * ${tokens.layout.gutter}))`,
  marginInline: "auto",
  minHeight: "100svh",
  paddingBlock: "24px 48px",
});
export const home = style({
  paddingTop: `max(24px, calc(50svh - ${rem(88)}))`,
  "@media": {
    "(max-width: 600px)": { paddingTop: `max(24px, calc(50svh - ${rem(84)}))` },
  },
});
export const stack = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
});
export const brand = style({
  ...typography("brand"),
  textAlign: "center",
  "@media": { "(max-width: 600px)": { ...typography("brandCompact") } },
});
export const heading = style({
  ...typography("page"),
});
export const subheading = style({ ...typography("section") });
export const body = style({
  ...typography("body"),
  overflowWrap: "anywhere",
});
export const informationCopy = style({ whiteSpace: "pre-line" });
export const actions = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: tokens.space["8"],
});
export const homeNavigation = style([actions, { justifyContent: "center" }]);
export const button = style({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: tokens.space["8"],
  minHeight: tokens.control.height,
  padding: `${tokens.space["8"]} ${tokens.space["12"]}`,
  border: `${tokens.control.border} solid ${tokens.color.ink}`,
  color: tokens.color.ink,
  background: tokens.color.paper,
  ...typography("action"),
  textDecoration: "none",
  cursor: "pointer",
  maxWidth: "100%",
  selectors: {
    "&:hover": { color: tokens.color.paper, background: tokens.color.ink },
    "&:active": { textDecoration: "underline" },
    "&:disabled, &[aria-disabled=true]": {
      cursor: "wait",
      borderStyle: "dotted",
      color: tokens.color.ink,
      background: tokens.color.paper,
    },
  },
});
export const solid = style({
  color: tokens.color.paper,
  background: tokens.color.ink,
  selectors: {
    "&:hover": { color: tokens.color.ink, background: tokens.color.paper },
  },
});
export const searchField = style({
  display: "flex",
  alignItems: "center",
  gap: "12px",
  height: tokens.control.searchHeight,
  paddingLeft: "16px",
  border: `1px solid ${tokens.color.ink}`,
  background: tokens.color.paper,
  width: "100%",
});
globalStyle(`${searchField} > svg`, {
  flexShrink: 0,
  "@media": { "(max-width: 360px)": { display: "none" } },
});

export const input = style({
  border: 0,
  outline: 0,
  minWidth: 0,
  width: "100%",
  flex: "1 1 0",
  height: "100%",
  padding: 0,
  ...typography("label"),
  selectors: {
    "&::placeholder": { color: tokens.color.ink, opacity: 1 },
    "&:focus-visible": { outline: 0 },
  },
});
globalStyle(`${searchField}:focus-within`, {
  outline: `${tokens.control.focus} solid ${tokens.color.ink}`,
  outlineOffset: tokens.control.focusOffset,
});
export const searchButton = style([
  button,
  solid,
  {
    alignSelf: "stretch",
    flexShrink: 0,
    border: 0,
    padding: "12px",
    minHeight: 0,
    minWidth: rem(72),
    "@media": {
      "(max-width: 360px)": {
        paddingInline: tokens.space["8"],
        gap: tokens.space["4"],
      },
    },
  },
]);
export const filters = style({
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "12px",
  alignItems: "flex-start",
  selectors: {
    '&[data-has-city="true"]': {
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    },
  },
  "@media": {
    "(max-width: 600px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      selectors: {
        '&[data-has-city="true"]': {
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        },
      },
    },
  },
});
export const filter = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  flex: "1 1 180px",
  minWidth: 0,
  ...typography("meta"),
  "@media": {
    "(max-width: 600px)": {
      selectors: {
        [`${filters}[data-has-city="true"] &:last-child`]: {
          gridColumn: "1 / -1",
        },
      },
    },
  },
});
export const selection = style({
  position: "relative",
  display: "flex",
  alignItems: "center",
});
export const select = style({
  appearance: "none",
  border: `1px solid ${tokens.color.ink}`,
  padding: "8px 40px 8px 12px",
  width: "100%",
  minHeight: tokens.control.height,
  ...typography("label"),
  cursor: "pointer",
  selectors: { "&:disabled": { borderStyle: "dotted", cursor: "not-allowed" } },
});
export const chevron = style({
  position: "absolute",
  right: "12px",
  pointerEvents: "none",
  width: "20px",
  height: "20px",
});
export const toolbar = style([actions, { justifyContent: "space-between" }]);
export const results = style({
  display: "flex",
  flexDirection: "column",
  gap: 0,
  listStyle: "none",
  padding: 0,
  margin: "0",
});
export const resultGroups = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["32"],
  minWidth: 0,
});
export const resultGroup = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
});
export const resultGroupHeading = style({
  display: "flex",
  alignItems: "center",
  gap: tokens.space["8"],
  ...typography("section"),
  overflowWrap: "anywhere",
});
globalStyle(`${resultGroupHeading} > span:first-of-type`, {
  flex: 1,
  minWidth: 0,
});
globalStyle(`${resultGroupHeading} > svg`, {
  width: tokens.control.categoryIcon,
  height: tokens.control.categoryIcon,
  flexShrink: 0,
});
globalStyle(`${resultGroupHeading} > span:last-of-type`, {
  ...typography("meta"),
  flexShrink: 0,
  whiteSpace: "nowrap",
});
export const card = style({
  display: "grid",
  gap: tokens.space["16"],
  minWidth: 0,
  paddingBlock: tokens.space["16"],
  borderBottom: `1px solid ${tokens.color.ink}`,
  "@media": {
    [`(min-width: ${foundation.layout.columnsAt}px)`]: {
      selectors: {
        '&[data-layout="result"]': {
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 360px)",
          columnGap: tokens.space["32"],
        },
      },
    },
  },
});
export const contactHeader = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["4"],
  minWidth: 0,
});
export const contactName = style({
  ...typography("facility"),
  overflowWrap: "anywhere",
});
export const contactNumbers = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["16"],
  minWidth: 0,
  "@media": {
    [`(min-width: ${foundation.layout.columnsAt}px)`]: {
      selectors: {
        [`${card}[data-layout="result"] &`]: {
          gridColumn: "2",
          gridRow: "1 / span 2",
          alignSelf: "stretch",
          paddingTop: tokens.space["24"],
        },
        [`${card}[data-layout="result"][data-grouped="true"] &`]: {
          paddingTop: 0,
        },
      },
    },
  },
});
export const contactLocation = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
  "@media": {
    [`(min-width: ${foundation.layout.columnsAt}px)`]: {
      selectors: {
        [`${card}[data-layout="result"] &`]: {
          gridColumn: "1",
          gridRow: "2",
          alignSelf: "end",
        },
      },
    },
  },
});
export const group = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
});
export const phoneGroup = style([
  group,
  {
    "@media": {
      [`(min-width: ${foundation.layout.columnsAt}px)`]: {
        selectors: {
          [`${card}[data-layout="result"] &`]: {
            flex: 1,
            justifyContent: "space-between",
          },
        },
      },
    },
  },
]);
export const contactLink = style({
  display: "flex",
  alignItems: "center",
  gap: tokens.space["8"],
  minWidth: tokens.control.height,
  minHeight: tokens.control.height,
  color: tokens.color.ink,
  textDecoration: "underline",
  textUnderlineOffset: "0.18em",
  overflowWrap: "anywhere",
});
globalStyle(`${contactLink} > span`, { minWidth: 0, flex: 1 });
globalStyle(`${contactLink} > svg`, {
  width: tokens.control.icon,
  height: tokens.control.icon,
  flexShrink: 0,
});
export const cardFeedback = style({
  gridColumn: "1 / -1",
  ...typography("meta"),
  overflowWrap: "anywhere",
});
export const category = style({
  display: "flex",
  alignItems: "center",
  gap: tokens.space["4"],
  ...typography("meta"),
});
export const telephone = style({
  display: "flex",
  alignItems: "center",
  alignSelf: "flex-start",
  flexWrap: "wrap",
  gap: tokens.space["8"],
  maxWidth: "100%",
  minHeight: tokens.control.height,
  padding: 0,
  border: 0,
  appearance: "none",
  color: tokens.color.ink,
  background: tokens.color.paper,
  cursor: "copy",
  userSelect: "text",
  textAlign: "left",
  ...typography("phone"),
  fontVariantNumeric: "tabular-nums",
  overflowWrap: "anywhere",
  selectors: {
    [`${card}[data-layout="detail"] &`]: { ...typography("phoneDetail") },
    [`${card}[data-layout="result"] &`]: {
      width: "100%",
      justifyContent: "space-between",
    },
    "&:hover:not(:focus-visible)": {
      outline: `1px solid ${tokens.color.ink}`,
      outlineOffset: "-1px",
    },
  },
});
globalStyle(`${telephone} > span:first-child`, {
  minWidth: 0,
  overflowWrap: "anywhere",
});
export const numberCopyHint = style({
  display: "inline-flex",
  alignItems: "center",
  gap: tokens.space["4"],
  flexShrink: 0,
  marginInlineStart: "auto",
  whiteSpace: "nowrap",
  ...typography("action"),
});
globalStyle(`${card}[data-layout="result"] ${phoneGroup} a[href^="tel:"]`, {
  width: "100%",
});
globalStyle(`${numberCopyHint} > svg`, {
  width: tokens.control.icon,
  height: tokens.control.icon,
  flexShrink: 0,
});
export const section = style([stack, { paddingTop: "24px" }]);
export const srOnly = style({
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
});
export const status = style({
  ...typography("meta"),
  overflowWrap: "anywhere",
});
export const code = style({
  border: `1px solid ${tokens.color.ink}`,
  padding: "16px",
  fontFamily: "monospace",
  fontSize: tokens.font.meta.size,
  lineHeight: tokens.font.body.lineHeight,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  maxWidth: "100%",
  margin: 0,
});
export const definition = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: "8px",
  margin: 0,
});
globalStyle(`${definition} dd`, {
  margin: "0 0 16px",
  overflowWrap: "anywhere",
});
globalStyle(`${definition} dt`, {
  fontWeight: foundation.font.rowHeading.weight,
});
export const dataRow = style([
  stack,
  {
    gap: tokens.space["8"],
    paddingBlock: tokens.space["16"],
    borderBottom: `1px solid ${tokens.color.ink}`,
  },
]);
globalStyle(`${dataRow} h3`, { ...typography("rowHeading") });
globalStyle(`${button} > svg`, {
  width: tokens.control.icon,
  height: tokens.control.icon,
  flexShrink: 0,
});
globalStyle(`${category} > svg, ${category} > img`, {
  width: tokens.control.categoryIcon,
  height: tokens.control.categoryIcon,
  flexShrink: 0,
});
