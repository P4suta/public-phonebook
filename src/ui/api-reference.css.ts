import { globalStyle, style } from "@vanilla-extract/css";
import { foundation, px, rem } from "./foundations.ts";
import { tokens } from "./theme.css.ts";

const rule = `${tokens.control.border} solid #000`;

export const page = style({
  width: "100%",
  maxWidth: px(foundation.layout.referenceWidth),
  marginInline: "auto",
  padding: tokens.space["24"],
  display: "flex",
  flexDirection: "column",
  gap: tokens.space["24"],
  minWidth: 0,
});
export const reference = style({ minWidth: 0, width: "100%" });
export const loading = style({
  display: "none",
  selectors: { 'html[data-enhanced="true"] &': { display: "block" } },
});

const scope = "body:has([data-api-reference])";
globalStyle(`${scope}, ${scope} :is(.scalar-app,.light-mode,.dark-mode)`, {
  vars: {
    "--scalar-font": "sans-serif",
    "--scalar-font-code": "ui-monospace, SFMono-Regular, Menlo, monospace",
    "--scalar-font-size-1": rem(foundation.font.page.size),
    "--scalar-font-size-2": rem(foundation.font.section.size),
    "--scalar-font-size-3": rem(foundation.font.body.size),
    "--scalar-font-size-4": rem(foundation.font.meta.size),
    "--scalar-font-size-5": rem(foundation.font.meta.size),
    "--scalar-font-size-6": rem(foundation.font.meta.size),
    "--scalar-font-size-7": rem(foundation.font.meta.size),
    "--scalar-background-1": "#fff",
    "--scalar-background-2": "#fff",
    "--scalar-background-3": "#fff",
    "--scalar-background-accent": "#fff",
    "--scalar-background-alert": "#fff",
    "--scalar-background-danger": "#fff",
    "--scalar-tooltip-background": "#fff",
    "--scalar-tooltip-color": "#000",
    "--scalar-button-1": "#000",
    "--scalar-button-1-hover": "#000",
    "--scalar-button-1-color": "#fff",
    "--scalar-color-1": "#000",
    "--scalar-color-2": "#000",
    "--scalar-color-3": "#000",
    "--scalar-color-accent": "#000",
    "--scalar-border-color": "#000",
    "--scalar-color-green": "#000",
    "--scalar-color-red": "#000",
    "--scalar-color-blue": "#000",
    "--scalar-color-yellow": "#000",
    "--scalar-color-orange": "#000",
    "--scalar-color-purple": "#000",
    "--scalar-color-query": "#000",
    "--scalar-color-ghost": "#000",
    "--scalar-color-disabled": "#000",
    "--scalar-color-danger": "#000",
    "--scalar-color-alert": "#000",
    "--scalar-sidebar-background-1": "#fff",
    "--scalar-sidebar-color-1": "#000",
    "--scalar-sidebar-color-2": "#000",
    "--scalar-sidebar-item-hover-background": "#fff",
    "--scalar-sidebar-item-active-background": "#fff",
    "--scalar-sidebar-item-active-color": "#000",
    "--scalar-sidebar-search-background": "#fff",
    "--scalar-sidebar-search-color": "#000",
  },
});
globalStyle(`${scope} *`, {
  borderColor: "#000 !important",
  outlineColor: "#000 !important",
  textDecorationColor: "#000 !important",
  filter: "none !important",
  backdropFilter: "none !important",
  boxShadow: "none !important",
  textShadow: "none !important",
  backgroundImage: "none !important",
  maskImage: "none !important",
  WebkitMaskImage: "none !important",
  fillOpacity: "1 !important",
  strokeOpacity: "1 !important",
  accentColor: "#000",
  mixBlendMode: "normal",
  animation: "none !important",
  transition: "none !important",
});
globalStyle(`${scope} svg [fill]:not([fill="none"])`, {
  fill: "currentColor !important",
});
globalStyle(`${scope} svg [stroke]:not([stroke="none"])`, {
  stroke: "currentColor !important",
});
globalStyle(`${scope} ::selection`, {
  backgroundColor: "#000 !important",
  color: "#fff !important",
});
globalStyle(`${scope} .cm-selectionBackground`, {
  backgroundColor: "transparent !important",
  outline: rule,
});
globalStyle("[data-api-reference] h1", {
  fontSize: rem(foundation.font.page.size),
  lineHeight: rem(foundation.font.page.lineHeight),
  fontWeight: foundation.font.rowHeading.weight,
});
globalStyle("[data-api-reference] h2", {
  fontSize: rem(foundation.font.section.size),
  lineHeight: rem(foundation.font.section.lineHeight),
  fontWeight: foundation.font.rowHeading.weight,
});
globalStyle("[data-api-reference] :is(h3,h4)", {
  fontSize: rem(foundation.font.body.size),
  lineHeight: rem(foundation.font.body.lineHeight),
  fontWeight: foundation.font.rowHeading.weight,
});
globalStyle(`${scope} :is(button,input,select,textarea)`, {
  minHeight: `${rem(foundation.control.height)} !important`,
  maxWidth: "100%",
});
globalStyle(`${scope} button`, {
  minWidth: `${rem(foundation.control.height)} !important`,
});
globalStyle(`${scope} [role="dialog"] :is(.h-8,.h-10)`, {
  height: "auto",
  minHeight: rem(foundation.control.height),
});
globalStyle(`${scope} [role="dialog"] h2`, {
  fontSize: rem(foundation.font.body.size),
  lineHeight: rem(foundation.font.body.lineHeight),
});
globalStyle(`${scope} [role="dialog"] :is(th,td)`, {
  height: rem(foundation.control.height),
  minHeight: rem(foundation.control.height),
  maxHeight: "none",
});
globalStyle(`${scope} .scalar-data-table table:has(input[type="checkbox"])`, {
  gridTemplateColumns: `${rem(foundation.control.height)} minmax(0,1fr) minmax(0,1fr) !important`,
});
globalStyle(`${scope} [role="dialog"] :has(> input[type="checkbox"])`, {
  minWidth: rem(foundation.control.height),
  minHeight: rem(foundation.control.height),
});
globalStyle(`${scope} [class~="group/copy-button"]`, {
  opacity: "1 !important",
});
globalStyle(`${scope} [class~="shadow-border"]`, { border: rule });
globalStyle(`${scope} .scalar-container.scalar-client--open`, {
  backgroundColor: "#fff",
});
globalStyle(`${scope} .app-exit-button`, {
  color: "#fff",
  backgroundColor: "#000 !important",
  border: rule,
});
globalStyle(`${scope} .address-bar-bg-states`, {
  minHeight: rem(foundation.control.height),
});
globalStyle(`${scope} .address-bar-bg-states > div > [style]`, {
  backgroundColor: "#000 !important",
  top: "auto",
  bottom: 0,
  height: `calc(2 * ${tokens.control.border})`,
});
globalStyle(`${scope} [class~="group/cell"] [class~="border-[1px]"]`, {
  opacity: 1,
});
globalStyle(`${scope} .cm-editor`, { backgroundColor: "#fff", color: "#000" });
globalStyle(`${scope} .cm-editor *`, {
  color: "#000 !important",
  backgroundColor: "transparent !important",
});
globalStyle(`${scope} .cm-tooltip`, {
  backgroundColor: "#fff !important",
  color: "#000",
  border: rule,
});
globalStyle(`${scope} button svg`, {
  width: rem(foundation.control.icon),
  height: rem(foundation.control.icon),
  flexShrink: 0,
});
globalStyle(`${scope} [role="tablist"]`, {
  flexWrap: "wrap",
  height: "auto",
  minWidth: 0,
});
globalStyle(`${scope} [role="tab"]`, {
  flex: "0 0 auto",
  width: "auto",
  height: "auto",
  whiteSpace: "normal",
  paddingInline: rem(foundation.space["12"]),
  gap: rem(foundation.space["8"]),
});
globalStyle(`${scope} [role="tab"]::before, ${scope} [role="tab"]::after`, {
  content: "none",
});
globalStyle(`${scope} :is(.sr-only,.screenreader-only)`, {
  top: "0 !important",
  left: "0 !important",
  margin: "0 !important",
  width: `${tokens.control.border} !important`,
  height: `${tokens.control.border} !important`,
});
globalStyle(`${scope} [class~="group/copy-label"]`, {
  position: "static",
  padding: "0 !important",
  width: 0,
  height: 0,
});
globalStyle(`${scope} [class~="group/copy-label"] > :not(.sr-only)`, {
  display: "none",
});
globalStyle(
  `${scope} [data-sonner-toast]:is([data-visible="false"],[data-removed="true"])`,
  { visibility: "hidden" },
);
globalStyle(`${scope} a`, {
  minHeight: `${rem(foundation.control.height)} !important`,
  display: "inline-flex",
  alignItems: "center",
  overflowWrap: "anywhere",
  maxWidth: "100%",
});
globalStyle(`${scope} .endpoint-path`, {
  minWidth: 0,
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  overflow: "visible",
  textOverflow: "clip",
});
globalStyle(`${scope} :is(button,input,select,textarea):focus-visible`, {
  outline: `${tokens.control.focus} solid #000`,
  outlineOffset: tokens.control.focusOffset,
});
globalStyle(`${scope} [aria-current="true"], ${scope} [aria-selected="true"]`, {
  fontWeight: foundation.font.rowHeading.weight,
  textDecoration: "underline",
});
globalStyle(`${scope} :is(button,input,select,textarea):disabled`, {
  borderStyle: "dashed",
  cursor: "not-allowed",
});
