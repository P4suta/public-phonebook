import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function manualLoading(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", { value: undefined });
  });
}

test("additional result loading keeps existing records and offers recovery after a failed request", async ({
  page,
}, info) => {
  await manualLoading(page);
  let attempts = 0;
  await page.route("**/internal/search?**", async (route) => {
    attempts += 1;
    if (attempts === 1)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"busy"}',
      });
    else await route.continue();
  });
  await page.goto("/");
  await expect(page.locator(".contact")).toHaveCount(50);
  await page.getByRole("button", { name: "つづきを表示", exact: true }).click();
  await expect(page.locator("#feed-error")).toBeVisible();
  await expect(page.locator(".contact")).toHaveCount(50);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page
    .locator("#feed-error")
    .screenshot({ path: info.outputPath("additional-results-recovery.png") });
  await page.getByRole("button", { name: "もう一度 読みこむ" }).click();
  await expect(page.locator(".contact")).toHaveCount(100);
  await expect(page.locator("#feed-error")).toBeHidden();
  const ids = await page
    .locator(".contact")
    .evaluateAll((nodes): (string | null)[] =>
      nodes.map((node) => node.getAttribute("data-contact-id")),
    );
  expect(new Set(ids).size).toBe(100);
});

test("results never append records from a different snapshot", async ({
  page,
}) => {
  await manualLoading(page);
  await page.route("**/internal/search?**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "x-public-phonebook-snapshot": "0".repeat(64),
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "つづきを表示", exact: true }).click();
  await expect(page.locator("#feed-error")).toBeVisible();
  await expect(page.locator("#feed-error-message")).toContainText("更新");
  await expect(page.locator(".contact")).toHaveCount(50);
});

test("changing prefecture immediately refreshes municipality choices and clears the previous selection", async ({
  page,
}) => {
  await page.goto("/?prefecture=13&municipality=13001&category=medical");
  const municipality = page.getByLabel("市区町村", { exact: true });
  await expect(municipality).toHaveValue("13001");
  await page.getByLabel("都道府県", { exact: true }).selectOption("14");
  await expect(municipality).toHaveValue("");
  await expect(municipality.locator('option[value="14001"]')).toHaveCount(1);
  await expect(municipality.locator('option[value="13001"]')).toHaveCount(0);
  await municipality.selectOption("14001");
  await page.getByRole("button", { name: "さがす", exact: true }).click();
  await expect(page.locator(".contact")).toHaveCount(1);
  await expect(page.locator(".tags")).toContainText("Test prefecture 14");
  await expect(page.getByLabel("市区町村", { exact: true })).toHaveValue(
    "14001",
  );
  await page.getByLabel("都道府県", { exact: true }).selectOption("13");
  await expect(page.getByLabel("市区町村", { exact: true })).toHaveValue("");
  await expect(
    page
      .getByLabel("市区町村", { exact: true })
      .locator('option[value="13001"]'),
  ).toHaveCount(1);
});

test("scrolling loads the next page without changing the current search", async ({
  page,
}) => {
  await page.goto("/?category=library");
  await expect(page.locator(".contact")).toHaveCount(47);
  await page.goto("/");
  await expect(page.locator(".contact")).toHaveCount(50);
  await page.locator(".contact").nth(49).scrollIntoViewIfNeeded();
  await expect(page.locator(".contact")).toHaveCount(100);
  await expect(page).toHaveURL(/\/$/);
});

test("restored pages resume automatic loading after every page lifecycle", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Native = window.IntersectionObserver;
    class Observed extends Native {
      override observe(target: Element): void {
        const root = document.documentElement;
        root.dataset.observations = String(
          Number(root.dataset.observations ?? "0") + 1,
        );
        super.observe(target);
      }
    }
    Object.defineProperty(window, "IntersectionObserver", { value: Observed });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-observations", "1");
  for (const count of [2, 3]) {
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-observations",
      String(count),
    );
  }
  await page.locator(".contact").nth(49).scrollIntoViewIfNeeded();
  await expect(page.locator(".contact")).toHaveCount(100);
});

test("search, pagination and contact navigation work with JavaScript disabled", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("Missing test origin");
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const original = await page
      .locator(".contact")
      .first()
      .getAttribute("data-contact-id");
    await page.getByRole("link", { name: "次の50件", exact: true }).click();
    await expect(page.locator(".contact")).toHaveCount(50);
    expect(
      await page.locator(".contact").first().getAttribute("data-contact-id"),
    ).not.toBe(original);
    await page
      .getByRole("link", { name: "くわしく", exact: true })
      .first()
      .click();
    await page
      .getByRole("link", { name: "この番号の出典を見る", exact: true })
      .click();
    await page
      .getByRole("link", { name: "連絡先に もどる", exact: true })
      .click();
    await page
      .getByRole("link", { name: "結果に もどる", exact: true })
      .click();
    await expect(page).toHaveURL(/page=2/);
    await page.getByLabel("施設名か電話番号").fill("試験");
    await page.getByRole("button", { name: "さがす", exact: true }).click();
    await expect(page.locator(".contact")).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("malformed and duplicate result pages cannot partly modify the displayed records", async ({
  page,
}) => {
  await manualLoading(page);
  let attempt = 0;
  await page.route("**/internal/search?**", async (route) => {
    const response = await route.fetch();
    const raw: unknown = await response.json();
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("html" in raw) ||
      typeof raw.html !== "string"
    )
      throw new Error("Missing fixture feed");
    attempt += 1;
    const html = raw.html.replaceAll(
      /data-contact-id="[^"]+"/g,
      'data-contact-id="duplicate"',
    );
    await route.fulfill({
      response,
      json: attempt === 1 ? { ...raw, page: 999 } : { ...raw, html },
    });
  });
  await page.goto("/");
  const ids = await page
    .locator(".contact")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-contact-id")),
    );
  await page.getByRole("button", { name: "つづきを表示", exact: true }).click();
  await expect(page.locator("#feed-error")).toBeVisible();
  await page.getByRole("button", { name: "もう一度 読みこむ" }).click();
  await expect.poll(() => attempt).toBe(2);
  await expect(page.locator("#feed-retry")).toBeEnabled();
  expect(
    await page
      .locator(".contact")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-contact-id")),
      ),
  ).toEqual(ids);
});

test("all Figma screen states fit narrow and wide layouts and pass accessibility checks", async ({
  page,
}, info) => {
  await manualLoading(page);
  const paths = [
    "/?category=library",
    "/contacts/13:library",
    "/contacts/13:library/source",
    "/?q=missing",
    "/?prefecture=48",
    "/missing",
    "/data",
  ];
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [index, path] of paths.entries()) {
      if (!path) throw new Error("Missing screen path");
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect(
        result.violations.map((value) => ({
          id: value.id,
          targets: value.nodes.map((node) => node.target),
        })),
      ).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`screen-${index}-${width}.png`),
        fullPage: true,
      });
    }
  }
});

test("Figma icons retain their source geometry and the font loads locally", async ({
  page,
}) => {
  for (const path of [
    "/?category=library",
    "/?category=museum",
    "/?category=archive",
    "/contacts/13:medical",
    "/contacts/13:medical/source",
    "/data",
  ]) {
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    const icons = await page.locator("img.icon").evaluateAll((nodes) =>
      nodes.map((node) => {
        if (!(node instanceof HTMLImageElement))
          throw new Error("Invalid icon");
        const rect = node.getBoundingClientRect();
        return {
          src: node.getAttribute("src"),
          loaded: node.complete && node.naturalWidth > 0,
          natural: [node.naturalWidth, node.naturalHeight],
          declared: [
            Number(node.getAttribute("width")),
            Number(node.getAttribute("height")),
          ],
          rendered: [rect.width, rect.height],
        };
      }),
    );
    for (const icon of icons) {
      expect(icon.loaded, icon.src ?? "Missing icon").toBe(true);
      expect(icon.declared).toEqual(icon.natural);
      if (icon.rendered[0] !== 0) expect(icon.rendered).toEqual(icon.natural);
    }
    expect(
      await page.evaluate(() =>
        Array.from(document.fonts).some(
          (face) =>
            face.family.includes("Noto Sans JP") && face.status === "loaded",
        ),
      ),
    ).toBe(true);
  }
});
