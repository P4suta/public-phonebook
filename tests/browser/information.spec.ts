import AxeBuilder from "@axe-core/playwright";
import { referenceCopy } from "../../src/ui/api-reference-copy.ts";
import { uiCopy } from "../../src/ui/copy.ts";
import { serviceInformation } from "../../src/ui/service-information.ts";
import { auditDesign } from "./design-policy.ts";
import { expect, test } from "./fixtures.ts";
import { knownContact } from "./known-contact.ts";

test("the initial screen gives a complete instruction and one project-information action", async ({
  page,
}) => {
  await page.goto("/");
  const searchbox = page.getByRole("searchbox");
  await expect(searchbox).not.toHaveAttribute("placeholder");
  await expect(searchbox).toHaveAccessibleName("施設や窓口の名前");
  await expect(searchbox).toHaveAccessibleDescription(
    "病院や役所、学校などの名前を入れてください。 名前の一部でも、さがせます。",
  );
  await expect(
    page.getByText("施設や窓口の名前", { exact: true }),
  ).toBeVisible();
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
      page.getByText("施設や窓口の名前", { exact: true }),
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
  await expect(
    page.getByRole("link", { name: "APIの使い方を見る", exact: true }),
  ).toHaveAttribute("href", "/developers");
  await page
    .getByRole("link", { name: "さがす画面にもどる", exact: true })
    .click();
  await expect(page.getByRole("searchbox")).toHaveValue("");
});

test("each page action leads with its own icon", async ({ page, request }) => {
  const contact = `/contacts/${encodeURIComponent((await knownContact(request)).id)}`;
  const actions = [
    ["/about", "データについてくわしく知る", "database"],
    ["/about", "APIの使い方を見る", "code"],
    ["/about", "プライバシーについて読む", "shield-check"],
    ["/about", "さがす画面にもどる", "arrow-left"],
    ["/support", "開発者にメールを送る", "mail"],
    ["/developers", referenceCopy.openapi, "file-braces"],
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
  await page.goto("/developers");
  await expect(
    page
      .getByRole("button", {
        name: `${referenceCopy.attempt.submit}（GET /api/contacts）`,
        exact: true,
      })
      .locator("svg")
      .first(),
  ).toHaveAttribute("data-icon", "send");
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
