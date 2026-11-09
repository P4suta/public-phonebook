import {
  test as base,
  type ConsoleMessage,
  expect,
  type Page,
} from "@playwright/test";
import { iconIdPrefix } from "../../src/ui/icon-catalog.ts";

const accessControlFailure = /(\S+) due to access control checks\.$/u;
const symbolExcerpt = 160;
const firefoxDriverScripts = "chrome://juggler/";
const abortedLoad = "NS_BINDING_ABORTED";

/**
 * Firefox's driver loads its own scripts into each worker it attaches to.
 * When the page ends a worker during that bootstrap, the driver reports the aborted load from its chrome script, where no page code runs.
 */
function driverBootstrapAbort(message: ConsoleMessage): boolean {
  return (
    message.location().url.startsWith(firefoxDriverScripts) &&
    message.text().includes(abortedLoad)
  );
}

/**
 * WebKit reports a fetch that a navigation cancelled as an access-control failure, sometimes as a page error.
 * A same-origin request can't fail access control, so that report can only mean the cancellation.
 */
function sameOriginCancellation(message: string, origin: string): boolean {
  const target = accessControlFailure.exec(message)?.[1];
  const { host } = new URL(origin);
  return (
    target !== undefined &&
    [`${origin}/`, `//${host}/`, `/${host}/`].some((prefix) =>
      target.startsWith(prefix),
    )
  );
}

export async function externalLinkIssues(
  page: Page,
): Promise<readonly string[]> {
  return page.locator("a[href]").evaluateAll((links) =>
    links.flatMap((link) => {
      if (!(link instanceof HTMLAnchorElement)) return [];
      const url = new URL(link.href);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin === location.origin
      )
        return [];
      const issues: string[] = [];
      if (link.target !== "_blank") issues.push(`new-tab: ${link.href}`);
      if (
        !link.relList.contains("noopener") ||
        !link.relList.contains("noreferrer")
      )
        issues.push(`opener-isolation: ${link.href}`);
      const name = link.getAttribute("aria-label") ?? link.textContent ?? "";
      if (!name.includes("新しいタブ"))
        issues.push(`new-tab-announcement: ${link.href}`);
      // The map action draws its own map pin, and its confirmation names the new tab.
      const icon =
        link.dataset.externalDestination === "address"
          ? "map-pin"
          : "external-link";
      if (link.querySelectorAll(`svg[data-icon="${icon}"]`).length !== 1)
        issues.push(`new-tab-icon: ${link.href}`);
      return issues;
    }),
  );
}

/** Lists rendered symbols that don't draw a named master from the document's one sprite. */
export async function symbolIssues(page: Page): Promise<readonly string[]> {
  return page.locator("svg").evaluateAll(
    (symbols, { prefix, excerpt }) => {
      const sprites = document.querySelectorAll("svg[data-icon-sprite]");
      return symbols.flatMap((symbol) => {
        if (symbol.hasAttribute("data-icon-sprite"))
          return sprites.length === 1 ? [] : ["sprite: not exactly one"];
        const name = symbol.getAttribute("data-icon");
        const target = `${prefix}${name ?? ""}`;
        const use = symbol.querySelector(":scope > use");
        return name &&
          symbol.childElementCount === 1 &&
          use?.getAttribute("href") === `#${target}` &&
          sprites[0]?.querySelector(`:scope > symbol[id="${target}"]`)
          ? []
          : [`symbol: ${symbol.outerHTML.slice(0, excerpt)}`];
      });
    },
    { prefix: iconIdPrefix, excerpt: symbolExcerpt },
  );
}

export async function actionIconIssues(page: Page): Promise<readonly string[]> {
  return page
    .locator('a[href]:not([href^="#"]), button')
    .evaluateAll((actions) =>
      actions.flatMap((action) => {
        if (
          !(action instanceof HTMLElement) ||
          action.getClientRects().length === 0
        )
          return [];
        const style = getComputedStyle(action);
        if (style.borderTopStyle === "none" || style.borderTopWidth === "0px")
          return [];
        return action.querySelector("svg, img")
          ? []
          : [`action-icon: ${action.textContent?.trim() ?? ""}`];
      }),
    );
}

export async function externalScriptIssues(
  page: Page,
): Promise<readonly string[]> {
  return page.locator("script[src]").evaluateAll((scripts) =>
    scripts.flatMap((script) => {
      const url = new URL(script.getAttribute("src") ?? "", location.href);
      return url.origin === location.origin
        ? []
        : [`external-script: ${url.href}`];
    }),
  );
}

export const browserTest = base.extend({
  context: async ({ context, browserName, playwright }, use): Promise<void> => {
    if (browserName !== "webkit") {
      await use(context);
      return;
    }
    const regular = await playwright.webkit.launchPersistentContext("");
    try {
      await use(regular);
    } finally {
      await regular.close();
    }
  },
});

export const test = browserTest.extend<{
  diagnostics: void;
  httpFailures: Set<number>;
}>({
  httpFailures: async ({ baseURL }, use): Promise<void> => {
    if (!baseURL) throw new Error("The browser test server URL is required");
    await use(new Set());
  },
  diagnostics: [
    async ({ page, httpFailures, baseURL }, use, info): Promise<void> => {
      if (!baseURL) throw new Error("The browser test server URL is required");
      const origin = new URL(baseURL).origin;
      const errors: string[] = [];
      page.on("request", (request) => {
        if (
          request.resourceType() === "script" &&
          new URL(request.url()).origin !== origin
        )
          errors.push(`Unexpected script request: ${request.url()}`);
      });
      const driverAborts: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error")
          (driverBootstrapAbort(message) ? driverAborts : errors).push(
            message.text(),
          );
      });
      await use();
      if (!page.isClosed()) {
        expect(
          await externalLinkIssues(page),
          "External web links must preserve the current page and announce new tabs",
        ).toEqual([]);
        expect(
          await externalScriptIssues(page),
          "Scripts must come from the site's own origin",
        ).toEqual([]);
        expect(
          await symbolIssues(page),
          "Every rendered symbol must draw a named master from the sprite",
        ).toEqual([]);
      }
      await info.attach("browser-errors", {
        body: JSON.stringify(errors, null, 2),
        contentType: "application/json",
      });
      await info.attach("driver-bootstrap-aborts", {
        body: JSON.stringify(driverAborts, null, 2),
        contentType: "application/json",
      });
      expect(
        errors.filter((message) => {
          const status = /^Failed to load resource:.*status of (\d+)/u.exec(
            message,
          )?.[1];
          return (
            (!status || !httpFailures.has(Number(status))) &&
            !sameOriginCancellation(message, origin)
          );
        }),
        "The browser must not report runtime or policy failures",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
