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

async function referenceLayoutShift(
  page: Page,
  moveReference: boolean,
): Promise<number> {
  await page.goto("/developers");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  return page.evaluate(
    (move) =>
      new Promise<number>((resolve) => {
        let total = 0;
        function add(entries: readonly PerformanceEntry[]): void {
          for (const entry of entries)
            if (!("hadRecentInput" in entry && entry.hadRecentInput))
              total += "value" in entry ? Number(entry.value) : 0;
        }
        const observer = new PerformanceObserver((list) =>
          add(list.getEntries()),
        );
        observer.observe({ type: "layout-shift", buffered: true });
        if (move) {
          const header = document.querySelector("main > header");
          if (!header) throw new Error("The reference header is missing");
          const copy = header.cloneNode(true);
          if (!(copy instanceof Element))
            throw new Error("The reference header copy is missing");
          header.insertAdjacentElement("afterend", copy);
        }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            add(observer.takeRecords());
            observer.disconnect();
            resolve(total);
          }),
        );
      }),
    moveReference,
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
    expect(await referenceLayoutShift(page, false)).toBeLessThan(
      layoutShiftLimit,
    );
  });

  test("the layout-shift measurement detects content inserted above the reference", async ({
    page,
  }) => {
    expect(await referenceLayoutShift(page, true)).toBeGreaterThan(
      layoutShiftLimit,
    );
  });
});
