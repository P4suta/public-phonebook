import { expect, test } from "./fixtures.ts";

test("the initial screen gives a complete instruction and one project-information action", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("searchbox")).toHaveAttribute(
    "placeholder",
    "名前を入れてください",
  );
  await expect(page.getByRole("searchbox")).toHaveAccessibleName(
    "施設や窓口の名前",
  );
  await expect(
    page.getByLabel("都道府県", { exact: true }).locator("option").first(),
  ).toHaveText("都道府県をえらばない");
  await expect(
    page
      .getByLabel("施設や窓口の種類", { exact: true })
      .locator("option")
      .first(),
  ).toHaveText("種類をえらばない");
  const navigation = page.getByRole("navigation", { name: "サービスの情報" });
  await expect(navigation.getByRole("link")).toHaveCount(1);
  const link = navigation.getByRole("link", {
    name: "Public Phonebookについてくわしく知る",
    exact: true,
  });
  const box = await link.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport)
    throw new Error("The project information action is missing");
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(1);
  await link.click();
  await expect(page).toHaveURL("/about");
  await expect(
    page.getByRole("heading", {
      name: "Public Phonebookについて",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "データについてくわしく知る", exact: true }),
  ).toHaveAttribute("href", "/data");
  await expect(
    page.getByRole("link", { name: "APIの使い方を見る", exact: true }),
  ).toHaveAttribute("href", "/developers");
  await page
    .getByRole("link", { name: "さがす画面にもどる", exact: true })
    .click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
});
