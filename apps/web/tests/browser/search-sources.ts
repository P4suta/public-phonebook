import { expect, type Locator, type Page } from "@playwright/test";

const indexLoadTimeout = 60_000;

/** Makes the browser ask to save data, so the page keeps searching on the server. */
export async function saveData(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "connection", {
      configurable: true,
      get: () => ({ saveData: true }),
    });
  });
}

export function searchSource(page: Page): Locator {
  return page.locator("search[data-local-search]");
}

export async function waitForLocalSearch(page: Page): Promise<void> {
  await expect(searchSource(page)).toHaveAttribute(
    "data-local-search",
    "ready",
    { timeout: indexLoadTimeout },
  );
}

/** Holds the index location request until the returned function is called. */
export async function holdIndex(page: Page): Promise<() => void> {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === "/api/search-index",
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  return () => release?.();
}

/** Names a result's detail action: the facility name, then the visible label. */
export const detailActionName = /^.+の(?:住所などを見る|くわしい情報を見る)$/u;

export function contactLinks(page: Page): Locator {
  return page.locator("article").getByRole("link", { name: detailActionName });
}
