import { expect, test } from "@playwright/test";
import {
  backToResults,
  categoryLabel,
  contacts,
  contents,
  download,
  openSource,
  publisherLabel,
  serviceCategories,
} from "./support.js";

const additions = [
  ["nursing_care", "Nursing care", "Ministry of Health, Labour and Welfare"],
  ["disability_support", "Disability support", "WAM NET"],
  ["library", "Library", "National Diet Library"],
  ["museum", "Museum", "National Diet Library"],
  ["archive", "Archive", "National Diet Library"],
  ...serviceCategories,
] as const;

test("additional contact categories support combined filters and complete exports", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const [category, , publisher] of additions) {
    await page.goto("/");
    await page.getByLabel("都道府県", { exact: true }).selectOption("13");
    await page.getByLabel("種類", { exact: true }).selectOption(category);
    await page.getByRole("button", { name: "さがす" }).click();
    await expect(page.locator(".contact")).toHaveCount(1);
    await expect(page.locator(".tags")).toContainText(categoryLabel(category));
    const records = contacts(await contents(await download(page, "JSON ↓")));
    expect(records).toHaveLength(1);
    expect(records[0]?.category).toBe(category);
    expect(records[0]?.prefecture_code).toBe("13");
    expect(records[0]?.attribution).toContain(publisher);
  }
});

test("each added category explains its publisher before opening an original file", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const downloads: string[] = [];
  page.on("download", (file): void => {
    downloads.push(file.suggestedFilename());
  });
  for (const [category] of additions) {
    await page.goto(`/?prefecture=13&category=${category}`);
    await openSource(page);
    await expect(
      page.getByText(publisherLabel(category), { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "公開元のページを見る", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "元のファイルを開く（XLSX）",
        exact: true,
      }),
    ).toBeVisible();
    await backToResults(page);
    await expect(page.getByLabel("種類", { exact: true })).toHaveValue(
      category,
    );
  }
  expect(downloads).toEqual([]);
});
