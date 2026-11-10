import AxeBuilder from "@axe-core/playwright";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import {
  SearchResponseSchema,
  SourceSchema,
} from "@public-phonebook/directory/models";
import * as v from "valibot";
import { uiCopy } from "../../src/ui/copy.ts";
import { foundation } from "../../src/ui/foundations.ts";
import { auditDesign } from "./design-policy.ts";
import {
  actionIconIssues,
  expect,
  externalLinkIssues,
  externalScriptIssues,
  test,
} from "./fixtures.ts";
import { recordViewport } from "./full-page-screenshot.ts";

test.use({ video: "on", screenshot: "off" });

const minimumTarget = 44;
const appStoreUrl =
  "https://apps.apple.com/jp/app/public-phonebook/id6828899028";
const { destinations } = uiCopy.external;

async function knownContactPath(page: Page): Promise<string> {
  const raw: unknown = await (
    await page.request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const contact = v.parse(SearchResponseSchema, raw).data[0];
  if (!contact) throw new Error("The external-link fixture is missing");
  return `/contacts/${encodeURIComponent(contact.id)}`;
}

async function publicationSourcePath(page: Page): Promise<string> {
  for (const q of ["国立国会図書館", "警察署"]) {
    const raw: unknown = await (
      await page.request.get(`/api/contacts?${new URLSearchParams({ q })}`)
    ).json();
    for (const contact of v.parse(SearchResponseSchema, raw).data) {
      const record: unknown = await (
        await page.request.get(
          `/api/sources/${encodeURIComponent(contact.sourceId)}`,
        )
      ).json();
      const source = v.parse(SourceSchema, record);
      if (contact.sourceUrls.some((url) => url !== source.url))
        return `/contacts/${encodeURIComponent(contact.id)}/source`;
    }
  }
  throw new Error("No known contact names a separate publication page");
}

async function stubOtherSites(
  context: BrowserContext,
  origin: string,
): Promise<void> {
  await context.route(
    (url) => url.origin !== origin,
    async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<title>Other site</title>",
      });
    },
  );
}

async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
}

function confirmation(page: Page): Locator {
  return page.getByRole("dialog", { name: uiCopy.external.heading });
}

async function linkHref(link: Locator): Promise<string> {
  return link.evaluate((node) =>
    node instanceof HTMLAnchorElement ? node.href : "",
  );
}

async function isActive(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => document.activeElement === node);
}

test("every external link type confirms its destination before opening a tab", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The browser test server URL is required");
  await stubOtherSites(context, new URL(baseURL).origin);
  const contact = await knownContactPath(page);
  const source = `${contact}/source`;
  let popups = 0;
  context.on("page", () => {
    popups += 1;
  });
  const cases = [
    {
      path: "/about",
      link: (): Locator =>
        page.getByRole("link", { name: /^プログラムと決まりを見る/u }),
      description: destinations.sourceCode,
    },
    {
      path: contact,
      link: (): Locator =>
        page
          .locator("article")
          .first()
          .getByRole("link", { name: /を地図で見る（新しいタブ）$/u }),
      description: destinations.address,
    },
    {
      path: contact,
      link: (): Locator =>
        page.getByRole("link", { name: /^施設のホームページを開く/u }),
      description: destinations.facility,
    },
    {
      path: await publicationSourcePath(page),
      link: (): Locator =>
        page.getByRole("link", { name: /^データを公開したページを見る/u }),
      description: destinations.publication,
    },
    {
      path: source,
      link: (): Locator =>
        page.getByRole("link", { name: /^データを使うときの決まりを見る/u }),
      description: destinations.license,
    },
    {
      path: source,
      link: (): Locator =>
        page.getByRole("link", { name: /^もとの資料を開く/u }),
      description: destinations.source,
    },
    {
      path: "/data",
      link: (): Locator =>
        page.getByRole("link", { name: /^データを使うときの決まりを見る/u }),
      description: destinations.license,
    },
    {
      path: "/privacy",
      link: (): Locator =>
        page.getByRole("link", { name: /^Cloudflareのプライバシーを見る/u }),
      description: destinations.cloudflarePrivacy,
    },
    {
      path: "/privacy",
      link: (): Locator => page.locator("#undeclared-destination"),
      description: destinations.other,
      prepare: async (): Promise<void> =>
        page
          .locator('a[data-external-destination="cloudflarePrivacy"]')
          .evaluate((source) => {
            const copy = source.cloneNode(true);
            if (!(copy instanceof HTMLAnchorElement))
              throw new Error("The undeclared destination fixture is missing");
            copy.id = "undeclared-destination";
            delete copy.dataset.externalDestination;
            source.insertAdjacentElement("afterend", copy);
          }),
    },
  ];
  for (const { path, link: find, description, ...fixture } of cases) {
    await openPage(page, path);
    if ("prepare" in fixture) await fixture.prepare();
    const link = find().first();
    const href = await linkHref(link);
    const dialog = confirmation(page);
    const open = dialog.getByRole("button", {
      name: uiCopy.external.open,
      exact: true,
    });
    const cancel = dialog.getByRole("button", {
      name: uiCopy.external.cancel,
      exact: true,
    });
    await expect(dialog, path).toBeHidden();
    await link.click();
    await expect(dialog, path).toBeVisible();
    await expect(dialog, path).toHaveAccessibleDescription(
      `${description} ${uiCopy.external.host(new URL(href).host)} ${uiCopy.external.newTab}`,
    );
    expect(await isActive(open), path).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog, path).toBeHidden();
    expect(await isActive(link), path).toBe(true);
    await link.click();
    await cancel.click();
    await expect(dialog, path).toBeHidden();
    expect(await isActive(link), path).toBe(true);
    expect(popups, path).toBe(0);
    await link.click();
    const popupEvent = context.waitForEvent("page");
    await open.click();
    const popup = await popupEvent;
    await popup.waitForLoadState("domcontentloaded");
    expect(popup.url(), path).toBe(href);
    expect(await popup.evaluate(() => window.opener === null), path).toBe(true);
    await popup.close();
    await expect(dialog, path).toBeHidden();
    expect(await isActive(link), path).toBe(true);
    popups = 0;
  }
});

test("the App Store confirmation delegates the published destination to the browser", async ({
  page,
}) => {
  await openPage(page, "/about");
  await page.evaluate(() => {
    window.open = (url, target, features): null => {
      document.documentElement.dataset.externalOpen = JSON.stringify([
        String(url),
        target,
        features,
      ]);
      return null;
    };
  });
  const link = page.getByRole("link", {
    name: /^App Storeでアプリを見る/u,
  });
  await expect(link).toHaveAttribute("href", appStoreUrl);
  const dialog = confirmation(page);
  const html = page.locator("html");
  await link.click();
  await expect(dialog).toHaveAccessibleDescription(
    `${destinations.appStore} ${uiCopy.external.host("apps.apple.com")} ${uiCopy.external.newTab}`,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await isActive(link)).toBe(true);
  await expect(html).not.toHaveAttribute("data-external-open");
  await link.click();
  await dialog.getByRole("button", { name: uiCopy.external.cancel }).click();
  await expect(dialog).toBeHidden();
  expect(await isActive(link)).toBe(true);
  await expect(html).not.toHaveAttribute("data-external-open");
  await link.click();
  await dialog.getByRole("button", { name: uiCopy.external.open }).click();
  await expect(html).toHaveAttribute(
    "data-external-open",
    JSON.stringify([appStoreUrl, "_blank", "noopener,noreferrer"]),
  );
  await expect(dialog).toBeHidden();
  expect(await isActive(link)).toBe(true);
});

test("modified and middle-button activations leave external links to the browser", async ({
  page,
}) => {
  await openPage(page, "/privacy");
  const link = page.getByRole("link", {
    name: /^Cloudflareのプライバシーを見る/u,
  });
  await page.evaluate(() => {
    for (const type of ["click", "auxclick"])
      window.addEventListener(type, (event) => {
        if (!(event instanceof MouseEvent)) return;
        document.documentElement.dataset[type] =
          `${event.button}:${event.defaultPrevented}`;
        event.preventDefault();
      });
  });
  const activations: readonly [
    Parameters<Locator["click"]>[0],
    "click" | "auxclick",
    number,
  ][] = [
    [{ modifiers: ["ControlOrMeta"] }, "click", 0],
    [{ modifiers: ["Shift"] }, "click", 0],
    [{ modifiers: ["Alt"] }, "click", 0],
    [{ button: "middle" }, "auxclick", 1],
  ];
  for (const [options, type, button] of activations) {
    await link.click(options);
    await expect(page.locator("html")).toHaveAttribute(
      `data-${type}`,
      `${button}:false`,
    );
    await expect(confirmation(page)).toBeHidden();
    await page.locator("html").evaluate((html) => {
      delete html.dataset.click;
      delete html.dataset.auxclick;
    });
  }
  await link.click();
  await expect(page.locator("html")).toHaveAttribute("data-click", "0:true");
  await expect(confirmation(page)).toBeVisible();
});

test("external links keep isolated navigation without JavaScript", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The browser test server URL is required");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    await stubOtherSites(context, new URL(baseURL).origin);
    const page = await context.newPage();
    for (const [path, name, target] of [
      [
        "/privacy",
        "Cloudflareのプライバシーを見る",
        "https://www.cloudflare.com/privacypolicy/",
      ],
      [
        "/about",
        "プログラムと決まりを見る",
        "https://github.com/P4suta/public-phonebook",
      ],
    ] as const) {
      await page.goto(path);
      const popupEvent = context.waitForEvent("page");
      await page
        .getByRole("link", { name: `${name} （新しいタブ）`, exact: true })
        .click();
      const popup = await popupEvent;
      await popup.waitForLoadState("domcontentloaded");
      expect(popup.url()).toBe(target);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
      await expect(confirmation(page)).toBeHidden();
    }
    await page.goto("/about");
    const link = page.getByRole("link", {
      name: /^App Storeでアプリを見る/u,
    });
    await expect(link).toHaveAttribute("href", appStoreUrl);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(confirmation(page)).toBeHidden();
  } finally {
    await context.close();
  }
});

for (const width of [320, 1440])
  test(`the confirmation dialog keeps the design rules at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openPage(page, "/privacy");
    const link = page.getByRole("link", {
      name: /^Cloudflareのプライバシーを見る/u,
    });
    await link.focus();
    await page.keyboard.press("Enter");
    const dialog = confirmation(page);
    await expect(dialog).toBeVisible();
    const open = dialog.getByRole("button", {
      name: uiCopy.external.open,
      exact: true,
    });
    expect(await isActive(open)).toBe(true);
    expect(
      await open.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).outlineWidth),
      ),
    ).toBeGreaterThanOrEqual(foundation.control.focus);
    expect((await auditDesign(page)).violations).toEqual([]);
    expect(await actionIconIssues(page)).toEqual([]);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    for (const button of await dialog.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimumTarget);
    }
    const bounds = await dialog.boundingBox();
    if (!bounds) throw new Error("The confirmation dialog is hidden");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await recordViewport(page, info, `external-link-dialog-${width}`);
  });

test("every screen preserves external navigation and the gate rejects missing protections", async ({
  page,
  httpFailures,
}) => {
  const raw: unknown = await (
    await page.request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const contact = v.parse(SearchResponseSchema, raw).data[0];
  if (!contact) throw new Error("The external-link fixture is missing");
  const path = `/contacts/${encodeURIComponent(contact.id)}`;
  let external = 0;
  httpFailures.add(404);
  for (const route of [
    "/",
    "/about",
    "/?q=国立国会図書館",
    path,
    `${path}/source`,
    "/data",
    "/privacy",
    "/support",
    "/missing-page",
  ]) {
    await page.goto(route);
    expect(await page.locator("a[href]").count(), route).toBeGreaterThan(0);
    expect(await externalLinkIssues(page), route).toEqual([]);
    expect(await externalScriptIssues(page), route).toEqual([]);
    expect(await actionIconIssues(page), route).toEqual([]);
    external += await page
      .locator("a[href]")
      .evaluateAll(
        (links) =>
          links.filter(
            (link) =>
              link instanceof HTMLAnchorElement &&
              ["http:", "https:"].includes(link.protocol) &&
              link.origin !== location.origin,
          ).length,
      );
  }
  expect(external).toBeGreaterThan(3);
  await page.goto("/about");
  await page.locator("main").evaluate((main) => {
    const probe = main.querySelector('a[href="/privacy"]')?.cloneNode(true);
    if (!(probe instanceof HTMLElement))
      throw new Error("The action icon probe is missing");
    probe.querySelector("svg")?.remove();
    main.appendChild(probe);
  });
  expect(await actionIconIssues(page)).toEqual([
    "action-icon: プライバシーについて読む",
  ]);
  await page.goto("/data");
  const link = page
    .getByRole("link", { name: /データを使うときの決まりを見る/u })
    .first();
  await link.evaluate((node) => {
    node.removeAttribute("target");
    node.removeAttribute("rel");
  });
  const issues = await externalLinkIssues(page);
  expect(issues.some((issue) => issue.startsWith("new-tab:"))).toBe(true);
  expect(issues.some((issue) => issue.startsWith("opener-isolation:"))).toBe(
    true,
  );
  await link.evaluate((node) => {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  });
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.src = "https://example.invalid/probe.js";
    script.dataset.externalProbe = "";
    document.body.appendChild(script);
  });
  expect(await externalScriptIssues(page)).toEqual([
    "external-script: https://example.invalid/probe.js",
  ]);
  await page.locator("script[data-external-probe]").evaluate((node) => {
    node.remove();
  });
});
