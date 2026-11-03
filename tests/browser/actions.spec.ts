import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import { expect, test } from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

const knownAddress = "東京都千代田区永田町1-10-1";

test("the detail page's map opens in a new tab after confirmation and preserves the current page", async ({
  page,
  context,
}) => {
  await context.route("https://www.google.com/maps/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<title>Map destination</title>",
    });
  });
  const raw: unknown = await (
    await page.request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const contact = v.parse(SearchResponseSchema, raw).data[0];
  if (!contact) throw new Error("Known map fixture missing");
  await page.goto(`/contacts/${encodeURIComponent(contact.id)}`);
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const before = page.url();
  const card = page.locator("article").first();
  await expect(
    card.getByRole("heading", { level: 2, name: "住所", exact: true }),
  ).toBeVisible();
  const address = card.getByText(knownAddress, { exact: true });
  await expect(address).toBeVisible();
  expect(
    await address.evaluate((node) => node.closest("a, button") === null),
  ).toBe(true);
  await expect(address.locator("svg")).toHaveCount(0);
  expect(
    await address.evaluate((node) => getComputedStyle(node).textDecorationLine),
  ).toBe("none");
  const map = card.getByRole("link", {
    name: `${contact.name}の地図を見る（新しいタブ）`,
    exact: true,
  });
  await expect(map).toHaveText("地図で見る");
  await expect(map.locator("svg").first()).toHaveAttribute(
    "data-icon",
    "map-pin",
  );
  await map.click();
  const popupEvent = page.waitForEvent("popup");
  await page
    .getByRole("dialog", { name: "ほかのサイトを開きます" })
    .getByRole("button", { name: "開く", exact: true })
    .click();
  const popup = await popupEvent;
  await popup.waitForLoadState("domcontentloaded");
  expect(new URL(popup.url()).searchParams.get("query")).toBe(
    `${contact.name},${knownAddress}`,
  );
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(page.url()).toBe(before);
  await expect(card).toBeVisible();
  await popup.close();
});

test("result cards and the detail page offer no copy control", async ({
  page,
}) => {
  await page.goto("/?q=国立国会図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const card = page.locator("article").first();
  await expect(card.locator("[data-phone]").first()).toHaveText("03-3581-2331");
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(page.locator("main").getByText(/コピー/u)).toHaveCount(0);
  await card
    .getByRole("link", { name: "国立国会図書館の住所などを見る", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "国立国会図書館" }),
  ).toBeVisible();
  const main = page.locator("main");
  await expect(main.getByText(/コピー/u)).toHaveCount(0);
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByRole("status")).toHaveCount(0);
  await expect(main.locator("[data-phone]").first()).toHaveText("03-3581-2331");
  expect(
    await main
      .locator("[data-phone]")
      .first()
      .evaluate((node) => node.closest("a, button") === null),
  ).toBe(true);
});
