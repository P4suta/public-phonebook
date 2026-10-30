import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import {
  expect,
  externalLinkIssues,
  externalScriptIssues,
  test,
} from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

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
    "/?q=国立国会図書館",
    path,
    `${path}/source`,
    "/data",
    "/developers",
    "/missing-page",
  ]) {
    await page.goto(route);
    if (route === "/developers")
      await expect(page.locator("[data-api-reference]")).toHaveAttribute(
        "data-ready",
        "true",
      );
    expect(await page.locator("a[href]").count(), route).toBeGreaterThan(0);
    expect(await externalLinkIssues(page), route).toEqual([]);
    expect(await externalScriptIssues(page), route).toEqual([]);
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
  await page.goto("/data");
  const link = page.getByRole("link", { name: /利用条件を見る/u }).first();
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
