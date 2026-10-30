import { expect, it } from "vitest";
import { opensNewTab } from "../../src/ui/links.ts";

it("opens web resource links in new tabs with browser-compatible URL resolution", () => {
  for (const href of [
    "https://example.org/source.xlsx",
    "http://example.org/terms",
    "//example.org/map",
    " HTTPS://example.org/ ",
    "/\\example.org/map",
    "https://relative.invalid/source",
  ])
    expect(opensNewTab(href), href).toBe(true);
  for (const href of [
    "/",
    "/?q=高知大学",
    "/contacts/fixture:1",
    "/api/contacts",
    "#main",
    "tel:+81888440111",
    "mailto:info@example.org",
    "http://[",
  ])
    expect(opensNewTab(href), href).toBe(false);
});
