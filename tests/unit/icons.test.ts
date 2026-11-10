import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { categoryDefinitions } from "@public-phonebook/directory/catalog";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { foundation } from "../../apps/web/src/ui/foundations.ts";
import {
  categoryFallbackIcon,
  categoryIcons,
  iconIdPrefix,
  iconNames,
  iconSymbols,
} from "../../apps/web/src/ui/icon-catalog.ts";
import {
  CategoryIcon,
  categoryIcon,
  Icon,
  IconSprite,
} from "../../apps/web/src/ui/icons.tsx";
import {
  type ServiceInformation,
  serviceInformation,
} from "../../apps/web/src/ui/service-information.ts";

const nativeScreens = "apps/ios/App";
const nativeCatalog = "apps/ios/Sources/PhonebookKit/IconCatalog.swift";
const { icon: actionIconSize, categoryIcon: categoryIconSize } =
  foundation.control;

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

it("gives every category its own distinct master instead of the fallback", () => {
  expect(
    categoryDefinitions
      .filter((category) => !hasMaster(category.id))
      .map((category) => category.id),
  ).toEqual([]);
  const icons = categoryDefinitions.map((category) =>
    categoryIcon(category.id),
  );
  expect(new Set(icons).size).toBe(categoryDefinitions.length);
  expect(icons).not.toContain(categoryFallbackIcon);
});

it("draws the email and privacy links with their own masters", () => {
  const icons = serviceInformation.flatMap((information) =>
    information.links.map(
      (link: ServiceInformation["links"][number]) =>
        [link.href, link.icon] as const,
    ),
  );
  expect(Object.fromEntries(icons)).toMatchObject({
    "mailto:support@dial.page": "mail",
    "/privacy": "shield-check",
  });
});

it("defines one symbol per icon name, painted only with the surrounding text color", () => {
  expect(Object.keys(iconSymbols)).toEqual(iconNames);
  for (const name of iconNames)
    expect(
      [...iconSymbols[name].matchAll(/<symbol id="([\w-]+)"/gu)].map(
        (match) => match[1],
      ),
    ).toEqual([`${iconIdPrefix}${name}`]);
  const sprite = Object.values(iconSymbols).join("");
  expect([...sprite.matchAll(/(?:fill|stroke)="([^"]*)"/gu)].length).toBe(
    [...sprite.matchAll(/(?:fill|stroke)="(?:none|currentColor)"/gu)].length,
  );
});

it("defines only the symbols a page names, in the given order", () => {
  const sprite = renderToStaticMarkup(
    createElement(IconSprite, { className: "sprite", names: ["x", "copy"] }),
  );
  expect(sprite).toBe(
    `<svg class="sprite" width="0" height="0" aria-hidden="true" data-icon-sprite="">${iconSymbols.x}${iconSymbols.copy}</svg>`,
  );
});

it("keeps the unchanged Figma export of each icon beside its notices", async () => {
  for (const name of iconNames)
    expect(
      await readFile(join("apps/web/public/icons", `${name}.svg`), "utf8"),
      name,
    ).toBe(await readFile(join("design/icons", `${name}.svg`), "utf8"));
  expect(await readFile("apps/web/public/icons/LICENSE.txt", "utf8")).toBe(
    await readFile("design/licenses/Lucide.txt", "utf8"),
  );
});
