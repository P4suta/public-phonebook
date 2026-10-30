import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import * as v from "valibot";
import { auditDesign } from "./design-policy.ts";
import { expect, test } from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

async function openNavigation(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) < 1024)
    await page
      .getByRole("button", { name: "APIの一覧を開く", exact: true })
      .click();
}

test("the generated API reference includes every public operation", async ({
  page,
  request,
  browserName,
}, info) => {
  const raw: unknown = await (await request.get("/api/openapi.json")).json();
  const schema = v.parse(
    v.object({
      paths: v.record(
        v.string(),
        v.object({ get: v.optional(v.object({ summary: v.string() })) }),
      ),
    }),
    raw,
  );
  const summaries = Object.values(schema.paths).flatMap((path) =>
    path.get ? [path.get.summary] : [],
  );
  expect(summaries.length).toBeGreaterThanOrEqual(9);
  await page.goto("/developers");
  const reference = page.locator("[data-api-reference]");
  await expect(reference).toHaveAttribute("data-ready", "true");
  await expect(
    reference.getByRole("heading", {
      name: "Public Phonebook API",
      exact: true,
    }),
  ).toHaveCount(1);
  await openNavigation(page);
  for (const summary of summaries)
    await expect(reference.getByRole("link", { name: summary })).toHaveCount(1);
  await reference
    .getByRole("link", {
      name: "Preview matching contacts in every facility category",
    })
    .click();
  await expect(
    reference.getByText("/api/contact-groups", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "OpenAPI（JSON）を見る", exact: true }),
  ).toHaveAttribute("href", "/api/openapi.json");
  const audit = await auditDesign(page);
  const inlineStyles = await page
    .locator("style, [style]")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        tag: node.tagName,
        class: node.getAttribute("class"),
        css:
          node.tagName === "STYLE"
            ? (node.textContent ?? "")
            : (node.getAttribute("style") ?? ""),
        nonce: node instanceof HTMLStyleElement ? node.nonce : "",
      })),
    );
  await info.attach("inline-style-inventory", {
    body: JSON.stringify(
      inlineStyles.map((entry) => ({
        ...entry,
        hash: `sha256-${createHash("sha256").update(entry.css).digest("base64")}`,
      })),
      null,
      2,
    ),
    contentType: "application/json",
  });
  await info.attach("api-palette", {
    body: JSON.stringify(audit),
    contentType: "application/json",
  });
  expect(audit.violations).toEqual([]);
  if (browserName === "chromium")
    await page.screenshot({
      path: info.outputPath("api-reference.png"),
      fullPage: false,
    });
});

test("a native API request can be sent from the generated client", async ({
  page,
  httpFailures,
  baseURL,
  browserName,
}, info) => {
  if (!baseURL) throw new Error("The API reference needs its server origin");
  const outside: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).origin !== new URL(baseURL).origin &&
      !request.url().startsWith("data:")
    )
      outside.push(request.url());
  });
  httpFailures.add(400);
  await page.goto("/developers");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  const summary =
    "Search facilities by name, telephone number, category, and region";
  await openNavigation(page);
  await page.getByRole("link", { name: summary }).click();
  await page
    .getByRole("region", { name: summary, exact: true })
    .getByRole("button", {
      name: "リクエストを試す (get /api/contacts)",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const close = dialog.getByRole("button", {
    name: "APIを試す画面を閉じる",
    exact: true,
  });
  await expect(close).toBeInViewport({ ratio: 1 });
  expect(
    await close.evaluate((button) => {
      const style = getComputedStyle(button);
      return { color: style.color, background: style.backgroundColor };
    }),
  ).toEqual({ color: "rgb(255, 255, 255)", background: "rgb(0, 0, 0)" });
  const indicatorColors = await dialog
    .getByRole("checkbox")
    .evaluateAll((inputs) =>
      inputs.flatMap((input) => {
        if (!(input instanceof HTMLInputElement)) return [];
        const icon = input.parentElement?.querySelector("svg");
        return icon
          ? [{ checked: input.checked, color: getComputedStyle(icon).color }]
          : [];
      }),
    );
  expect(indicatorColors.filter((item) => item.checked).length).toBeGreaterThan(
    0,
  );
  expect(
    indicatorColors.filter((item) => !item.checked).length,
  ).toBeGreaterThan(0);
  expect(
    indicatorColors.every(
      (item) =>
        item.color === (item.checked ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)"),
    ),
  ).toBe(true);
  const checkboxCells = await dialog
    .getByRole("checkbox")
    .evaluateAll((inputs) =>
      inputs.flatMap((input) => {
        const cell = input.closest("td");
        const next = cell?.nextElementSibling;
        if (!cell || !next) return [];
        const box = cell.getBoundingClientRect();
        const target = input.getBoundingClientRect();
        return [
          {
            label: input.getAttribute("aria-label"),
            width: target.width,
            height: target.height,
            contained:
              target.left >= box.left - 1 &&
              target.top >= box.top - 1 &&
              target.right <= box.right + 1 &&
              target.bottom <= box.bottom + 1,
            overlaps: box.right > next.getBoundingClientRect().left + 1,
          },
        ];
      }),
    );
  expect(checkboxCells.length).toBeGreaterThan(0);
  expect(
    checkboxCells.filter(
      (cell) =>
        cell.width < 44 || cell.height < 44 || !cell.contained || cell.overlaps,
    ),
  ).toEqual([]);
  await writeFile(
    info.outputPath("request-client.txt"),
    await dialog.ariaSnapshot(),
  );
  await info.attach("request-client", {
    body: await dialog.ariaSnapshot(),
    contentType: "text/plain",
  });
  const send = dialog.getByRole("button", {
    name: "リクエストを送信（get）",
    exact: true,
  });
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/contacts",
  );
  await send.click();
  const response = await sent;
  expect(response.status()).toBe(200);
  const result = v.parse(
    v.object({ data: v.array(v.object({ name: v.string() })) }),
    await response.json(),
  );
  expect(
    result.data.some((contact) => contact.name.includes("国立国会図書館")),
  ).toBe(true);
  await expect(
    dialog.getByRole("region", { name: "応答", exact: true }),
  ).toContainText("200");
  await writeFile(
    info.outputPath("response-client.txt"),
    await dialog.ariaSnapshot(),
  );
  await writeFile(
    info.outputPath("response-styles.json"),
    JSON.stringify(await page.locator("style").allTextContents(), null, 2),
  );
  const limit = dialog
    .getByRole("row")
    .filter({
      has: page.getByRole("checkbox", {
        name: "limitをリクエストに入れる",
        exact: true,
      }),
    })
    .getByRole("combobox", { name: "項目の値", exact: true });
  await limit.fill("101");
  const invalid = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === "/api/contacts" &&
      new URL(reply.url()).searchParams.get("limit") === "101",
  );
  await send.click();
  const rejected = await invalid;
  expect(rejected.status()).toBe(400);
  expect(rejected.headers()["content-type"]).toContain(
    "application/problem+json",
  );
  await expect(
    dialog.getByRole("region", { name: "応答", exact: true }),
  ).toContainText("400");
  await writeFile(
    info.outputPath("edited-styles.json"),
    JSON.stringify(await page.locator("style").allTextContents(), null, 2),
  );
  if (browserName === "chromium")
    await page.screenshot({ path: info.outputPath("api-client.png") });
  await writeFile(
    info.outputPath("client-dom.html"),
    await dialog.evaluate((node) => node.outerHTML),
  );
  const palette = await auditDesign(page);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  await writeFile(
    info.outputPath("client-accessibility.json"),
    JSON.stringify(accessibility, null, 2),
  );
  expect(palette.violations).toEqual([]);
  expect(
    accessibility.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  expect(outside).toEqual([]);
});

test("the generated reference can search operations with the keyboard", async ({
  page,
}) => {
  await page.goto("/developers");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await openNavigation(page);
  await page.getByRole("button", { name: /^APIをさがす/u }).click();
  const search = page.getByRole("dialog");
  const input = search.getByRole("combobox");
  await expect(input).toBeVisible();
  await input.fill("List source provenance");
  await expect(search).toContainText(
    "List source provenance and import results",
  );
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(page).toHaveURL(/#tag\/sources\//u);
});

test("an unavailable OpenAPI document has a readable retry action", async ({
  page,
  httpFailures,
}) => {
  httpFailures.add(503);
  await page.clock.setFixedTime(new Date("2026-10-30T00:00:00.000Z"));
  let unavailable = true;
  await page.route("**/api/openapi.json", async (route) => {
    if (unavailable) {
      unavailable = false;
      await route.fulfill({
        status: 503,
        contentType: "application/problem+json",
        body: JSON.stringify({ status: 503, title: "Temporarily unavailable" }),
      });
    } else await route.continue();
  });
  await page.goto("/developers");
  await expect(page.getByRole("alert")).toContainText(
    "APIの説明を読みこめませんでした",
  );
  await page
    .getByRole("button", { name: "APIの説明をもう一度読みこむ", exact: true })
    .click();
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  unavailable = true;
  await page.clock.setFixedTime(new Date("2026-10-30T00:02:00.000Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const reloaded = page.waitForResponse("**/api/openapi.json");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  expect((await reloaded).status()).toBe(503);
  await expect(page.getByRole("alert")).toContainText(
    "APIの説明を読みこめませんでした",
  );
  await page
    .getByRole("button", { name: "APIの説明をもう一度読みこむ", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Public Phonebook API", exact: true }),
  ).toBeVisible();
});

test("the reference palette gate still rejects owned declarations and rendered inline colors", async ({
  page,
}) => {
  await page.goto("/developers");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await page.evaluate(() => {
    const sheet = document.createElement("style");
    sheet.id = "palette-negative-control";
    sheet.nonce =
      document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
        ?.content ?? "";
    sheet.textContent = ".unused-api-color { color:red }";
    document.head.appendChild(sheet);
    const text = document.createElement("span");
    text.id = "inline-palette-negative-control";
    text.textContent = "Palette control";
    text.style.setProperty("color", "red", "important");
    document.body.appendChild(text);
  });
  const audit = await auditDesign(page);
  expect(audit.runtimeRules).toBeGreaterThan(0);
  expect(audit.violations).toContain(".unused-api-color: color=rgb(255, 0, 0)");
  expect(audit.violations).toContain("SPAN: color=rgb(255, 0, 0)");
  await page
    .locator("#palette-negative-control, #inline-palette-negative-control")
    .evaluateAll((nodes) => {
      for (const node of nodes) node.remove();
    });
  expect((await auditDesign(page)).violations).toEqual([]);
});

test("a generated code sample copies through the native clipboard", async ({
  page,
  context,
  browserName,
  baseURL,
}) => {
  if (browserName === "chromium") {
    if (!baseURL)
      throw new Error("The native clipboard needs its server origin");
    await context.grantPermissions(["clipboard-write"], { origin: baseURL });
  }
  await page.addInitScript(() => {
    const write = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async (
      items: ClipboardItems,
    ): Promise<void> => {
      await write(items);
      const first = items[0];
      if (!first) throw new Error("The native clipboard received no item");
      document.documentElement.dataset.codeSample = await (
        await first.getType("text/plain")
      ).text();
    };
    const exec = document.execCommand.bind(document);
    document.execCommand = (
      command: string,
      showUI?: boolean,
      value?: string,
    ): boolean => {
      const selected =
        document.querySelector<HTMLTextAreaElement>("textarea[readonly]");
      const text = selected?.value.slice(
        selected.selectionStart,
        selected.selectionEnd,
      );
      const copied = exec(command, showUI, value);
      if (command === "copy" && copied && text !== undefined)
        document.documentElement.dataset.codeSample = text;
      return copied;
    };
  });
  await page.goto("/developers");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await openNavigation(page);
  const summary =
    "Search facilities by name, telephone number, category, and region";
  await page.getByRole("link", { name: summary }).click();
  await page
    .getByRole("region", { name: summary, exact: true })
    .getByRole("button", { name: "コードをコピー", exact: true })
    .first()
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-code-sample",
    /fetch\(.+\/api\/contacts/u,
  );
  expect(await page.locator("html").getAttribute("data-code-sample")).toContain(
    "limit=5",
  );
});

test("the raw API contract remains accessible without JavaScript", async ({
  browser,
  baseURL,
}) => {
  if (!baseURL)
    throw new Error("The no-JavaScript reference needs its server origin");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    await page.goto("/developers");
    await expect(
      page.getByRole("heading", { name: "Public Phonebook API", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("APIの説明を読みこんでいます。", { exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByText(
        "APIの説明を操作するには、JavaScriptを有効にしてください。",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "OpenAPI（JSON）を見る", exact: true })
      .click();
    expect(new URL(page.url()).pathname).toBe("/api/openapi.json");
    await expect(page.locator("body")).toContainText('"openapi"');
  } finally {
    await context.close();
  }
});

test("the reference bundle loads on demand and direct operation links survive reload", async ({
  page,
}) => {
  const assets: string[] = [];
  page.on("request", (request) => {
    if (["script", "stylesheet"].includes(request.resourceType()))
      assets.push(request.url());
  });
  await page.goto("/?q=国立国会図書館");
  await expect(page.locator("article").first()).toBeVisible();
  expect(
    assets.filter(
      (asset) =>
        asset.includes("/api-reference-") ||
        asset.includes("/ServerVariablesForm"),
    ),
  ).toEqual([]);
  const summary =
    "Search facilities by name, telephone number, category, and region";
  await page.goto("/developers#tag/contacts/GET/api/contacts");
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(
    page.getByRole("region", { name: summary, exact: true }),
  ).toBeVisible();
  expect(assets.some((asset) => asset.includes("/api-reference-"))).toBe(true);
  await page.reload();
  await expect(page.locator("[data-api-reference]")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect(
    page.getByRole("region", { name: summary, exact: true }),
  ).toBeVisible();
});
