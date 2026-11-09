import AxeBuilder from "@axe-core/playwright";
import { uiCopy } from "../../src/ui/copy.ts";
import { serviceInformation } from "../../src/ui/service-information.ts";
import { auditDesign } from "./design-policy.ts";
import { expect, test } from "./fixtures.ts";
import { knownContact } from "./known-contact.ts";

test("the initial screen explains reading search and offers one project-information action", async ({
  page,
}) => {
  await page.goto("/");
  const searchbox = page.getByRole("searchbox");
  await expect(searchbox).not.toHaveAttribute("placeholder");
  await expect(searchbox).toHaveAccessibleName("施設の名前");
  await expect(searchbox).toHaveAccessibleDescription(uiCopy.search.readings);
  await expect(
    page.getByText(uiCopy.search.readings, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/名前の一部でも/u)).toHaveCount(0);
  await expect(page.getByText("施設の名前", { exact: true })).toBeVisible();
  await expect(searchbox).toHaveAttribute("enterkeyhint", "search");
  await expect(
    page.getByRole("button", { name: "電話番号をさがす", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  const navigation = page.getByRole("navigation", { name: "サービスの情報" });
  await expect(navigation.getByRole("link")).toHaveCount(1);
  const link = navigation.getByRole("link", {
    name: "Public Phonebookについてくわしく知る",
    exact: true,
  });
  const [box, heading, label] = await Promise.all(
    [
      link,
      page.getByRole("heading", { level: 1 }),
      page.getByText("施設の名前", { exact: true }),
    ].map(async (item) => item.boundingBox()),
  );
  if (!box || !heading || !label)
    throw new Error("The project information action is missing");
  expect(Math.abs(box.x - heading.x)).toBeLessThan(1);
  expect(Math.abs(box.x - label.x)).toBeLessThan(1);
  expect(box.y).toBeGreaterThan(heading.y + heading.height);
  expect(box.y + box.height).toBeLessThan(label.y);
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
  await expect(page.getByRole("link", { name: /API/u })).toHaveCount(0);
  await page
    .getByRole("link", { name: "さがす画面にもどる", exact: true })
    .click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

test("the about page describes search with the iPhone app's sentence at every width", async ({
  page,
}) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/about");
    await expect(
      page.getByText("検索欄に施設の名前を入れます。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/候補が出ます|電話番号でも/u)).toHaveCount(0);
  }
});

test("each page action leads with its own icon", async ({ page, request }) => {
  const contact = `/contacts/${encodeURIComponent((await knownContact(request)).id)}`;
  const actions = [
    ["/about", "データについてくわしく知る", "database"],
    ["/about", "プライバシーについて読む", "shield-check"],
    ["/about", "さがす画面にもどる", "arrow-left"],
    ["/data", "contacts.csv.gzをダウンロードする", "download"],
    ["/support", "開発者にメールを送る", "mail"],
    [contact, uiCopy.sourceAction, "file-search"],
    [contact, "電話帳に入れる", "book-user"],
    [`${contact}/source`, "開発者向けの記録を見る", "file-braces"],
  ] as const;
  for (const [path, name, icon] of actions) {
    await page.goto(path);
    await expect(
      page.getByRole("link", { name, exact: true }).locator("svg").first(),
      `${path} ${name}`,
    ).toHaveAttribute("data-icon", icon);
  }
});

for (const width of [320, 1440])
  test(`privacy and support are readable, accessible and navigable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const information of serviceInformation) {
      await page.goto(`/${information.key}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `Public Phonebookの${information.title}`,
      );
      for (const section of information.sections)
        await expect(
          page.getByRole("heading", {
            level: 2,
            name: section.title,
            exact: true,
          }),
        ).toBeVisible();
      for (const link of information.links)
        await expect(page.locator(`a[href="${link.href}"]`)).toBeVisible();
      expect((await auditDesign(page)).violations).toEqual([]);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.goto("/about");
    await page
      .getByRole("link", { name: "プライバシーについて読む", exact: true })
      .click();
    await expect(page).toHaveURL("/privacy");
    await page
      .getByRole("link", {
        name: "使い方と、声を伝える方法を見る",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL("/support");
  });
