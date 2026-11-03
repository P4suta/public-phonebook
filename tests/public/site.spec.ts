import AxeBuilder from "@axe-core/playwright";
import * as v from "valibot";
import {
  DatasetManifestSchema,
  SearchResponseSchema,
} from "../../src/core/models.ts";
import { checkedFetch } from "../../tools/public-request.ts";
import { auditDesign } from "../browser/design-policy.ts";
import { expect, test } from "./fixtures.ts";

test("published search, telephone normalization, detail, and source navigation work", async ({
  page,
}) => {
  const found = v.parse(
    SearchResponseSchema,
    await (await checkedFetch("/api/contacts?q=高知大学&limit=1")).json(),
  );
  const contact = found.data[0];
  if (!contact) throw new Error("The national verification contact is missing");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill("高知大学");
  const contactLabel = `${contact.name}の情報を見る`;
  const card = page.getByRole("article", { name: contactLabel, exact: true });
  await expect(card).toBeVisible();
  await expect(card.locator("[data-phone] > span").first()).toHaveText(
    "088-844-0111",
  );
  await expect(card.locator('a[href="tel:+81888440111"]')).toBeVisible();
  expect((await auditDesign(page)).violations).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await card.getByRole("link", { name: contactLabel, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: contact.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "電話帳に入れる", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.waitForLoadState("load");
  await page.goto(`/contacts/${encodeURIComponent(contact.id)}/source`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect((await auditDesign(page)).violations).toEqual([]);
});

test("the published data page lists the complete files and reads the site routes under the live security policy", async ({
  page,
}) => {
  const manifest = v.parse(
    DatasetManifestSchema,
    await (await checkedFetch("/api/datasets")).json(),
  );
  await page.goto("/data");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  for (const file of manifest.files)
    await expect(
      page.getByRole("link", {
        name: `${file.file}をダウンロードする`,
        exact: true,
      }),
    ).toHaveAttribute("href", file.url);
  expect(
    await page.evaluate(
      async () => (await fetch("/api/catalog", { credentials: "omit" })).status,
    ),
  ).toBe(200);
  expect((await auditDesign(page)).violations).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
