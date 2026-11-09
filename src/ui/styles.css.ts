import { globalStyle, style } from "@vanilla-extract/css";

import { indexProgressSteps } from "../core/local-search-protocol.ts";
import { foundation, px, scale, viewport } from "./foundations.ts";
import { tokens, typography } from "./theme.css.ts";

const skipLinkLayer = 10;
const fullPercent = 100;
const rule = `${tokens.control.border} solid ${tokens.color.ink}`;

globalStyle("*", { boxSizing: "border-box" });
globalStyle("html", {
  color: tokens.color.ink,
  background: tokens.color.paper,
  fontFamily: "sans-serif",
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
  paddingBlockEnd: tokens.space["24"],
});
export const stack = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
});
export const searchLayout = style({
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  selectors: {
    [`${home} > &`]: {
      flex: "1 1 0",
      minHeight: 0,
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "1fr auto minmax(0, 1fr)",
    },
  },
});
export const searchIntro = style({
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  gap: tokens.space["48"],
  minWidth: 0,
  paddingBlockEnd: tokens.space["8"],
});
export const homeHeading = style({
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: tokens.space["16"],
});
export const searchArea = style({
  minWidth: 0,
  selectors: {
    [`${home} &`]: {
      gridRow: "2",
    },
  },
});
export const searchForm = style({
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  selectors: { [`${home} &`]: { display: "contents" } },
});
export const searchAfter = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
  selectors: {
    [`${home} &`]: {
      alignSelf: "start",
      paddingBlockEnd: tokens.space["24"],
    },
  },
});
globalStyle(`${searchAfter} ~ *`, { marginBlockStart: tokens.space["24"] });
export const brand = style({
  ...typography("brand"),
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
export const searchHint = style({
  ...typography("body"),
  paddingBlockStart: tokens.space["8"],
  overflowWrap: "anywhere",
});
export const informationCopy = style({ whiteSpace: "pre-line" });
export const actions = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: tokens.space["8"],
});
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
export const fieldLabel = style({ ...typography("rowHeading") });
/** Puts the search action beside the field on wide screens and below it on narrow screens. */
export const searchField = style({
  display: "flex",
  alignItems: "center",
  gap: tokens.space["8"],
  width: "100%",
  "@media": {
    [viewport.compact]: { flexDirection: "column", alignItems: "flex-start" },
  },
});
/** Holds the field and its loading bar, so the bar spans the field and not the action. */
export const searchInput = style({
  position: "relative",
  display: "flex",
  flex: "1 1 0",
  alignSelf: "stretch",
  minWidth: 0,
});
export const indexProgress = style({
  position: "absolute",
  insetInlineStart: 0,
  insetInlineEnd: 0,
  insetBlockStart: `calc(${tokens.control.searchHeight} - ${tokens.space["4"]})`,
  blockSize: tokens.space["4"],
  pointerEvents: "none",
});
export const indexProgressFill = Array.from(
  { length: indexProgressSteps + 1 },
  (_, step) =>
    style({
      display: "block",
      blockSize: "100%",
      inlineSize: `${(step * fullPercent) / indexProgressSteps}%`,
      background: tokens.color.ink,
    }),
);
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
  selectors: {
    "&:focus-visible": {
      outline: `${tokens.control.focus} solid ${tokens.color.ink}`,
      outlineOffset: tokens.control.focusOffset,
    },
  },
});
export const searchButton = style([button, { flexShrink: 0 }]);
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
/** Puts the category's count right after its label, on the label's baseline. */
export const resultGroupHeading = style({
  display: "flex",
  alignItems: "baseline",
  gap: tokens.space["8"],
  ...typography("section"),
  overflowWrap: "anywhere",
});
globalStyle(`${resultGroupHeading} > span:first-of-type`, { minWidth: 0 });
globalStyle(`${resultGroupHeading} > svg`, {
  alignSelf: "center",
  width: tokens.control.categoryIcon,
  height: tokens.control.categoryIcon,
  flexShrink: 0,
});
globalStyle(`${resultGroupHeading} > span:last-of-type`, {
  ...typography("meta"),
  flexShrink: 0,
  whiteSpace: "nowrap",
});
/**
 * Lays a wide result card out in two columns and three rows: the name beside the number, the region beside the call action, and the detail action below the region.
 * Dense placement fills each column in source order, so the source order stays name, region, number, call, and details for narrow screens and assistive technology.
 */
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
          gridAutoFlow: "row dense",
          alignItems: "center",
          columnGap: tokens.space["32"],
          rowGap: tokens.space["8"],
        },
      },
    },
  },
});
const wideResult = `${card}[data-layout="result"] &`;
const contents = {
  "@media": {
    [viewport.columns]: {
      selectors: { [wideResult]: { display: "contents" } },
    },
  },
} as const;
const resultColumn = (gridColumn: "1" | "2") =>
  ({
    "@media": {
      [viewport.columns]: { selectors: { [wideResult]: { gridColumn } } },
    },
  }) as const;
export const contactHeader = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["4"],
  minWidth: 0,
  ...contents,
});
export const contactName = style({
  ...typography("facility"),
  overflowWrap: "anywhere",
  ...resultColumn("1"),
});
export const region = style({
  ...typography("meta"),
  overflowWrap: "anywhere",
  ...resultColumn("1"),
});
export const contactNumbers = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["16"],
  minWidth: 0,
  ...contents,
});
export const contactLocation = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
});
export const contactAddress = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["4"],
  minWidth: 0,
});
export const addressHeading = style({ ...typography("rowHeading") });
const group = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
});
/** Stacks actions at the telephone column's width, which reaches 360 pixels on wide screens. */
export const actionColumn = style([
  group,
  { width: "100%", maxWidth: px(foundation.layout.phoneColumn), ...contents },
]);
globalStyle(`${card}[data-layout="result"] ${actionColumn} > *`, {
  "@media": { [viewport.columns]: { gridColumn: "2" } },
});
export const phoneGroup = style([group, contents]);
/** Keeps the result's detail action at its label's width below the telephone actions, and below the region on wide screens. */
export const detailAction = style([
  button,
  { justifySelf: "start", ...resultColumn("1") },
]);
export const category = style({
  display: "flex",
  alignItems: "center",
  gap: tokens.space["4"],
  ...typography("meta"),
});
/** Shows a telephone number as plain selectable text in a row as tall as an action. */
export const telephone = style({
  display: "flex",
  alignItems: "center",
  minHeight: tokens.control.height,
  ...typography("phone"),
  fontVariantNumeric: "tabular-nums",
  overflowWrap: "anywhere",
  selectors: {
    [`${card}[data-layout="detail"] &`]: { ...typography("phoneDetail") },
  },
  ...resultColumn("2"),
});
export const section = style([stack, { paddingTop: tokens.space["24"] }]);
export const dialog = style({
  width: `min(calc(${tokens.layout.width} / 2), calc(100% - 2 * ${tokens.layout.gutter}))`,
  maxWidth: "none",
  maxHeight: `calc(100% - 2 * ${tokens.layout.gutter})`,
  padding: tokens.space["24"],
  border: rule,
  color: tokens.color.ink,
  background: tokens.color.paper,
  overflowWrap: "anywhere",
  selectors: {
    "&[open]": {
      display: "flex",
      flexDirection: "column",
      gap: tokens.space["16"],
    },
    "&::backdrop": { background: tokens.color.paper },
  },
});
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
/** Keeps the symbol definitions rendered, so references inside them still resolve, without taking up space. */
export const iconSprite = style({
  position: "absolute",
  width: 0,
  height: 0,
  overflow: "hidden",
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
