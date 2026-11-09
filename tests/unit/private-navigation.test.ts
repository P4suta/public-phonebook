import { describe, expect, it } from "vitest";
import {
  contactReturnHref,
  localContactHref,
  privateReturnTarget,
  privateSearch,
} from "../../src/core/private-navigation.ts";
import { catalogRegions, localCard } from "../../src/ui/result-cards.ts";
import { indexInput } from "./local-search-fixture.ts";

describe("local search navigation privacy", () => {
  it.each([
    "//example.org",
    "https://example.org",
    "/contacts/123",
    "javascript:alert(1)",
    "/?q=x#another",
    "/#from=outside",
  ])("refuses a return outside the search route: %s", (from) => {
    expect(privateReturnTarget(`#from=${encodeURIComponent(from)}`)).toBeNull();
    expect(
      new URLSearchParams(
        new URL(
          localContactHref("/contacts/123", from),
          "https://example.org",
        ).hash.slice(1),
      ).get("from"),
    ).toBe("/");
  });

  it("carries encoded queries through source pages without adding a request parameter", () => {
    const target = privateReturnTarget(
      new URL(
        localContactHref(
          "/contacts/123",
          "/?q=%23%26%25%2B%20%E5%9B%B3%E6%9B%B8%E9%A4%A8&category=library",
        ),
        "https://example.org",
      ).hash,
    );
    expect(target?.local).toBe(true);
    if (!target) return;
    const source = new URL(
      contactReturnHref("/contacts/123/source", target),
      "https://example.org",
    );
    expect(source.search).toBe("");
    expect(privateReturnTarget(source.hash)).toEqual(target);
    expect(privateSearch(target.from.slice(1))?.q).toBe("#&%+ 図書館");
  });

  it("keeps server return paths and rejects duplicate fragment fields", () => {
    expect(
      contactReturnHref("/contacts/123", { from: "/?q=library", local: false }),
    ).toBe("/contacts/123?from=%2F%3Fq%3Dlibrary");
    expect(privateReturnTarget("#from=%2F&from=%2F")).toBeNull();
    expect(privateSearch("#main")).toBeNull();
    expect(privateSearch("#q=library&cursor=ignored")?.cursor).toBe("");
  });
  it("keeps a local result's return query out of the request URL", () => {
    const input = indexInput("d".repeat(64));
    const card = localCard(
      {
        row: 0,
        name: "図書館",
        category: "library",
        region: "13101",
        phones: ["0335812331"],
        hasAddress: true,
      },
      input.snapshot,
      catalogRegions(input.catalog),
      "/?q=%E5%9B%B3%E6%9B%B8%E9%A4%A8",
    );
    const url = new URL(card.href, "https://example.org");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("from")).toBe(
      "/#q=%E5%9B%B3%E6%9B%B8%E9%A4%A8",
    );
  });
});
