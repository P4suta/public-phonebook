import type { APIRequestContext, Page } from "@playwright/test";
import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import { expect, test } from "./fixtures.ts";

const redirectFree = 0;
const layoutShiftLimit = 0.1;

async function knownContactPath(request: APIRequestContext): Promise<string> {
  const raw: unknown = await (
    await request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const contact = v.parse(SearchResponseSchema, raw).data[0];
  if (!contact) throw new Error("Known contact fixture missing");
  return `/contacts/${encodeURIComponent(contact.id)}`;
}

async function referenceLayoutShift(page: Page): Promise<number> {
  await page.goto("/developers");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0;
        new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries())
            if (!("hadRecentInput" in entry && entry.hadRecentInput))
              total += "value" in entry ? Number(entry.value) : 0;
        }).observe({ type: "layout-shift", buffered: true });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(total)),
        );
      }),
  );
}

test("every page declares the site icon, and the icon is served", async ({
  page,
  request,
}) => {
  for (const path of ["/", "/about", await knownContactPath(request)]) {
    await page.goto(path);
    await expect(page.locator('link[rel="icon"]'), path).toHaveAttribute(
      "href",
      "/favicon.svg",
    );
  }
  const icon = await request.get("/favicon.svg");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  expect(await icon.text()).toContain("<svg");
});

test("direct contact and source links render without a redirect", async ({
  request,
}) => {
  const contact = await knownContactPath(request);
  for (const path of [contact, `${contact}/source`]) {
    const response = await request.get(path, { maxRedirects: redirectFree });
    expect(response.status(), path).toBe(200);
  }
  const returned = await request.get(
    `${contact}?from=${encodeURIComponent("/?q=図書館")}`,
    {
      maxRedirects: redirectFree,
    },
  );
  expect(returned.status()).toBe(200);
  expect(await returned.text()).toContain('href="/?q=');
});

test.describe("API reference loading", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "Only Chromium reports layout-shift entries",
  );

  test("the API reference doesn't move visible content while it loads", async ({
    page,
  }) => {
    expect(await referenceLayoutShift(page)).toBeLessThan(layoutShiftLimit);
  });

  test("the layout-shift measurement detects a reference that enters the page flow early", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const nonce = document.querySelector<HTMLMetaElement>(
          'meta[property="csp-nonce"]',
        )?.content;
        if (!nonce) throw new Error("The document nonce is missing");
        const sheet = document.createElement("style");
        sheet.nonce = nonce;
        sheet.textContent =
          '[data-api-reference][data-ready="false"] { position: static !important; visibility: visible !important; }';
        document.head.appendChild(sheet);
      });
    });
    expect(await referenceLayoutShift(page)).toBeGreaterThan(layoutShiftLimit);
  });
});
