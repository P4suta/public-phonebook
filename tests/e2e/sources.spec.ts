import { type Download, expect, test } from "@playwright/test";
import { backToResults, openSource, publisherLabel } from "./support.js";

test("source details explain the contact and publication without downloading", async ({
  page,
}) => {
  const downloads: string[] = [];
  page.on("download", (file: Download): void => {
    downloads.push(file.suggestedFilename());
  });
  await page.goto("/?prefecture=13&category=medical");
  await page.getByRole("link", { name: "くわしく", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "公式サイトを 開く", exact: true }),
  ).toHaveAttribute("href", "https://example.com/official");
  await page
    .getByRole("link", { name: "この番号の出典を見る", exact: true })
    .click();
  await expect(page).toHaveURL(/\/contacts\/13:medical\/source\?/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Public Phonebook",
  );
  await expect(
    page.getByRole("heading", { name: "この番号の出典", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: publisherLabel("medical"), exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "公開元のページを見る", exact: true }),
  ).toHaveAttribute("href", "https://example.com/provider-list");
  await expect(
    page.getByRole("link", { name: "元のファイルを開く（XLSX）", exact: true }),
  ).toHaveAttribute("href", "https://example.com/providers.xlsx");
  await expect(page.getByText("2026-10-01", { exact: true })).toBeVisible();
  await expect(page.getByText("2026-10-29", { exact: true })).toBeVisible();
  expect(downloads).toEqual([]);
  await backToResults(page);
  await expect(page.getByLabel("都道府県", { exact: true })).toHaveValue("13");
  await expect(page.getByLabel("種類", { exact: true })).toHaveValue("medical");
  await expect(page.locator(".contact")).toHaveCount(1);
});

test("contact and source pages preserve escaped names and reject unsafe official links", async ({
  page,
}, info) => {
  await page.goto("/?q=試験");
  await page.getByRole("link", { name: "くわしく", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "試験歯科 <script> & Test, clinic",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("script")).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(
    page.getByText("元の資料に公式サイトの記載はありません。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "公式サイトを 開く", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('a.phone[href="tel:+819012345678"]')).toBeVisible();
  await page
    .getByRole("link", { name: "この番号の出典を見る", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "試験歯科 <script> & Test, clinic",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("source-details.png"),
    fullPage: true,
  });
});

test("source explanations cover medical, municipal and prefectural records", async ({
  page,
}) => {
  for (const category of [
    "medical",
    "municipal_office",
    "prefectural_office",
  ]) {
    await page.goto(`/contacts/13:${category}/source`);
    await expect(
      page.getByRole("heading", {
        name: publisherLabel(category),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "CC0-1.0", exact: true }),
    ).toHaveAttribute(
      "href",
      "https://creativecommons.org/publicdomain/zero/1.0/",
    );
    await page
      .getByRole("link", { name: "連絡先に もどる", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "連絡先に保存", exact: true }),
    ).toHaveAttribute("href", `/contacts/13:${category}.vcf`);
  }
  await page.goto("/?prefecture=13&category=medical");
  await openSource(page);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        (): boolean =>
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("link", {
        name: "元のファイルを開く（XLSX）",
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.getByRole("link", { name: "データと出典", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "入っているデータ", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: "都道府県・種類別の件数（JSON）",
      exact: true,
    }),
  ).toHaveAttribute("href", "/coverage.json");
});
