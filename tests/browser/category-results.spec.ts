import AxeBuilder from "@axe-core/playwright";
import * as v from "valibot";
import { GroupedSearchResponseSchema } from "../../src/core/models.ts";
import { expect, test } from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

test("exact facility names lead fixed, disjoint category groups", async ({
  page,
}) => {
  await page.goto("/?q=高知大学");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await expect(page.locator("article")).toHaveCount(7);
  const primary = page.locator("[data-primary-results] article");
  await expect(primary).toHaveCount(1);
  await expect(primary.getByRole("heading", { level: 2 })).toHaveText(
    "高知大学",
  );
  await expect(primary.locator("[data-phone] > span").first()).toHaveText(
    "088-844-0111",
  );
  const groups = page.locator("[data-result-category]");
  expect(
    await groups.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-result-category")),
    ),
  ).toEqual([
    "medical",
    "unlicensed_childcare",
    "workplace_childcare",
    "library",
  ]);
  await expect(
    page.locator('[data-result-category="library"] article'),
  ).toHaveCount(3);
  await expect(groups.locator("article h2, article p")).toHaveCount(0);
  await expect(groups.locator("article h3")).toHaveCount(6);
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
  await expect(
    page.getByLabel("施設や窓口の種類", { exact: true }),
  ).toHaveValue("");
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
