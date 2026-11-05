import AxeBuilder from "@axe-core/playwright";
import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import { expect, test } from "./fixtures.ts";
import {
  contactLinks,
  holdIndex,
  saveData,
  waitForLocalSearch,
} from "./search-sources.ts";

test.use({ video: "on", screenshot: "off" });

test("server results form one ordered list with category and region on each card", async ({
  page,
  request,
}) => {
  const expected = v.parse(
    SearchResponseSchema,
    await (await request.get("/api/contacts?q=高知大学")).json(),
  );
  await saveData(page);
  await page.goto("/?q=高知大学");
  await expect(page.locator("[data-result-list=server] > ol")).toHaveCount(1);
  await expect(page.locator("article")).toHaveCount(expected.data.length);
  expect(
    await page
      .locator("article")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("aria-labelledby")),
      ),
  ).toEqual(expected.data.map((contact) => `contact-${contact.id}`));
  await expect(page.locator("article h2").first()).toHaveText("高知大学");
  await expect(page.locator("article h3")).toHaveCount(0);
  await expect(page.locator("section[data-result-category]")).toHaveCount(0);
  for (const [position, contact] of expected.data.entries()) {
    const card = page.locator("article").nth(position);
    await expect(card.locator("[data-result-category]")).toHaveAttribute(
      "data-result-category",
      contact.category,
    );
    await expect(card.locator("h2 + p > span").last()).not.toHaveText("");
  }
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
});

test("server continuation appends the next page in rank order", async ({
  page,
  request,
}) => {
  const first = v.parse(
    SearchResponseSchema,
    await (await request.get("/api/contacts?q=図書館")).json(),
  );
  if (!first.links.next)
    throw new Error("The national query needs a continuation");
  const nextUrl = new URL(first.links.next);
  const second = v.parse(
    SearchResponseSchema,
    await (await request.get(`${nextUrl.pathname}${nextUrl.search}`)).json(),
  );
  await saveData(page);
  let continuations = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/contacts" && url.searchParams.has("cursor"))
      continuations += 1;
  });
  await page.goto("/?q=図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const more = page.getByRole("link", {
    name: "検索結果をもっと見る",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  expect(continuations).toBe(0);
  await more.click();
  await expect(page.locator("article")).toHaveCount(
    first.data.length + second.data.length,
  );
  expect(
    await page
      .locator("article")
      .evaluateAll((cards) =>
        cards.map((card) => card.getAttribute("aria-labelledby")),
      ),
  ).toEqual(
    [...first.data, ...second.data].map((contact) => `contact-${contact.id}`),
  );
  await expect(page.locator("article h2").nth(first.data.length)).toBeFocused();
  expect(continuations).toBe(1);
});

test("device continuation preserves the first page, adds 30 ranked cards, and sends no request", async ({
  page,
}) => {
  await page.goto("/?q=高知");
  await waitForLocalSearch(page);
  await expect(contactLinks(page).first()).toHaveAttribute(
    "href",
    /^\/contacts\/row\//u,
  );
  await expect(page.locator("[data-result-list=local] > ol")).toHaveCount(1);
  await expect(page.locator("article")).toHaveCount(30);
  const before = await page.locator("article h2").allTextContents();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page
    .getByRole("link", { name: "検索結果をもっと見る", exact: true })
    .click();
  await expect(page.locator("article")).toHaveCount(60);
  expect(
    (await page.locator("article h2").allTextContents()).slice(0, 30),
  ).toEqual(before);
  await expect(page.locator("article h2").nth(30)).toBeFocused();
  expect(requests).toEqual([]);
});

test("a focused server candidate absent from device results returns focus to the search field", async ({
  page,
}) => {
  const release = await holdIndex(page);
  await page.goto("/?q=国立国会図書館");
  await expect(contactLinks(page)).toHaveCount(3);
  await contactLinks(page).nth(2).focus();
  release();
  await waitForLocalSearch(page);
  await expect(contactLinks(page)).toHaveCount(1);
  await expect(page.getByRole("searchbox")).toBeFocused();
});

test("a retained candidate keeps its focused element when its rank changes", async ({
  page,
}) => {
  const release = await holdIndex(page);
  await page.goto("/?q=国立国会");
  await expect(contactLinks(page)).toHaveCount(3);
  const link = page.getByRole("link", {
    name: "国立国会図書館関西館の住所などを見る",
    exact: true,
  });
  const position = (): Promise<number> =>
    link.evaluate((node) => {
      const item = node.closest("li");
      return item?.parentElement
        ? Array.from(item.parentElement.children).indexOf(item)
        : -1;
    });
  const before = await position();
  await link.focus();
  const original = await link.elementHandle();
  if (!original) throw new Error("The candidate link is missing");
  release();
  await waitForLocalSearch(page);
  await expect(link).toHaveAttribute("href", /^\/contacts\/row\//u);
  expect(await position()).not.toBe(before);
  expect(
    await original.evaluate(
      (node) => node.isConnected && document.activeElement === node,
    ),
  ).toBe(true);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("continuation follows the next ranked page through a native link", async ({
    page,
  }) => {
    await page.goto("/?q=図書館");
    await expect(page.locator("[data-result-list=server] > ol")).toHaveCount(1);
    await expect(page.locator("article")).toHaveCount(30);
    const before = await contactLinks(page).evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")),
    );
    const more = page.getByRole("link", {
      name: "検索結果をもっと見る",
      exact: true,
    });
    await expect(more).toHaveAttribute("href", /cursor=/u);
    await more.click();
    await expect(page).toHaveURL(/cursor=/u);
    expect(new URL(page.url()).searchParams.has("category")).toBe(false);
    await expect(page.locator("article")).toHaveCount(30);
    const after = await contactLinks(page).evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")?.split("?")[0]),
    );
    expect(
      after.every((href) => !before.some((old) => old?.split("?")[0] === href)),
    ).toBe(true);
  });
});
