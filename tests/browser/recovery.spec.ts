import type { Locator } from "@playwright/test";
import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import { expect, test } from "./fixtures.ts";
import { detailActionName, saveData } from "./search-sources.ts";

const settleDelay = 120;
const quietPeriod = 10_000;
const loadedAt = new Date("2026-10-31T00:00:00Z");
const typingFrom = new Date("2026-10-31T01:00:00Z");
const committedText = "国立国会図書館";

type CompositionStep =
  | {
      readonly type: "compositionstart" | "compositionend";
      readonly text: string;
    }
  | {
      readonly type: "input";
      readonly text: string;
      readonly isComposing: boolean;
    };

const provisionalSteps: readonly CompositionStep[] = [
  { type: "compositionstart", text: "" },
  { type: "input", text: "こくりつ", isComposing: true },
  { type: "input", text: "国立こっかいとしょかん", isComposing: true },
];

/** Browsers commit a composition in one of two orders, and the page must search once either way. */
const compositionCommits: readonly (readonly [
  string,
  readonly CompositionStep[],
])[] = [
  [
    "the last input precedes compositionend, as in Chromium",
    [
      { type: "input", text: committedText, isComposing: true },
      { type: "compositionend", text: committedText },
    ],
  ],
  [
    "compositionend precedes the last input, as in Firefox",
    [
      { type: "compositionend", text: committedText },
      { type: "input", text: committedText, isComposing: false },
    ],
  ],
];

/**
 * Dispatches each composition event with the field holding its text.
 * Firefox's driver wraps `fill` text in a composition of its own, so the test owns every event instead.
 */
async function playComposition(
  input: Locator,
  steps: readonly CompositionStep[],
): Promise<void> {
  await input.evaluate((element: HTMLInputElement, events) => {
    for (const step of events) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(element, step.text);
      element.dispatchEvent(
        step.type === "input"
          ? new InputEvent("input", {
              bubbles: true,
              inputType: "insertCompositionText",
              isComposing: step.isComposing,
              data: step.text,
            })
          : new CompositionEvent(step.type, { bubbles: true, data: step.text }),
      );
    }
  }, steps);
}

test("missing facilities and malformed searches have usable error pages", async ({
  page,
  httpFailures,
}) => {
  httpFailures.add(404);
  httpFailures.add(400);
  const missing = await page.goto("/contacts/does-not-exist");
  expect(missing?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "ページが見つかりません" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "さがす画面にもどる" }),
  ).toBeVisible();
  for (const query of [
    "q=x&category=unknown",
    "__proto__=x",
    "constructor=x",
  ]) {
    const invalid = await page.goto(`/?${query}`);
    expect(invalid?.status(), query).toBe(400);
    await expect(
      page.getByRole("heading", { name: "さがす名前をたしかめてください" }),
    ).toBeVisible();
  }
});

test("search and cursor continuation work without JavaScript", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The test server URL is required");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("searchbox").fill("図書館");
    await page.getByRole("button", { name: "電話番号をさがす" }).click();
    await expect(page.locator("[data-result-category]").first()).toBeVisible();
    await page
      .locator('[data-result-category="library"]')
      .getByRole("link", { name: "図書館をもっと見る" })
      .click();
    await expect(page).toHaveURL(/category=library/);
    await expect(page.locator("article")).toHaveCount(30);
    const firstIds = await page
      .locator("article")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-labelledby")),
      );
    await page.getByRole("link", { name: "図書館をもっと見る" }).click();
    await expect(page).toHaveURL(/cursor=/);
    await expect(page.locator("article")).toHaveCount(30);
    const nextIds = await page
      .locator("article")
      .evaluateAll((items) =>
        items.map((item) => item.getAttribute("aria-labelledby")),
      );
    expect(nextIds.every((id) => !firstIds.includes(id))).toBe(true);
    await page
      .locator("article")
      .first()
      .getByRole("link", { name: detailActionName })
      .click();
    await expect(
      page.getByRole("link", { name: "電話帳に入れる" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "検索結果にもどる" }).click();
    await expect(page).toHaveURL(/cursor=/);
  } finally {
    await context.close();
  }
});

test("input entered before enhancement is preserved", async ({ page }) => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() === "script") await gate;
    await route.continue();
  });
  await page.goto("/", { waitUntil: "commit" });
  await page.getByRole("searchbox").fill("国立国会図書館");
  release?.();
  await expect(page.locator("article").first().getByRole("heading")).toHaveText(
    "国立国会図書館",
  );
  await expect(page.getByRole("searchbox")).toHaveValue("国立国会図書館");
});

for (const [order, commit] of compositionCommits)
  test(`IME composition is committed as one search when ${order}`, async ({
    page,
  }) => {
    const queries: string[] = [];
    await page.route("**/api/contact-groups?**", async (route) => {
      queries.push(new URL(route.request().url()).searchParams.get("q") ?? "");
      await route.continue();
    });
    await saveData(page);
    await page.clock.install({ time: loadedAt });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    await page.clock.pauseAt(typingFrom);
    const input = page.getByRole("searchbox");
    await input.focus();
    await playComposition(input, provisionalSteps);
    await page.clock.runFor(quietPeriod);
    expect(queries).toEqual([]);
    await playComposition(input, commit);
    await page.clock.runFor(settleDelay);
    await expect.poll(() => [...queries]).toEqual([committedText]);
    await page.clock.runFor(quietPeriod);
    expect(queries).toEqual([committedText]);
    // TanStack Query renders a settled response from a zero-delay timer, which a held clock never fires.
    await page.clock.resume();
    await expect(
      page.locator("article").first().getByRole("heading"),
    ).toHaveText(committedText);
  });

test("failed continuation preserves rows and can be retried", async ({
  page,
  httpFailures,
}) => {
  httpFailures.add(503);
  let fail = true;
  await page.route("**/api/contacts?**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor") && fail) {
      await route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://example.org/unavailable",
          title: "Unavailable",
          status: 503,
          code: "unavailable",
          requestId: "fixture",
        }),
      });
    } else await route.continue();
  });
  await saveData(page);
  await page.goto("/?q=図書館&category=library");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await expect(page.locator("article")).toHaveCount(30);
  await page
    .getByRole("link", { name: "図書館をもっと見る" })
    .scrollIntoViewIfNeeded();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(30);
  fail = false;
  await page
    .getByRole("button", { name: "検索結果をもう一度読みこむ" })
    .click();
  await expect(page.locator("article")).toHaveCount(60);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("mixed-snapshot continuation offers a clean restart", async ({
  page,
  httpFailures,
}) => {
  httpFailures.add(409);
  await page.route("**/api/contacts?**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      await route.fulfill({
        status: 409,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "https://example.org/snapshot_changed",
          title: "Dataset changed",
          status: 409,
          code: "snapshot_changed",
          requestId: "fixture",
        }),
      });
    } else await route.continue();
  });
  await saveData(page);
  await page.goto("/?q=図書館&category=library");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page
    .getByRole("link", { name: "図書館をもっと見る" })
    .scrollIntoViewIfNeeded();
  const restart = page.getByRole("link", {
    name: "検索結果をはじめから読みこむ",
  });
  await expect(restart).toBeVisible();
  await restart.click();
  await expect(page.locator("article")).toHaveCount(30);
  await expect(page.getByRole("searchbox")).toHaveValue("図書館");
  await expect(page).not.toHaveURL(/cursor=/);
});

test("untrusted result text is rendered as text", async ({ page, request }) => {
  const raw: unknown = await (
    await request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const result = v.parse(SearchResponseSchema, raw);
  const first = result.data[0];
  if (!first) throw new Error("Missing security fixture");
  const name = '<img src=x onerror="alert(1)">';
  await saveData(page);
  await page.route("**/api/contact-groups?**", async (route) => {
    await route.fulfill({
      json: {
        groups: [
          {
            category: first.category,
            results: {
              ...result,
              data: [{ ...first, name }],
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
  await page.getByRole("searchbox").fill("fixture");
  await page.getByRole("searchbox").press("Enter");
  await expect(page.locator("article").getByRole("heading")).toHaveText(name);
  await expect(page.locator("article img, article script")).toHaveCount(0);
});
