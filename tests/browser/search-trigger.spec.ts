import type { Locator, Page } from "@playwright/test";
import * as v from "valibot";
import { expect, test } from "./fixtures.ts";
import { saveData, waitForLocalSearch } from "./search-sources.ts";

const settleDelay = 120;
const keystrokeGap = 2 * settleDelay;
const readerPause = 3 * keystrokeGap;
const quietPeriod = 10_000;
const loadedAt = new Date("2026-10-31T00:00:00Z");
const typingFrom = new Date("2026-10-31T01:00:00Z");
const searchRecord = "__contactGroupSearches";

const SearchStateSchema = v.object({
  fetched: v.array(v.string()),
  address: v.nullable(v.string()),
});
type SearchState = v.InferOutput<typeof SearchStateSchema>;

/** Records each contact-groups query in the page when it calls `fetch`, before the request leaves the page. */
async function recordSearches(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const fetched: string[] = [];
    Reflect.set(window, key, fetched);
    const send = window.fetch.bind(window);
    window.fetch = async (input, init): Promise<Response> => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (url.pathname === "/api/contact-groups")
        fetched.push(url.searchParams.get("q") ?? "");
      return send(input, init);
    };
  }, searchRecord);
}

/**
 * Reads the searches the page has started and the query in its address.
 * A search decision writes the address in a microtask of the timer that made it, so the address shows a premature decision once `runFor` returns.
 */
async function searchState(page: Page): Promise<SearchState> {
  const state: unknown = await page.evaluate((key) => {
    const fetched: unknown = Reflect.get(window, key);
    return { fetched, address: new URLSearchParams(location.search).get("q") };
  }, searchRecord);
  return v.parse(SearchStateSchema, state);
}

async function searchPage(page: Page): Promise<Locator> {
  await recordSearches(page);
  await saveData(page);
  await page.clock.install({ time: loadedAt });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.clock.pauseAt(typingFrom);
  const input = page.getByRole("searchbox");
  await input.focus();
  return input;
}

async function typeAtPace(page: Page, text: string): Promise<void> {
  for (const [index, character] of Array.from(text).entries()) {
    if (index > 0) await page.clock.runFor(keystrokeGap);
    await page.keyboard.type(character);
  }
}

async function expectNoSearch(page: Page): Promise<void> {
  expect(await searchState(page)).toEqual({ fetched: [], address: null });
}

async function expectSearches(
  page: Page,
  expected: readonly string[],
): Promise<void> {
  await expect
    .poll(async () => (await searchState(page)).fetched)
    .toEqual(expected);
  await page.clock.runFor(quietPeriod);
  expect(await searchState(page)).toEqual({
    fetched: expected,
    address: expected.at(-1) ?? null,
  });
}

test("Latin typing searches after the reader's own pause, not per keystroke", async ({
  page,
}) => {
  await searchPage(page);
  await typeAtPace(page, "tokyo");
  await page.clock.runFor(readerPause - 1);
  await expectNoSearch(page);
  await page.clock.runFor(1);
  await expectSearches(page, ["tokyo"]);
});

test("Latin typing with fewer than two intervals has no pause search", async ({
  page,
}) => {
  await searchPage(page);
  await typeAtPace(page, "to");
  await page.clock.runFor(quietPeriod);
  await expectNoSearch(page);
});

const boundaries: readonly [string, (page: Page) => Promise<void>][] = [
  ["a typed space", async (page) => page.keyboard.type(" ")],
  ["Enter", async (page) => page.keyboard.press("Enter")],
  ["leaving the field", async (page) => page.keyboard.press("Tab")],
  [
    "the search button",
    async (page) =>
      page.getByRole("button", { name: "電話番号をさがす" }).click(),
  ],
];

for (const [name, finish] of boundaries)
  test(`Latin typing searches at ${name}`, async ({ page }) => {
    await searchPage(page);
    await typeAtPace(page, "tok");
    await page.clock.runFor(keystrokeGap);
    await finish(page);
    await page.clock.runFor(1);
    await expectSearches(page, ["tok"]);
  });

test("pasted Latin text searches at once", async ({ page }) => {
  const input = await searchPage(page);
  await input.evaluate((element: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, "tokyo");
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }),
    );
  });
  await page.clock.runFor(1);
  await expectSearches(page, ["tokyo"]);
});

test("a partial telephone number waits until it is complete", async ({
  page,
}) => {
  await searchPage(page);
  await typeAtPace(page, "03-3581-233");
  await page.clock.runFor(quietPeriod);
  await expectNoSearch(page);
  await page.keyboard.type("1");
  await page.clock.runFor(settleDelay - 1);
  await expectNoSearch(page);
  await page.clock.runFor(1);
  await expectSearches(page, ["03-3581-2331"]);
});

test("Enter searches a partial telephone number", async ({ page }) => {
  await searchPage(page);
  await typeAtPace(page, "03-35");
  await page.clock.runFor(quietPeriod);
  await expectNoSearch(page);
  await page.keyboard.press("Enter");
  await expectSearches(page, ["03-35"]);
});

test("after the index loads, each Latin keystroke searches on the device at once", async ({
  page,
}) => {
  await recordSearches(page);
  await page.goto("/");
  await waitForLocalSearch(page);
  const input = page.getByRole("searchbox");
  await input.focus();
  for (const text of ["k", "ko", "kok"]) {
    await page.keyboard.type(text.at(-1) ?? "");
    await expect(page).toHaveURL(`/?q=${text}`);
  }
  expect((await searchState(page)).fetched).toEqual([]);
});

test("Japanese input keeps the short delay after composition", async ({
  page,
}) => {
  await searchPage(page);
  await page.keyboard.insertText("東京");
  await page.clock.runFor(settleDelay - 1);
  await expectNoSearch(page);
  await page.clock.runFor(1);
  await expectSearches(page, ["東京"]);
});
