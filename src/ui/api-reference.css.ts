import { globalStyle, style } from "@vanilla-extract/css";
import { foundation, px, viewport } from "./foundations.ts";
import { tokens, typography } from "./theme.css.ts";

const rule = `${tokens.control.border} solid ${tokens.color.ink}`;
const codeFont = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const page = style({
  width: `min(${px(foundation.layout.referenceWidth)}, calc(100% - 2 * ${tokens.layout.gutter}))`,
  marginInline: "auto",
  minHeight: "100svh",
  paddingBlock: `${tokens.space["24"]} ${tokens.space["48"]}`,
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
});
globalStyle(`${page} code`, { fontFamily: codeFont, overflowWrap: "anywhere" });
export const header = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
});
export const body = style({ ...typography("body"), overflowWrap: "anywhere" });
export const meta = style({ ...typography("meta"), overflowWrap: "anywhere" });
export const reference = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: tokens.space["32"],
  minWidth: 0,
  "@media": {
    [viewport.columns]: {
      gridTemplateColumns: "minmax(0, 1fr) minmax(0, 3fr)",
      alignItems: "start",
    },
  },
});
export const navigation = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["16"],
  minWidth: 0,
  paddingBlockEnd: tokens.space["24"],
  borderBottom: rule,
  "@media": {
    [viewport.columns]: {
      position: "sticky",
      top: 0,
      maxHeight: "100svh",
      overflowY: "auto",
      padding: tokens.space["8"],
      borderBottom: 0,
    },
  },
});
export const navigationGroup = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["4"],
});
export const navigationLabel = style({ ...typography("rowHeading") });
export const list = style({
  display: "flex",
  flexDirection: "column",
  margin: 0,
  padding: 0,
  listStyle: "none",
});
export const navigationLink = style({
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  minHeight: tokens.control.height,
  paddingBlock: tokens.space["4"],
  color: tokens.color.ink,
  textDecoration: "none",
  overflowWrap: "anywhere",
});
globalStyle(`${navigationLink} > span:first-child`, {
  ...typography("body"),
  textDecoration: "underline",
  textUnderlineOffset: "0.18em",
});
globalStyle(`${navigationLink} > code`, { ...typography("meta") });
export const content = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["48"],
  minWidth: 0,
});
export const group = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
});
export const groupHeading = style({
  ...typography("section"),
  paddingBlockEnd: tokens.space["8"],
  borderBottom: rule,
});
export const operation = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["16"],
  minWidth: 0,
  paddingBlockStart: tokens.space["24"],
  borderTop: rule,
  scrollMarginTop: tokens.space["16"],
  selectors: {
    [`${groupHeading} + &`]: { paddingBlockStart: 0, borderTop: 0 },
  },
});
export const operationHeading = style({
  ...typography("rowHeading"),
  display: "flex",
  flexWrap: "wrap",
  columnGap: tokens.space["8"],
  overflowWrap: "anywhere",
});
export const contract = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
});
export const subheading = style({
  ...typography("action"),
  margin: 0,
  paddingBlockStart: tokens.space["8"],
});
export const table = style({
  width: "100%",
  borderCollapse: "collapse",
  ...typography("body"),
});
globalStyle(`${table} th, ${table} td`, {
  padding: `${tokens.space["8"]} ${tokens.space["8"]} ${tokens.space["8"]} 0`,
  textAlign: "start",
  verticalAlign: "top",
  borderBottom: rule,
  overflowWrap: "anywhere",
});
globalStyle(`${table} thead th`, { ...typography("action") });
globalStyle(`${table} tbody th`, {
  fontWeight: foundation.font.body.weight,
});
globalStyle(`${table} tbody th > code`, {
  fontWeight: foundation.font.rowHeading.weight,
  overflowWrap: "normal",
});
export const cellNote = style({
  display: "block",
  ...typography("meta"),
});
export const example = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  margin: 0,
  minWidth: 0,
});
export const exampleLabel = style({ ...typography("rowHeading") });
export const form = style({
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${px(foundation.layout.phoneColumn)}), 1fr))`,
  gap: tokens.space["16"],
  minWidth: 0,
});
export const field = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["4"],
  minWidth: 0,
});
export const label = style({ ...typography("rowHeading") });
globalStyle(`${label} > span`, { ...typography("meta") });
export const control = style({
  width: "100%",
  minWidth: 0,
  minHeight: tokens.control.height,
  paddingInline: tokens.space["12"],
  border: rule,
  borderRadius: 0,
  color: tokens.color.ink,
  background: tokens.color.paper,
  ...typography("label"),
});
export const selection = style({
  position: "relative",
  display: "flex",
  alignItems: "center",
});
export const select = style([
  control,
  {
    appearance: "none",
    paddingInlineEnd: `calc(${tokens.space["12"]} + ${tokens.control.selectIcon} + ${tokens.space["8"]})`,
    cursor: "pointer",
  },
]);
export const chevron = style({
  position: "absolute",
  insetInlineEnd: tokens.space["12"],
  pointerEvents: "none",
  width: tokens.control.selectIcon,
  height: tokens.control.selectIcon,
});
export const submit = style({ gridColumn: "1 / -1" });
export const attempt = style({
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["8"],
  minWidth: 0,
  scrollMarginTop: tokens.space["16"],
});
export const attemptStatus = style({
  display: "block",
  ...typography("rowHeading"),
});
