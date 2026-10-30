import { globalFontFace, globalStyle, style } from "@vanilla-extract/css";

import { foundation, px, scale, viewport } from "./foundations.ts";
import { tokens, typography } from "./theme.css.ts";

const skipLinkLayer = 10;
const rule = `${tokens.control.border} solid ${tokens.color.ink}`;

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
  lineHeight: scale.lineRatio,
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
  left: tokens.layout.gutter,
  bottom: "100%",
  background: tokens.color.paper,
  border: rule,
  padding: tokens.space["12"],
  zIndex: skipLinkLayer,
});
globalStyle(".skip-link:focus", { top: tokens.space["16"], bottom: "auto" });

export const page = style({
  width: `min(${tokens.layout.width}, calc(100% - 2 * ${tokens.layout.gutter}))`,
  marginInline: "auto",
  minHeight: "100svh",
  paddingBlock: `${tokens.space["24"]} ${tokens.space["48"]}`,
});
export const home = style({
  display: "flex",
  flexDirection: "column",
  paddingBlock: tokens.layout.gutter,
});
export const stack = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
});
globalStyle(`${home} > ${stack}`, { marginBlock: "auto" });
export const brand = style({
  ...typography("brand"),
  textAlign: "center",
  marginBlockEnd: `calc(${tokens.space["48"]} - ${tokens.space["24"]})`,
  "@media": { [viewport.compact]: { ...typography("brandCompact") } },
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
  border: rule,
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
export const searchGroup = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
});
export const fieldLabel = style({ ...typography("rowHeading") });
export const searchHint = style({
  ...typography("body"),
  whiteSpace: "pre-line",
});
export const searchField = style({
  display: "flex",
  width: "100%",
  "@media": {
    [viewport.compact]: { flexDirection: "column", gap: tokens.space["8"] },
  },
});
export const input = style({
  minWidth: 0,
  width: "100%",
  flex: "1 1 0",
  height: tokens.control.searchHeight,
  paddingInline: tokens.space["16"],
  border: rule,
  borderRadius: 0,
  background: tokens.color.paper,
  ...typography("label"),
  "@media": { [viewport.compact]: { flex: "none" } },
  selectors: {
    "&:focus-visible": {
      outline: `${tokens.control.focus} solid ${tokens.color.ink}`,
      outlineOffset: tokens.control.focusOffset,
    },
  },
});
export const searchButton = style([
  button,
  solid,
  {
    flexShrink: 0,
    height: tokens.control.searchHeight,
    paddingInline: tokens.space["16"],
    "@media": { [viewport.compact]: { width: "100%" } },
  },
]);
export const filters = style({
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: tokens.space["12"],
  alignItems: "flex-start",
  selectors: {
    '&[data-has-city="true"]': {
      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    },
  },
  "@media": {
    [viewport.compact]: {
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
  minWidth: 0,
  "@media": {
    [viewport.compact]: {
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
  border: rule,
  padding: `${tokens.space["8"]} calc(${tokens.space["12"]} + ${tokens.control.selectIcon} + ${tokens.space["8"]}) ${tokens.space["8"]} ${tokens.space["12"]}`,
  width: "100%",
  minHeight: tokens.control.height,
  ...typography("label"),
  cursor: "pointer",
  selectors: { "&:disabled": { borderStyle: "dotted", cursor: "not-allowed" } },
});
export const chevron = style({
  position: "absolute",
  right: tokens.space["12"],
  pointerEvents: "none",
  width: tokens.control.selectIcon,
  height: tokens.control.selectIcon,
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
  borderBottom: rule,
  "@media": {
    [viewport.columns]: {
      selectors: {
        '&[data-layout="result"]': {
          gridTemplateColumns: `minmax(0, 1fr) minmax(0, ${px(foundation.layout.phoneColumn)})`,
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
    [viewport.columns]: {
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
    [viewport.columns]: {
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
      [viewport.columns]: {
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
      outline: rule,
      outlineOffset: `calc(-1 * ${tokens.control.border})`,
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
export const section = style([stack, { paddingTop: tokens.space["24"] }]);
export const srOnly = style({
  position: "absolute",
  width: tokens.control.border,
  height: tokens.control.border,
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
  border: rule,
  padding: tokens.space["16"],
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
  gap: tokens.space["8"],
  margin: 0,
});
globalStyle(`${definition} dd`, {
  margin: `0 0 ${tokens.space["16"]}`,
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
    borderBottom: rule,
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
