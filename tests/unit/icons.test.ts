import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { categoryDefinitions } from "../../src/core/catalog.ts";
import { foundation } from "../../src/ui/foundations.ts";
import {
  categoryFallbackIcon,
  categoryIcons,
  iconIdPrefix,
  iconNames,
  iconSymbols,
} from "../../src/ui/icon-catalog.ts";
import { CategoryIcon, categoryIcon, Icon } from "../../src/ui/icons.tsx";

const nativeScreens = "ios/App";
const nativeCatalog = "ios/Sources/PhonebookKit/IconCatalog.swift";
const { icon: actionIconSize, categoryIcon: categoryIconSize } =
  foundation.control;

/** Categories that #33 added after the Figma masters, which both clients draw with the fallback icon until masters exist. */
const categoriesWithoutMasters = [
  "elementary_school",
  "junior_high_school",
  "high_school",
  "compulsory_education_school",
  "secondary_school",
  "special_needs_school",
  "vocational_school",
  "miscellaneous_school",
  "education_board",
  "health_center",
  "mental_health_center",
  "fire_department",
  "police_station",
  "community_center",
  "sports_facility",
  "cultural_hall",
  "tourist_information",
  "passport_office",
  "immigration_office",
  "court",
  "customs",
  "gender_equality_center",
  "domestic_violence_support",
  "child_family_support",
  "vocational_training",
  "business_support",
];

function hasMaster(category: string): boolean {
  return Object.hasOwn(categoryIcons, category);
}

it("draws a symbol from the sprite and names it on the element", () => {
  expect(renderToStaticMarkup(createElement(Icon, { name: "phone" }))).toBe(
    `<svg width="${actionIconSize}" height="${actionIconSize}" aria-hidden="true" data-icon="phone"><use href="#${iconIdPrefix}phone"></use></svg>`,
  );
});

it("draws every category from the sprite at the category icon size", () => {
  for (const category of categoryDefinitions) {
    const name = categoryIcon(category.id);
    expect(iconNames).toContain(name);
    expect(
      renderToStaticMarkup(
        createElement(CategoryIcon, { category: category.id }),
      ),
    ).toBe(
      `<svg width="${categoryIconSize}" height="${categoryIconSize}" aria-hidden="true" data-icon="${name}"><use href="#${iconIdPrefix}${name}"></use></svg>`,
    );
  }
});

it("maps each web category to the same canonical Figma export as the iPhone app", async () => {
  const swift = await readFile(nativeCatalog, "utf8");
  expect(
    Object.fromEntries(
      [...swift.matchAll(/"(\w+)": "([\w-]+)"/gu)].map((match) => [
        match[1],
        match[2],
      ]),
    ),
  ).toEqual(categoryIcons);
  for (const [category, icon] of Object.entries(categoryIcons))
    expect(
      categoryDefinitions.find((definition) => definition.id === category)
        ?.icon,
      category,
    ).toBe(icon);
  const fallbacks: string[] = [];
  for (const file of await readdir(nativeScreens))
    if (file.endsWith(".swift"))
      for (const match of (
        await readFile(join(nativeScreens, file), "utf8")
      ).matchAll(/IconCatalog\.categories\[[^\]]+\] \?\? "([\w-]+)"/gu))
        fallbacks.push(match[1] ?? "");
  expect(fallbacks.length).toBeGreaterThan(0);
  expect(new Set(fallbacks)).toEqual(new Set([categoryFallbackIcon]));
});

it("keeps mapped categories distinct and names each category still waiting for a master", () => {
  const mapped = categoryDefinitions.filter((category) =>
    hasMaster(category.id),
  );
  const mappedIcons = mapped.map((category) => categoryIcon(category.id));
  expect(new Set(mappedIcons).size).toBe(mapped.length);
  expect(mappedIcons).not.toContain(categoryFallbackIcon);
  expect(
    categoryDefinitions
      .filter((category) => !hasMaster(category.id))
      .map((category) => category.id),
  ).toEqual(categoriesWithoutMasters);
  for (const category of categoryDefinitions)
    if (!hasMaster(category.id))
      expect(categoryIcon(category.id)).toBe(categoryFallbackIcon);
});

it("defines one symbol per icon name, painted only with the surrounding text color", () => {
  expect(
    [...iconSymbols.matchAll(/<symbol id="([\w-]+)"/gu)].map(
      (match) => match[1],
    ),
  ).toEqual(iconNames.map((name) => `${iconIdPrefix}${name}`));
  expect([...iconSymbols.matchAll(/(?:fill|stroke)="([^"]*)"/gu)].length).toBe(
    [...iconSymbols.matchAll(/(?:fill|stroke)="(?:none|currentColor)"/gu)]
      .length,
  );
});

it("keeps the unchanged Figma export of each icon beside its notices", async () => {
  for (const name of iconNames)
    expect(
      await readFile(join("public/icons", `${name}.svg`), "utf8"),
      name,
    ).toBe(await readFile(join("design/icons", `${name}.svg`), "utf8"));
  expect(await readFile("public/icons/LICENSE.txt", "utf8")).toBe(
    await readFile("design/licenses/Lucide.txt", "utf8"),
  );
});
