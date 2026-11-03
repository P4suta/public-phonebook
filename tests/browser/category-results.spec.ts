import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import * as v from "valibot";
import { GroupedSearchResponseSchema } from "../../src/core/models.ts";
import { foundation } from "../../src/ui/foundations.ts";
import { expect, test } from "./fixtures.ts";
import {
  detailActionName,
  saveData,
  waitForLocalSearch,
} from "./search-sources.ts";

test.use({ video: "on", screenshot: "off" });

const headingWidths = [320, 1440] as const;
const viewportHeight = 900;
const edgeTolerance = 1;

async function cardsWithoutCategoryHeading(
  page: Page,
): Promise<readonly string[]> {
  return page.locator("article").evaluateAll((cards) =>
    cards.flatMap((card) => {
      const group = card.closest("section[data-result-category]");
      const heading = group?.querySelector(":scope > h2");
      return heading && group?.getAttribute("aria-labelledby") === heading.id
        ? []
        : [card.getAttribute("aria-labelledby") ?? ""];
    }),
  );
}

test("an exact facility name leads its own category under the category heading", async ({
  page,
}) => {
  await page.goto("/?q=高知大学");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await expect(page.locator("article")).toHaveCount(7);
  const groups = page.locator("[data-result-category]");
  await expect(groups.locator("article")).toHaveCount(7);
  expect(await cardsWithoutCategoryHeading(page)).toEqual([]);
  expect(
    await groups.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-result-category")),
    ),
  ).toEqual([
    "university",
    "medical",
    "unlicensed_childcare",
    "workplace_childcare",
    "library",
  ]);
  const university = groups.first();
  const heading = university.getByRole("heading", {
    level: 2,
    name: "大学 1件",
    exact: true,
  });
  await expect(heading).toBeVisible();
  for (const width of headingWidths) {
    await page.setViewportSize({ width, height: viewportHeight });
    const [label, count] = await heading
      .locator(":scope > span")
      .evaluateAll((spans) =>
        spans.map((span) => {
          const box = span.getBoundingClientRect();
          return { left: box.left, right: box.right, text: span.textContent };
        }),
      );
    expect(label?.text, `${width}px`).toBe("大学");
    expect(count?.text, `${width}px`).toBe("1件");
    expect(
      Math.abs(
        (count?.left ?? 0) - (label?.right ?? 0) - foundation.space["8"],
      ),
      `The count follows its label at ${width}px`,
    ).toBeLessThan(edgeTolerance);
  }
  const exact = university.locator("article").first();
  await expect(exact.getByRole("heading", { level: 3 })).toHaveText("高知大学");
  await expect(exact.locator("[data-phone]").first()).toHaveText(
    "088-844-0111",
  );
  await expect(
    page.locator('[data-result-category="library"] article'),
  ).toHaveCount(3);
  await expect(groups.locator("article h2")).toHaveCount(0);
  await expect(groups.locator("article h3")).toHaveCount(7);
  await expect(groups.locator("article h3 + p")).toHaveCount(7);
  await expect(
    groups.locator("article").getByText("大学", { exact: true }),
  ).toHaveCount(0);
  const ids = await page
    .locator("[id]")
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("a broad search previews each kind and expands only the requested category", async ({
  page,
  request,
}) => {
  const raw: unknown = await (
    await request.get("/api/contact-groups?q=図書館")
  ).json();
  const expected = v.parse(GroupedSearchResponseSchema, raw);
  let continuations = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/contacts") continuations += 1;
  });
  await saveData(page);
  await page.goto("/?q=図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const previewIds = expected.groups
    .flatMap((group) =>
      group.results.data.map((contact) => `contact-${contact.id}`),
    )
    .toSorted();
  expect(
    await page
      .locator("article")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-labelledby") ?? "").sort(),
      ),
  ).toEqual(previewIds);
  expect(await cardsWithoutCategoryHeading(page)).toEqual([]);
  const library = page.locator('[data-result-category="library"]');
  const otherIds = await page
    .locator(
      '[data-result-category]:not([data-result-category="library"]) article',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-labelledby")),
    );
  const before = await library.locator("article").count();
  const more = library.getByRole("link", {
    name: "図書館をもっと見る",
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  expect(continuations).toBe(0);
  await more.click();
  await expect(library.locator("article")).toHaveCount(before + 30);
  expect(continuations).toBe(1);
  expect(
    await page
      .locator(
        '[data-result-category]:not([data-result-category="library"]) article',
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-labelledby")),
      ),
  ).toEqual(otherIds);
  expect(new URL(page.url()).searchParams.has("category")).toBe(false);
});

test("on the device, a continuation adds 30 cards without a request and focuses the first new card", async ({
  page,
}) => {
  await page.goto("/?q=図書館");
  await waitForLocalSearch(page);
  const library = page.locator('[data-result-category="library"]');
  await expect(
    library.getByRole("link", { name: detailActionName }).first(),
  ).toHaveAttribute("href", /^\/contacts\/row\//u);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const before = await library.locator("article").count();
  await library
    .getByRole("link", { name: "図書館をもっと見る", exact: true })
    .click();
  await expect(library.locator("article")).toHaveCount(before + 30);
  const first = library.locator("article").nth(before);
  const heading = first.getByRole("heading");
  await expect(heading).toBeFocused();
  await expect(heading).toHaveAttribute("tabindex", "-1");
  expect(requests).toEqual([]);
  expect(new URL(page.url()).searchParams.has("category")).toBe(false);
});

test("each category continuation has a usable native link without JavaScript", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The test server URL is required");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/?q=図書館");
    const library = page.locator('[data-result-category="library"]');
    const before = await library
      .locator("article")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-labelledby")),
      );
    expect(before.length).toBeLessThanOrEqual(3);
    await library
      .getByRole("link", { name: "図書館をもっと見る", exact: true })
      .click();
    await expect(page).toHaveURL(/category=library/);
    await expect(page).toHaveURL(/cursor=/);
    await expect(page.locator("article")).toHaveCount(30);
    const after = await page
      .locator("article")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-labelledby")),
      );
    expect(after.every((id) => !before.includes(id))).toBe(true);
  } finally {
    await context.close();
  }
});
