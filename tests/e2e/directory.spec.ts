import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { parse } from "csv-parse/sync";
import {
  array,
  categories,
  checkCards,
  contacts,
  contents,
  coverage,
  download,
  fixtureContacts,
  fixturePages,
  object,
  string,
} from "./support.js";

test("national selectors, page size, metadata and sources agree", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: `${fixtureContacts.toLocaleString("ja-JP")} 件`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".contact")).toHaveCount(50);
  await expect(page.getByLabel("都道府県").locator("option")).toHaveCount(48);
  await expect(page.getByLabel("市区町村").locator("option")).toHaveCount(48);
  const report = coverage(await (await request.get("/coverage.json")).json());
  expect(report.complete).toBe(true);
  expect(report.prefectures_covered).toBe(47);
  expect(report.cells).toHaveLength(fixtureContacts);
  await expect(page.getByLabel("種類").locator("option")).toHaveCount(
    categories.length + 1,
  );
  expect(report.unique_phone_numbers).toBe(2);
  expect(report.cells.every((cell) => cell.contacts === 1)).toBe(true);
  await page
    .getByRole("link", { name: "くわしく", exact: true })
    .first()
    .click();
  await page
    .getByRole("link", { name: "この番号の出典を見る", exact: true })
    .click();
  await expect(page.getByText("2026-10-01", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "CC0-1.0", exact: true }),
  ).toBeVisible();
});

test("category, prefecture and municipality filters combine", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("種類").selectOption("medical");
  await page.getByRole("button", { name: "さがす" }).click();
  await expect(
    page.getByRole("heading", { name: "47 件", exact: true }),
  ).toBeVisible();
  await page.getByLabel("都道府県").selectOption("13");
  await page.getByText("市区町村で絞る", { exact: true }).click();
  await page.getByLabel("市区町村").selectOption("13001");
  await page.getByRole("button", { name: "さがす" }).click();
  await expect(
    page.getByRole("heading", { name: "1 件", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".tags")).toContainText("病院・診療所");
  await expect(page.locator(".tags")).toContainText("Test prefecture 13");
  await expect(page.getByLabel("都道府県")).toHaveValue("13");
  await expect(page.getByLabel("市区町村")).toHaveValue("13001");
});

test("names support Japanese substrings and NFKC case folding", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("施設名か電話番号").fill("ＴＥＳＴ");
  await page.getByRole("button", { name: "さがす" }).click();
  await expect(
    page.getByRole("heading", {
      name: `${fixtureContacts.toLocaleString("ja-JP")} 件`,
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("施設名か電話番号").fill("試験歯科");
  await page.getByRole("button", { name: "さがす" }).click();
  await expect(page.locator(".contact")).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 3 })).toHaveText(
    "試験歯科 <script> & Test, clinic",
  );
});

for (const query of [
  "090-1234-5678",
  "０９０－１２３４－５６７８",
  "+81 90 1234 5678",
  "０９０⁻１２３４ｰ５６７８",
]) {
  test(`complete phone number is exact and normalized: ${query}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("施設名か電話番号").fill(query);
    await page.getByRole("button", { name: "さがす" }).click();
    await expect(page.locator(".contact")).toHaveCount(1);
    await expect(page.locator("a.phone")).toHaveCount(2);
    await expect(
      page.locator('a.phone[href="tel:+819012345678"]'),
    ).toHaveAttribute("href", "tel:+819012345678");
  });
}

test("shared telephone numbers retain every institution", async ({ page }) => {
  await page.goto(
    "/?q=%EF%BC%90%EF%BC%93%EF%BC%8D%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%8D%EF%BC%90%EF%BC%90%EF%BC%90%EF%BC%90",
  );
  await expect(
    page.getByRole("heading", {
      name: `${fixtureContacts.toLocaleString("ja-JP")} 件`,
      exact: true,
    }),
  ).toBeVisible();
  const exported = contacts(await contents(await download(page, "JSON ↓")));
  expect(new Set(exported.map((c) => c.id)).size).toBe(fixtureContacts);
});

test("empty, partial, foreign and contradictory searches recover", async ({
  page,
}) => {
  for (const query of ["090", "+1 212 555 0123", "does-not-exist"]) {
    await page.goto(`/?q=${encodeURIComponent(query)}`);
    await expect(
      page.getByRole("heading", { name: "見つかりませんでした" }),
    ).toBeVisible();
  }
  await page.goto("/?q=090-1234-5678&prefecture=47");
  await expect(
    page.getByRole("heading", { name: "見つかりませんでした", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "条件を全部けす", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: `${fixtureContacts.toLocaleString("ja-JP")} 件`,
      exact: true,
    }),
  ).toBeVisible();
});

test("pagination covers every ID once and clamps out-of-range pages", async ({
  page,
}) => {
  await page.route("**/app.js", (route) =>
    route.fulfill({ body: "", contentType: "text/javascript" }),
  );
  await page.goto("/");
  const seen = new Set<string>();
  const lastCount = fixtureContacts % 50 || 50;
  for (let current = 1; current <= fixturePages; current += 1) {
    await expect(
      page.getByRole("navigation", { name: "結果のページ" }),
    ).toContainText(`${current} / ${fixturePages} ページ`);
    await expect(page.locator(".contact")).toHaveCount(
      current === fixturePages ? lastCount : 50,
    );
    for (const href of await page
      .locator(".save")
      .evaluateAll((nodes: Element[]): (string | null)[] =>
        nodes.map((node: Element): string | null => node.getAttribute("href")),
      )) {
      expect(href).not.toBeNull();
      expect(seen.has(string(href))).toBe(false);
      seen.add(string(href));
    }
    if (current < fixturePages)
      await page.getByRole("link", { name: "次の50件", exact: true }).click();
  }
  expect(seen.size).toBe(fixtureContacts);
  await expect(
    page.getByRole("link", { name: "次の50件", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "前の50件", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "結果のページ" }),
  ).toContainText(`${fixturePages - 1} / ${fixturePages} ページ`);
  await page.goto("/?page=999999");
  await expect(page.locator(".contact")).toHaveCount(lastCount);
  await page.goto("/?page=0");
  await expect(
    page.getByRole("navigation", { name: "結果のページ" }),
  ).toContainText(`1 / ${fixturePages} ページ`);
});

test("all three downloads include matches beyond the displayed page", async ({
  page,
}) => {
  await page.goto("/?page=2");
  const json = await download(page, "JSON ↓");
  expect(json.suggestedFilename()).toBe("contacts.json");
  expect(contacts(await contents(json))).toHaveLength(fixtureContacts);
  const csv = await download(page, "CSV ↓");
  expect(csv.suggestedFilename()).toBe("contacts.csv");
  const rows: unknown = parse(await contents(csv), { columns: true });
  expect(array(rows)).toHaveLength(fixtureContacts);
  const vcf = await download(page, "VCF ↓");
  expect(vcf.suggestedFilename()).toBe("contacts.vcf");
  checkCards(await contents(vcf), fixtureContacts);
});

test("filtered exports preserve multiple phones, Japanese and delimiters", async ({
  page,
}) => {
  await page.goto("/?prefecture=13&category=dental");
  const exported = contacts(await contents(await download(page, "JSON ↓")));
  expect(exported).toHaveLength(1);
  expect(exported[0]?.phones.map((phone) => phone.e164)).toEqual([
    "+81300000000",
    "+819012345678",
  ]);
  const raw: unknown = parse(await contents(await download(page, "CSV ↓")), {
    columns: true,
  });
  const row = array(raw)[0];
  object(row);
  expect(row.name).toBe("試験歯科 <script> & Test, clinic");
  expect(row.address).toBe("Test, address;\nSuite 2\\東");
  const card = await contents(await download(page, "VCF ↓"));
  checkCards(card, 1);
  const unfolded = card.replaceAll("\r\n ", "");
  expect(unfolded).toContain("FN:試験歯科 <script> & Test\\, clinic\r\n");
  expect(unfolded).toContain(
    "ADR;TYPE=WORK:;;Test\\, address\\;\\nSuite 2\\\\東;;;;\r\n",
  );
  expect(unfolded).toContain("TEL;TYPE=WORK,VOICE:+819012345678\r\n");
});

test("single-contact download contains one complete vCard", async ({
  page,
}) => {
  await page.goto("/?q=試験");
  const result = await download(page, "連絡先に保存");
  expect(result.suggestedFilename()).toBe("contact.vcf");
  const card = await contents(result);
  checkCards(card, 1);
  const unfolded = card.replaceAll("\r\n ", "");
  expect(unfolded).toContain("UID:urn:public-phonebook:13:dental\r\n");
  expect(unfolded).toContain("NOTE:Source: https://example.com/source");
});

test("hostile names, URLs and queries cannot introduce executable markup", async ({
  page,
}) => {
  await page.goto("/?q=試験");
  await expect(page.locator('script:not([src="/app.js"])')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3 })).toContainText(
    "<script>",
  );
  await page
    .getByLabel("施設名か電話番号")
    .fill('<img src=x onerror="alert(1)">');
  await page.getByRole("button", { name: "さがす" }).click();
  await expect(page.locator('img[onerror], img[src="x"]')).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "見つかりませんでした" }),
  ).toBeVisible();
});

test("keyboard navigation can submit the search form", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("施設名か電話番号");
  await field.focus();
  await field.fill("試験");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "さがす" })).toBeFocused();
  for (const label of ["都道府県", "種類"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(label, { exact: true })).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.getByText("市区町村で絞る", { exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("市区町村", { exact: true })).toBeFocused();
  await field.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "さがす" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".contact")).toHaveCount(1);
});

test("narrow and wide layouts keep controls and contacts inside the viewport", async ({
  page,
}, info) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?q=試験");
    await expect(page.getByRole("button", { name: "さがす" })).toBeVisible();
    const bounds = await page.evaluate(
      (): { content: number; viewport: number } => ({
        content: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }),
    );
    expect(bounds.content).toBeLessThanOrEqual(bounds.viewport);
    await page.screenshot({
      path: info.outputPath(`layout-${width}.png`),
      fullPage: true,
    });
  }
});

test("WCAG accessibility checks cover results and empty states", async ({
  page,
}, info) => {
  for (const path of [
    "/",
    "/?q=試験",
    "/?q=no-such-facility",
    "/contacts/13:dental/source",
  ]) {
    await page.goto(path);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    await info.attach(`accessibility-${encodeURIComponent(path)}.json`, {
      body: JSON.stringify(result.violations, null, 2),
      contentType: "application/json",
    });
    expect(
      result.violations.map((violation) => ({
        id: violation.id,
        affected: violation.nodes.length,
        examples: violation.nodes
          .slice(0, 3)
          .map((node) => ({ target: node.target, issue: node.failureSummary })),
      })),
    ).toEqual([]);
  }
});

test("pages load without third-party requests or browser runtime errors", async ({
  page,
}) => {
  const errors: string[] = [];
  const thirdParties: string[] = [];
  page.on("pageerror", (error: Error): void => {
    errors.push(error.message);
  });
  page.on("request", (request): void => {
    if (new URL(request.url()).hostname !== "127.0.0.1")
      thirdParties.push(request.url());
  });
  await page.goto("/");
  await page.locator(".contact").nth(49).scrollIntoViewIfNeeded();
  await expect(page.locator(".contact")).toHaveCount(100);
  expect(errors).toEqual([]);
  expect(thirdParties).toEqual([]);
});

test("invalid requests fail without exposing SQL or source internals", async ({
  request,
}) => {
  for (const path of [
    "/export?format=exe",
    `/?q=${"x".repeat(513)}`,
    "/?page=-1",
    "/?page=NaN",
  ]) {
    const result = await request.get(path);
    expect(result.status()).toBe(400);
    expect(await result.text()).not.toMatch(
      /SELECT |sqlite|backtrace|\/Users\//,
    );
  }
  for (const path of [
    "/contacts/missing.vcf",
    "/contacts/13:dental.json",
    "/unknown",
  ])
    expect((await request.get(path)).status()).toBe(404);
  expect(
    (
      await request.get("/export?format=json&prefecture=13%27%20OR%201%3D1--")
    ).status(),
  ).toBe(400);
});
