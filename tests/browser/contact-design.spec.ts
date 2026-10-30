import type { Page } from "@playwright/test";
import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import { foundation } from "../../src/ui/foundations.ts";
import { expect, test } from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

const cases = [
  {
    name: "reported-dental-result",
    category: "dental",
    categoryLabel: "歯医者",
    facility: "市川駅前　ひだまり歯科クリニック",
    address: "〒272−0033市川市市川南１−１−１ザ・タワーズ・イースト１１１",
    phones: [{ display: "047-321-4055", e164: "+81473214055" }],
  },
  {
    name: "long-content",
    category: "library",
    categoryLabel: "図書館",
    facility:
      "地域の相談と学習を支える図書館・資料室・子育て支援センター共同窓口".repeat(
        3,
      ),
    address:
      "東京都千代田区永田町一丁目十番一号　図書館の別館・地域資料室・相談窓口のある建物の十二階".repeat(
        3,
      ),
    phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
  },
  {
    name: "multiple-phones-without-address",
    category: "library",
    categoryLabel: "図書館",
    facility: "図書館の相談窓口",
    address: "",
    phones: [
      { display: "03-3581-2331", e164: "+81335812331" },
      { display: "03-3827-2053", e164: "+81338272053" },
    ],
  },
] as const;

async function installResult(
  page: Page,
  example: (typeof cases)[number],
): Promise<void> {
  const raw: unknown = await (
    await page.request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const result = v.parse(SearchResponseSchema, raw);
  const contact = result.data[0];
  if (!contact) throw new Error("Missing contact design fixture");
  await page.route("**/api/contact-groups?**", async (route) => {
    await route.fulfill({
      json: {
        groups: [
          {
            category: example.category,
            results: {
              ...result,
              data: [
                {
                  ...contact,
                  category: example.category,
                  name: example.facility,
                  address: example.address,
                  phones: example.phones,
                },
              ],
              meta: { ...result.meta, total: 1, nextCursor: null },
              links: { ...result.links, next: null },
            },
          },
        ],
        meta: { snapshot: result.meta.snapshot, total: 1 },
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill("表示確認");
  await expect(page.locator("article")).toHaveCount(1);
  await expect(
    page.getByRole("heading", {
      name: `${example.categoryLabel} 1件`,
      exact: true,
    }),
  ).toBeVisible();
}

async function designIssues(
  page: Page,
): Promise<readonly { rule: string; detail: string }[]> {
  return page
    .locator('article[data-layout="result"]')
    .evaluateAll((cards, columnsAt) => {
      const issues: { rule: string; detail: string }[] = [];
      for (const card of cards) {
        const links = Array.from(
          card.querySelectorAll<HTMLAnchorElement>("a[href]"),
        );
        const phones = links.filter((link) => link.protocol === "tel:");
        const buttons = Array.from(
          card.querySelectorAll<HTMLButtonElement>("button"),
        );
        const map = links.find((link) =>
          link.href.includes("google.com/maps/search/"),
        );
        const name = card.querySelector(":is(h2,h3) a[href]");
        if (
          map &&
          (map.target !== "_blank" ||
            !map.relList.contains("noopener") ||
            !map.relList.contains("noreferrer") ||
            !map.getAttribute("aria-label")?.includes("新しいタブ"))
        )
          issues.push({
            rule: "map-new-tab",
            detail: "Maps must open a safe, announced new tab",
          });
        if (!name)
          issues.push({
            rule: "facility-navigation",
            detail: "The facility heading must be the detail link",
          });
        const chrome = [...links, ...buttons].filter((node) => {
          const style = getComputedStyle(node);
          return (
            Number.parseFloat(style.borderTopWidth) > 0 ||
            style.backgroundColor === "rgb(0, 0, 0)"
          );
        });
        if (chrome.length !== phones.length)
          issues.push({
            rule: "action-chrome",
            detail: `${chrome.length} framed actions for ${phones.length} phone numbers`,
          });
        if (buttons.length !== phones.length)
          issues.push({
            rule: "copy-count",
            detail: "Each phone needs exactly one copy button",
          });
        for (const phone of phones) {
          if (
            phone.textContent?.trim() !== "電話をかける" ||
            getComputedStyle(phone).backgroundColor !== "rgb(0, 0, 0)"
          )
            issues.push({
              rule: "explicit-call-action",
              detail: "Calling needs an explicitly labelled primary action",
            });
        }
        const values = Array.from(card.querySelectorAll("[data-phone]"));
        if (
          values.length !== phones.length ||
          values.some(
            (value) => value.closest("a[href]") || value.tagName !== "BUTTON",
          )
        )
          issues.push({
            rule: "separate-call-and-copy",
            detail:
              "Telephone values copy; calling needs the separate explicit action",
          });
        for (const link of links) {
          if (
            link.protocol !== "tel:" &&
            !getComputedStyle(link).textDecorationLine.includes("underline")
          )
            issues.push({
              rule: "link-affordance",
              detail: link.textContent ?? "",
            });
        }
        if (new Set(links.map((link) => link.href)).size !== links.length)
          issues.push({
            rule: "duplicate-destination",
            detail: "Repeated destinations add redundant controls",
          });
        const controls = [...links, ...buttons];
        for (const [index, control] of controls.entries()) {
          const label =
            control.getAttribute("aria-label") ?? control.textContent ?? "";
          if (
            !(control.textContent ?? "").trim() ||
            !label.includes((control.textContent ?? "").trim())
          )
            issues.push({ rule: "label-in-name", detail: label });
          const a = control.getBoundingClientRect();
          if (a.width < 44 || a.height < 44)
            issues.push({
              rule: "target-size",
              detail: `${a.width}×${a.height}`,
            });
          if (
            control.scrollWidth > control.clientWidth + 1 ||
            control.scrollHeight > control.clientHeight + 1
          )
            issues.push({
              rule: "clipped-control",
              detail: JSON.stringify({
                text: control.textContent,
                client: [control.clientWidth, control.clientHeight],
                scroll: [control.scrollWidth, control.scrollHeight],
                box: a,
                css: {
                  lineHeight: getComputedStyle(control).lineHeight,
                  fontSize: getComputedStyle(control).fontSize,
                  padding: getComputedStyle(control).padding,
                },
                children: Array.from(control.children).map((child) => ({
                  tag: child.tagName,
                  box: child.getBoundingClientRect(),
                  lineHeight: getComputedStyle(child).lineHeight,
                  fontSize: getComputedStyle(child).fontSize,
                })),
              }),
            });
          for (const other of controls.slice(index + 1)) {
            const b = other.getBoundingClientRect();
            if (
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
            )
              issues.push({
                rule: "overlapping-targets",
                detail: `${control.textContent}/${other.textContent}`,
              });
          }
        }
        const call = phones[0];
        const number = values[0];
        const column = card.querySelector('[data-contact-part="phones"]');
        if (column) {
          const bounds = column.getBoundingClientRect();
          for (const control of [...phones, ...values]) {
            const box = control.getBoundingClientRect();
            if (
              Math.abs(box.left - bounds.left) > 1 ||
              Math.abs(box.right - bounds.right) > 1
            )
              issues.push({
                rule: "phone-column-width",
                detail: `${control.textContent}: ${box.width}/${bounds.width}`,
              });
          }
        }
        if (
          innerWidth >= columnsAt &&
          call &&
          number &&
          Math.abs(
            call.getBoundingClientRect().left -
              number.getBoundingClientRect().left,
          ) > 1
        )
          issues.push({
            rule: "column-alignment",
            detail: "The number and call action must share their left edge",
          });
        if (
          map &&
          name &&
          Math.abs(
            map.getBoundingClientRect().left -
              name.getBoundingClientRect().left,
          ) > 1
        )
          issues.push({
            rule: "column-alignment",
            detail: "The facility and map target must share their left edge",
          });
        if (innerWidth >= columnsAt && map && call && phones.length === 1) {
          const bottom = map.getBoundingClientRect().bottom;
          const callBottom = call.getBoundingClientRect().bottom;
          if (Math.abs(bottom - callBottom) > 1)
            issues.push({
              rule: "footer-alignment",
              detail: `Map ${bottom}, call ${callBottom}`,
            });
        }
      }
      if (document.documentElement.scrollWidth > innerWidth + 1)
        issues.push({
          rule: "horizontal-scroll",
          detail: `${document.documentElement.scrollWidth}/${innerWidth}`,
        });
      return issues;
    }, foundation.layout.columnsAt);
}

for (const width of [320, 390, 800, 960, 1440]) {
  for (const example of cases) {
    test(`contact relationships at ${width}px with ${example.name}`, async ({
      page,
      browserName,
    }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await installResult(page, example);
      const issues = await designIssues(page);
      await info.attach("contact-design", {
        body: JSON.stringify(issues),
        contentType: "application/json",
      });
      expect(issues).toEqual([]);
      if (
        browserName !== "webkit" &&
        width === 1440 &&
        example.name === "reported-dental-result"
      )
        await page.screenshot({
          path: info.outputPath("reported-contact.png"),
          fullPage: true,
        });
    });
  }
}

test("the contact design gate detects displaced actions and duplicate framed navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installResult(page, cases[0]);
  expect(await designIssues(page)).toEqual([]);
  await page.evaluate(() => {
    const nonce = document.querySelector<HTMLMetaElement>(
      'meta[property="csp-nonce"]',
    )?.content;
    if (!nonce) throw new Error("Missing CSP nonce");
    const style = document.createElement("style");
    style.nonce = nonce;
    style.textContent =
      'article [data-contact-part="phones"] { align-self: start !important; } article :is(h2,h3) a { border: 1px solid black !important; } article a[href^="tel:"] { width: 50% !important; }';
    document.head.appendChild(style);
    const map = document.querySelector('article a[href*="google.com/maps/"]');
    map?.removeAttribute("target");
    map?.removeAttribute("rel");
  });
  const rules = (await designIssues(page)).map((issue) => issue.rule);
  expect(rules).toContain("footer-alignment");
  expect(rules).toContain("action-chrome");
  expect(rules).toContain("phone-column-width");
  expect(rules).toContain("map-new-tab");
  await page.locator('article a[href*="google.com/maps/"]').evaluate((map) => {
    map.setAttribute("target", "_blank");
    map.setAttribute("rel", "noopener noreferrer");
  });
});

for (const width of [320, 1440]) {
  test(`contact relationships survive doubled text at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installResult(page, cases[1]);
    await page.evaluate(() => {
      const nonce = document.querySelector<HTMLMetaElement>(
        'meta[property="csp-nonce"]',
      )?.content;
      if (!nonce) throw new Error("Missing CSP nonce");
      const style = document.createElement("style");
      style.nonce = nonce;
      style.textContent = "html { font-size: 200%; }";
      document.head.appendChild(style);
    });
    expect(await designIssues(page)).toEqual([]);
  });
}

test("telephone values copy without initiating calls and keyboard feedback preserves action alignment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    let attempts = 0;
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async writeText(value: string): Promise<void> {
          attempts += 1;
          if (attempts > 2) throw new DOMException("Denied", "NotAllowedError");
          copied = value;
        },
        async readText(): Promise<string> {
          return copied;
        },
      },
    });
  });
  await installResult(page, cases[0]);
  const card = page.locator("article");
  const value = card.locator("[data-phone]");
  expect(
    await value.evaluate(
      (node) => node.tagName === "BUTTON" && node.closest("a[href]") === null,
    ),
  ).toBe(true);
  const before = page.url();
  await value.click();
  expect(page.url()).toBe(before);
  await expect(card.getByRole("status")).toHaveText("コピーしました。");
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(
    "047-321-4055",
  );
  const name = card.getByRole("heading").getByRole("link");
  await name.focus();
  await page.keyboard.press("Tab");
  const copy = value;
  await expect(copy).toBeFocused();
  expect(
    await copy.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(3);
  await page.keyboard.press("Space");
  await expect(card.getByRole("status")).toHaveText("コピーしました。");
  await expect(copy).toBeFocused();
  expect(await designIssues(page)).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toHaveText(
    "コピーできませんでした。文字をえらんでコピーしてください。",
  );
  await expect(card.getByRole("status")).toBeVisible();
  await expect(copy).toBeFocused();
  expect(await designIssues(page)).toEqual([]);
});
