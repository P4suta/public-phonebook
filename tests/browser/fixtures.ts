import { test as base, expect, type Page } from "@playwright/test";

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
      if (!link.querySelector("svg.lucide-external-link"))
        issues.push(`new-tab-icon: ${link.href}`);
      return issues;
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

export const test = base.extend<{
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
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
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
      }
      await info.attach("browser-errors", {
        body: JSON.stringify(errors, null, 2),
        contentType: "application/json",
      });
      expect(
        errors.filter((message) => {
          const status = /^Failed to load resource:.*status of (\d+)/u.exec(
            message,
          )?.[1];
          return !status || !httpFailures.has(Number(status));
        }),
        "The browser must not report runtime or policy failures",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
