import type { Page } from "@playwright/test";
import { foundation } from "../../src/ui/foundations.ts";
import { expect, test } from "./fixtures.ts";

const centerTolerance = 2;
const edgeTolerance = 1;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function initialLayout(page: Page): Promise<{
  readonly heading: Box;
  readonly link: Box;
  readonly label: Box;
  readonly hint: Box;
  readonly field: Box;
  readonly filters: Box;
  readonly padding: number;
  readonly scrollable: boolean;
}> {
  const box = async (locator: ReturnType<Page["locator"]>): Promise<Box> => {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error("An initial-screen element is hidden");
    return bounds;
  };
  const searchbox = page.getByRole("searchbox");
  return {
    heading: await box(
      page.getByRole("heading", { name: "Public Phonebook", exact: true }),
    ),
    link: await box(
      page
        .getByRole("navigation", { name: "サービスの情報" })
        .getByRole("link"),
    ),
    label: await box(page.locator('label[for="directory-search"]')),
    hint: await box(page.locator("#directory-search-hint")),
    field: await box(searchbox.locator("..")),
    filters: await box(page.locator("[data-has-city]")),
    padding: await page
      .locator("main")
      .evaluate((main) => Number.parseFloat(getComputedStyle(main).paddingTop)),
    scrollable: await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  };
}

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 900 },
])
  test(`the initial screen centers the search field at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    await expect(page.locator("article")).toHaveCount(0);
    await expect(page.locator("header, footer")).toHaveCount(0);
    await expect(page.getByRole("search")).toHaveCount(1);
    await expect(page.getByLabel("市区町村", { exact: true })).toHaveCount(0);
    const layout = await initialLayout(page);
    expect(layout.scrollable).toBe(false);
    expect(
      Math.abs(layout.field.y + layout.field.height / 2 - size.height / 2),
    ).toBeLessThan(centerTolerance);
    expect(layout.padding).toBe(foundation.space["24"]);
    expect(Math.abs(layout.heading.y - layout.padding)).toBeLessThan(
      edgeTolerance,
    );
    for (const item of [layout.link, layout.label, layout.field])
      expect(Math.abs(item.x - layout.heading.x)).toBeLessThan(edgeTolerance);
    expect(
      Math.abs(
        layout.link.y -
          (layout.heading.y + layout.heading.height) -
          foundation.space["16"],
      ),
    ).toBeLessThan(edgeTolerance);
    expect(
      Math.abs(
        layout.field.y -
          (layout.hint.y + layout.hint.height) -
          foundation.space["8"],
      ),
    ).toBeLessThan(edgeTolerance);
    expect(
      Math.abs(
        layout.filters.y -
          (layout.field.y + layout.field.height) -
          foundation.space["24"],
      ),
    ).toBeLessThan(edgeTolerance);
    expect(layout.label.y).toBeGreaterThanOrEqual(
      layout.link.y + layout.link.height + foundation.space["48"],
    );
  });

for (const size of [
  { width: 320, height: 480 },
  { width: 1440, height: 400 },
])
  test(`a short viewport keeps the initial screen in reading order at ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    const layout = await initialLayout(page);
    expect(layout.scrollable).toBe(false);
    expect(Math.abs(layout.heading.y - layout.padding)).toBeLessThan(
      edgeTolerance,
    );
    const order = [
      [layout.heading, layout.link, foundation.space["16"]],
      [layout.link, layout.label, foundation.space["48"]],
      [layout.label, layout.hint, foundation.space["8"]],
      [layout.hint, layout.field, foundation.space["8"]],
      [layout.field, layout.filters, foundation.space["24"]],
    ] as const;
    for (const [above, below, gap] of order)
      expect(Math.abs(below.y - (above.y + above.height) - gap)).toBeLessThan(
        edgeTolerance,
      );
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight),
    ).toBeGreaterThanOrEqual(layout.filters.y + layout.filters.height);
  });

test("typing searches, exact names rank first, and contact actions work", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("searchbox").fill("国立国会図書館");
  const first = page.locator("article").first();
  await expect(first.getByRole("heading")).toHaveText("国立国会図書館");
  await expect(first.getByText("03-3581-2331", { exact: true })).toBeVisible();
  await expect(
    first.getByRole("link", {
      name: "03-3581-2331に電話をかける",
      exact: true,
    }),
  ).toHaveAttribute("href", "tel:+81335812331");
  await expect(
    first.getByRole("link", { name: /の地図を開く（新しいタブ）$/u }),
  ).toHaveAttribute("href", /google\.com\/maps\/search/);
  await first
    .getByRole("link", { name: "国立国会図書館の情報を見る", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "電話番号のもとの情報", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "電話帳に入れる" }),
  ).toHaveAttribute("href", /contact\.vcf$/);
  await page.getByRole("link", { name: "電話番号のもとの情報を見る" }).click();
  await expect(
    page.getByRole("link", { name: "もとの資料を開く" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "施設の情報にもどる" }).click();
  await page.getByRole("link", { name: "検索結果にもどる" }).click();
  await expect(page.getByRole("searchbox")).toHaveValue("国立国会図書館");
});

test("municipalities belong to the chosen prefecture and reset on change", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("都道府県", { exact: true }).selectOption("13");
  const cities = page.getByLabel("市区町村", { exact: true });
  await expect(cities).toBeVisible();
  const values = await cities
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => option.getAttribute("value") ?? ""),
    );
  expect(values.every((value) => value === "" || value.startsWith("13"))).toBe(
    true,
  );
  await cities.selectOption("13101");
  await page.getByLabel("都道府県", { exact: true }).selectOption("14");
  await expect(cities).toHaveValue("");
  await page.getByLabel("都道府県", { exact: true }).selectOption("");
  await expect(cities).toHaveCount(0);
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`clearing the query restores the initial layout and keeps focus with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    const initial = await initialLayout(page);
    const input = page.getByRole("searchbox");
    const original = await input.elementHandle();
    if (!original) throw new Error("The search input is missing");
    await input.fill("国立国会図書館");
    await expect(
      page.locator("article").first().getByRole("heading"),
    ).toHaveText("国立国会図書館");
    await expect(
      page.getByRole("link", { name: "はじめの画面", exact: true }),
    ).toHaveCount(0);
    await input.fill("");
    await expect(page).toHaveURL("/");
    await expect(page.locator("article")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Public Phonebook", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "サービスの情報" }),
    ).toBeVisible();
    expect(
      await original.evaluate(
        (node) => node.isConnected && document.activeElement === node,
      ),
    ).toBe(true);
    expect(await initialLayout(page)).toEqual(initial);
    expect(
      await page
        .locator("main")
        .evaluate((node) => node.getAnimations({ subtree: true }).length),
    ).toBe(0);
    await input.fill("国立");
    await expect(page.locator("article").first()).toBeVisible();
    expect(
      await original.evaluate(
        (node) => node.isConnected && document.activeElement === node,
      ),
    ).toBe(true);
  });
}

test("clearing text keeps explicit filters until all conditions are empty", async ({
  page,
}) => {
  await page.goto("/?q=国立国会図書館&prefecture=13&category=library");
  await page.getByRole("searchbox").fill("");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await expect(page.getByLabel("都道府県", { exact: true })).toHaveValue("13");
  await expect(
    page.getByLabel("施設や窓口の種類", { exact: true }),
  ).toHaveValue("library");
  await expect(
    page.getByRole("heading", { name: "検索結果", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Public Phonebook", exact: true }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/q=/);
  await page.getByLabel("都道府県", { exact: true }).selectOption("");
  await expect(
    page.getByRole("heading", { name: "検索結果", exact: true }),
  ).toHaveCount(1);
  await page.getByLabel("施設や窓口の種類", { exact: true }).selectOption("");
  await expect(page).toHaveURL("/");
  await expect(
    page.getByRole("heading", { name: "Public Phonebook", exact: true }),
  ).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});
