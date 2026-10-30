import { expect, test } from "./fixtures.ts";

test("initial screen is empty and its content is centered", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Public Phonebook", exact: true }),
  ).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.locator("header, footer")).toHaveCount(0);
  await expect(page.getByLabel("市区町村", { exact: true })).toHaveCount(0);
  const box = await page.locator("main > div").boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (box && viewport)
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(
      2,
    );
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
  test(`clearing the query restores the centered initial screen and keeps focus with motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/");
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
    const bounds = await page.locator("main > div").boundingBox();
    const viewport = page.viewportSize();
    if (!bounds || !viewport) throw new Error("The search layout is missing");
    expect(
      Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2),
    ).toBeLessThan(2);
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
