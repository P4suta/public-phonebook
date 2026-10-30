import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const settleDelay = 120;
const keystrokeGap = 2 * settleDelay;
const readerPause = 3 * keystrokeGap;
const quietPeriod = 10_000;
const loadedAt = new Date("2026-10-31T00:00:00Z");
const typingFrom = new Date("2026-10-31T01:00:00Z");

async function searchPage(
  page: Page,
): Promise<{ readonly queries: string[]; readonly input: Locator }> {
  const queries: string[] = [];
  await page.route("**/api/contact-groups?**", async (route) => {
    queries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await route.continue();
  });
  await page.clock.install({ time: loadedAt });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.clock.pauseAt(typingFrom);
  const input = page.getByRole("searchbox");
  await input.focus();
  return { queries, input };
}

async function typeAtPace(page: Page, text: string): Promise<void> {
  for (const [index, character] of Array.from(text).entries()) {
    if (index > 0) await page.clock.runFor(keystrokeGap);
    await page.keyboard.type(character);
  }
}

async function expectSearches(
  page: Page,
  queries: readonly string[],
  expected: readonly string[],
): Promise<void> {
  await expect.poll(() => [...queries]).toEqual(expected);
  await page.clock.runFor(quietPeriod);
  expect(queries).toEqual(expected);
}

test("Latin typing searches after the reader's own pause, not per keystroke", async ({
  page,
}) => {
  const { queries } = await searchPage(page);
  await typeAtPace(page, "tokyo");
  await page.clock.runFor(readerPause - 1);
  expect(queries).toEqual([]);
  await page.clock.runFor(1);
  await expectSearches(page, queries, ["tokyo"]);
});

test("Latin typing with fewer than two intervals has no pause search", async ({
  page,
}) => {
  const { queries } = await searchPage(page);
  await typeAtPace(page, "to");
  await page.clock.runFor(quietPeriod);
  expect(queries).toEqual([]);
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
    const { queries } = await searchPage(page);
    await typeAtPace(page, "tok");
    await page.clock.runFor(keystrokeGap);
    await finish(page);
    await page.clock.runFor(1);
    await expectSearches(page, queries, ["tok"]);
  });

test("a partial telephone number waits until it is complete", async ({
  page,
}) => {
  const { queries } = await searchPage(page);
  await typeAtPace(page, "03-3581-233");
  await page.clock.runFor(quietPeriod);
  expect(queries).toEqual([]);
  await page.keyboard.type("1");
  await page.clock.runFor(settleDelay - 1);
  expect(queries).toEqual([]);
  await page.clock.runFor(1);
  await expectSearches(page, queries, ["03-3581-2331"]);
});

test("Enter searches a partial telephone number", async ({ page }) => {
  const { queries } = await searchPage(page);
  await typeAtPace(page, "03-35");
  await page.clock.runFor(quietPeriod);
  expect(queries).toEqual([]);
  await page.keyboard.press("Enter");
  await expectSearches(page, queries, ["03-35"]);
});

test("Japanese input keeps the short delay after composition", async ({
  page,
}) => {
  const { queries } = await searchPage(page);
  await page.keyboard.insertText("東京");
  await page.clock.runFor(settleDelay - 1);
  expect(queries).toEqual([]);
  await page.clock.runFor(1);
  await expectSearches(page, queries, ["東京"]);
});
