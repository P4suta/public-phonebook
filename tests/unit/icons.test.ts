import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { categoryDefinitions } from "../../src/core/catalog.ts";
import { CategoryIcon } from "../../src/ui/icons.tsx";

it("gives every category distinct, consistently sized icon geometry", () => {
  const markup = categoryDefinitions.map((category) =>
    renderToStaticMarkup(
      createElement(CategoryIcon, { category: category.id }),
    ),
  );
  for (const value of markup) {
    expect(value).toContain('width="16"');
    expect(value).toContain('height="16"');
  }
  expect(
    new Set(markup.map((value) => value.replaceAll(/class="[^"]*"/gu, "")))
      .size,
  ).toBe(39);
  expect(
    new Set(categoryDefinitions.map((category) => category.icon)).size,
  ).toBe(39);
});
