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
  const detailLabel = `${contact.name}の住所などを見る`;
  const card = page.getByRole("article", { name: contact.name, exact: true });
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
  await card.getByRole("link", { name: detailLabel, exact: true }).click();
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

test("the published reference sends requests under the live security policy", async ({
  page,
}) => {
  await page.goto("/developers#searchContacts");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const operation = page.locator("section#searchContacts");
  await expect(operation).toBeInViewport();
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/contacts",
  );
  await operation
    .getByRole("button", {
      name: "リクエストを試す（GET /api/contacts）",
      exact: true,
    })
    .click();
  expect((await sent).status()).toBe(200);
  await expect(
    operation.locator("#searchContacts-response").getByRole("status"),
  ).toHaveText("応答：200 成功");
  expect((await auditDesign(page)).violations).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
