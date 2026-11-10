import type { Category } from "@public-phonebook/directory/catalog";
import type { FileRouteTypes } from "../routeTree.gen.ts";
import {
  categoryFallbackIcon,
  categoryIcons,
  type IconName,
} from "./icon-catalog.ts";
import { categoryIcon } from "./icons.tsx";

type RouteId = FileRouteTypes["id"];

const everyCategory: readonly IconName[] = [
  ...Object.values(categoryIcons),
  categoryFallbackIcon,
];

/**
 * Lists the icons each route can draw in its server render or any later client render.
 * The shell's own icons sit under `__root__`, and each other route lists only what it adds.
 * `tests/unit/route-icons.test.ts` derives these sets from the code each route reaches and requires them to match.
 */
export const routeIcons: Readonly<Record<RouteId, readonly IconName[]>> = {
  __root__: ["arrow-left", "external-link", "x"],
  "/": [
    "book-user",
    "chevron-down",
    "chevron-right",
    "info",
    "phone",
    "rotate-cw",
    "search",
    ...everyCategory,
  ],
  "/about": ["database", "life-buoy", "shield-check"],
  "/contacts/$id": ["book-user", "file-search", "map-pin", "phone"],
  "/contacts/$id_/source": ["file-braces"],
  "/contacts/row/$snapshot/$row": [],
  "/data": [...everyCategory, "download"],
  "/privacy": ["life-buoy", "mail", "shield-check"],
  "/support": ["life-buoy", "mail", "shield-check"],
};

export type PageMatch =
  | {
      readonly routeId: "/contacts/$id";
      readonly loaderData?: { readonly category: Category } | undefined;
    }
  | { readonly routeId: Exclude<RouteId, "/contacts/$id"> };

/** Lists a page's icons in name order, so its server and client renders inline the same sprite. */
export function pageIcons(matches: readonly PageMatch[]): readonly IconName[] {
  const names = new Set<IconName>();
  for (const match of matches) {
    for (const name of routeIcons[match.routeId]) names.add(name);
    if (match.routeId === "/contacts/$id" && match.loaderData)
      names.add(categoryIcon(match.loaderData.category));
  }
  return [...names].sort();
}
