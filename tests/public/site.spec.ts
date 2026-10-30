import AxeBuilder from "@axe-core/playwright";
import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
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
  await page.goto(`/contacts/${encodeURIComponent(contact.id)}/source`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect((await auditDesign(page)).violations).toEqual([]);
});

test("the published Scalar client sends requests under the live security policy", async ({
  page,
}) => {
  await page.goto("/developers");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  if ((page.viewportSize()?.width ?? 1440) < 1024)
    await page
      .getByRole("button", { name: "APIの一覧を開く", exact: true })
      .click();
  const summary =
    "Search facilities by name, telephone number, category, and region";
  await page
    .getByRole("link", { name: `${summary} HTTPメソッド: GET`, exact: true })
    .click();
  await page
    .getByRole("region", { name: summary, exact: true })
    .getByRole("button", {
      name: "リクエストを試す (get /api/contacts)",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/contacts",
  );
  await dialog
    .getByRole("button", { name: "リクエストを送信（get）", exact: true })
    .click();
  expect((await sent).status()).toBe(200);
  await expect(
    dialog.getByRole("region", { name: "応答", exact: true }),
  ).toContainText("200");
  expect((await auditDesign(page)).violations).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await dialog
    .getByRole("button", { name: "APIを試す画面を閉じる", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
});
