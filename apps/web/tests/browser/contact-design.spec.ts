import type { Locator, Page } from "@playwright/test";
import { SearchResponseSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";
import { foundation } from "../../src/ui/foundations.ts";
import { expect, test } from "./fixtures.ts";
import { recordFullPage } from "./full-page-screenshot.ts";
import { saveData } from "./search-sources.ts";

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
  await saveData(page);
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
      const framedDetailActions = 1;
      const issues: { rule: string; detail: string }[] = [];
      for (const card of cards) {
        const links = Array.from(
          card.querySelectorAll<HTMLAnchorElement>("a[href]"),
        );
        const phones = links.filter((link) => link.protocol === "tel:");
        const buttons = Array.from(
          card.querySelectorAll<HTMLButtonElement>("button"),
        );
        const name = card.querySelector(":is(h2,h3)");
        const facility = name?.textContent?.trim() ?? "";
        if (links.some((link) => link.href.includes("google.com/maps/")))
          issues.push({
            rule: "result-address",
            detail:
              "Result cards leave the address and its map to the detail page",
          });
        const region = name?.nextElementSibling;
        if (region?.tagName !== "P" || !region.textContent?.trim())
          issues.push({
            rule: "result-region",
            detail: "The prefecture and municipality follow the facility name",
          });
        const details = links.filter((link) =>
          link.pathname.startsWith("/contacts/"),
        );
        const detail = details[0];
        const label = detail?.textContent?.trim() ?? "";
        if (
          !facility ||
          name?.querySelector("a, button") ||
          details.length !== 1 ||
          !["住所などを見る", "くわしい情報を見る"].includes(label) ||
          detail?.getAttribute("aria-label") !== `${facility}の${label}`
        )
          issues.push({
            rule: "facility-navigation",
            detail:
              "The facility name stays heading text, and one labelled action opens the details",
          });
        const chrome = [...links, ...buttons].filter((node) => {
          const style = getComputedStyle(node);
          return (
            Number.parseFloat(style.borderTopWidth) > 0 ||
            style.backgroundColor === "rgb(0, 0, 0)"
          );
        });
        if (chrome.length !== phones.length + framedDetailActions)
          issues.push({
            rule: "action-chrome",
            detail: `${chrome.length} framed actions for ${phones.length} phone numbers and one detail action`,
          });
        const lastCall = phones.at(-1);
        if (detail && lastCall && region) {
          const box = detail.getBoundingClientRect();
          const above = region.getBoundingClientRect();
          const wide = innerWidth >= columnsAt;
          if (
            box.top < above.bottom ||
            Math.abs(box.left - above.left) > 1 ||
            (!wide && box.top < lastCall.getBoundingClientRect().bottom) ||
            (wide && box.right > lastCall.getBoundingClientRect().left)
          )
            issues.push({
              rule: "detail-placement",
              detail:
                "The detail action sits below the region on its left edge, below the call action on narrow screens and left of it on wide screens",
            });
        }
        if (buttons.length !== 0)
          issues.push({
            rule: "copy-control",
            detail: "Result cards draw no copy or other button control",
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
            (value) =>
              value.closest("a[href], button") || value.tagName !== "P",
          )
        )
          issues.push({
            rule: "plain-number",
            detail:
              "Telephone values stay plain text; calling needs the separate explicit action",
          });
        for (const link of links) {
          if (
            link.protocol !== "tel:" &&
            !chrome.includes(link) &&
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
        if (number) {
          const bounds = number.getBoundingClientRect();
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
          region &&
          name &&
          Math.abs(
            region.getBoundingClientRect().left -
              name.getBoundingClientRect().left,
          ) > 1
        )
          issues.push({
            rule: "column-alignment",
            detail: "The facility and its region must share their left edge",
          });
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
        await recordFullPage(page, info, "reported-contact");
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
      'article [data-contact-part="phones"] { align-self: start !important; } article a[href*="google.com/maps/"] { border: 1px solid black !important; } article a[href^="tel:"] { width: 50% !important; } article :is(h2,h3) + p { margin-inline-start: 2rem !important; } article a[href^="/contacts/"] { margin-inline-start: 4rem !important; }';
    document.head.appendChild(style);
    const map = document.createElement("a");
    map.href = "https://www.google.com/maps/search/?api=1&query=planted";
    map.textContent = "planted";
    document.querySelector("article")?.appendChild(map);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.dataset.phone = "";
    copy.textContent = "03-0000-0000";
    document.querySelector("article")?.appendChild(copy);
    const heading = document.querySelector("article :is(h2,h3)");
    if (!heading) throw new Error("Missing facility heading");
    const named = document.createElement("a");
    named.href = "/contacts/planted";
    named.textContent = heading.textContent;
    heading.textContent = "";
    heading.appendChild(named);
  });
  const rules = (await designIssues(page)).map((issue) => issue.rule);
  expect(rules).toContain("column-alignment");
  expect(rules).toContain("action-chrome");
  expect(rules).toContain("phone-column-width");
  expect(rules).toContain("result-address");
  expect(rules).toContain("detail-placement");
  expect(rules).toContain("facility-navigation");
  expect(rules).toContain("copy-control");
  expect(rules).toContain("plain-number");
  await page.locator('article a[href*="google.com/maps/"]').evaluate((map) => {
    map.remove();
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

test("telephone values stay selectable text, and the call action precedes the details in focus order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installResult(page, cases[0]);
  const card = page.locator("article");
  const value = card.locator("[data-phone]");
  await expect(value).toHaveText("047-321-4055");
  expect(
    await value.evaluate(
      (node) =>
        node.tagName === "P" &&
        node.closest("a[href], button") === null &&
        getComputedStyle(node).userSelect !== "none",
    ),
  ).toBe(true);
  expect(
    await card.evaluate((node) => {
      const call = node.querySelector('a[href^="tel:"]');
      const detail = node.querySelector('a[href^="/contacts/"]');
      return (
        call !== null &&
        detail !== null &&
        (call.compareDocumentPosition(detail) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0 &&
        node.querySelector('[tabindex]:not([tabindex="-1"])') === null
      );
    }),
    "Source order puts the call action before the details, with no tab index override",
  ).toBe(true);
  const call = card.getByRole("link", { name: /に電話をかける$/u });
  await page.keyboard.press("Shift");
  await call.focus();
  await expect(call).toBeFocused();
  expect(
    await call.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(foundation.control.focus);
  const before = page.url();
  await value.click();
  expect(page.url()).toBe(before);
  await expect(card.getByRole("status")).toHaveCount(0);
  expect(await designIssues(page)).toEqual([]);
});

test("a wide result card puts the details below the region on the left and the call action on the right", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installResult(page, cases[0]);
  const card = page.locator("article");
  const box = async (
    locator: Locator,
  ): Promise<{ x: number; y: number; width: number; height: number }> => {
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error("A result card part is hidden");
    return bounds;
  };
  const [name, region, number, call, detail] = await Promise.all(
    [
      card.getByRole("heading", { level: 3 }),
      card.locator("h3 + p"),
      card.locator("[data-phone]"),
      card.getByRole("link", { name: /に電話をかける$/u }),
      card.getByRole("link", { name: /の住所などを見る$/u }),
    ].map(box),
  );
  if (!name || !region || !number || !call || !detail)
    throw new Error("The result card is incomplete");
  const sameRow = (a: typeof name, b: typeof name): boolean =>
    a.y < b.y + b.height && b.y < a.y + a.height;
  expect(Math.abs(region.x - name.x)).toBeLessThan(1);
  expect(
    Math.abs(detail.x - name.x),
    "The details sit in the left column",
  ).toBeLessThan(1);
  expect(detail.y, "The details sit below the region").toBeGreaterThanOrEqual(
    region.y + region.height,
  );
  expect(
    call.x,
    "The call action sits in the right column",
  ).toBeGreaterThanOrEqual(name.x + name.width);
  expect(Math.abs(call.x - number.x)).toBeLessThan(1);
  expect(Math.abs(call.width - foundation.layout.phoneColumn)).toBeLessThan(1);
  expect(sameRow(name, number), "The name sits beside the number").toBe(true);
  expect(sameRow(region, call), "The region sits beside the call action").toBe(
    true,
  );
  expect(detail.y).toBeGreaterThanOrEqual(call.y + call.height);
});
