import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import * as v from "valibot";
import {
  type ReferenceOperation,
  referenceModel,
  referenceOperations,
} from "../../src/core/api-reference.ts";
import {
  referenceCopy,
  showsContractText,
  statusMeaning,
} from "../../src/ui/api-reference-copy.ts";
import { auditDesign } from "./design-policy.ts";
import { expect, test } from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

const library = "国立国会図書館";
const DatasetsSchema = v.object({
  files: v.array(v.object({ url: v.string(), bytes: v.number() })),
});

async function documentedOperations(
  request: APIRequestContext,
): Promise<readonly ReferenceOperation[]> {
  const document: unknown = await (
    await request.get("/api/openapi.json")
  ).json();
  return referenceOperations(referenceModel(document));
}

function operationName(operation: Pick<ReferenceOperation, "path">): string {
  return `GET ${operation.path}`;
}

function section(page: Page, id: string): Locator {
  return page.locator(`section#${id}`);
}

function submitButton(scope: Locator, path: string): Locator {
  return scope.getByRole("button", {
    name: `${referenceCopy.attempt.submit}（GET ${path}）`,
    exact: true,
  });
}

test("the server renders every documented operation with its navigation entry", async ({
  page,
  request,
  browserName,
}, info) => {
  const operations = await documentedOperations(request);
  expect(operations.length).toBeGreaterThanOrEqual(9);
  await page.goto("/developers");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Public Phonebook API",
      exact: true,
    }),
  ).toHaveCount(1);
  const navigation = page.getByRole("navigation", {
    name: referenceCopy.navigation,
    exact: true,
  });
  await expect(navigation.getByRole("link")).toHaveCount(operations.length);
  for (const operation of operations) {
    const summary = referenceCopy.summaries[operation.id] ?? "";
    expect(summary, operation.id).not.toBe("");
    await expect(
      navigation.locator(`a[href="#${operation.id}"]`),
      operation.id,
    ).toHaveText(`${summary}${operationName(operation)}`);
    const item = section(page, operation.id);
    await expect(
      item.getByRole("heading", {
        level: 3,
        name: operationName(operation),
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(item.getByText(summary, { exact: true })).toHaveCount(1);
    await expect(
      item.getByText(operation.summary, { exact: true }),
    ).toHaveCount(showsContractText ? 1 : 0);
    await expect(
      item.locator('[lang="en"]').getByText(operation.summary, { exact: true }),
    ).toHaveCount(showsContractText ? 1 : 0);
    const tables = item.getByRole("table");
    await expect(tables).toHaveCount(operation.parameters.length > 0 ? 2 : 1);
    await expect(tables.last().locator("tbody tr")).toHaveCount(
      operation.responses.length,
    );
    for (const response of operation.responses)
      await expect(tables.last()).toContainText(
        `${response.status}${statusMeaning(Number(response.status))}`,
      );
    if (operation.parameters.length > 0)
      await expect(tables.first().locator("tbody tr")).toHaveCount(
        operation.parameters.length,
      );
    for (const parameter of operation.parameters)
      await expect(
        item.getByLabel(new RegExp(`^${parameter.name}（`, "u")),
      ).toHaveCount(1);
    await expect(item.locator("figure pre")).toHaveCount(2);
    await expect(submitButton(item, operation.path)).toBeVisible();
  }
  await expect(
    page.getByRole("link", { name: referenceCopy.openapi, exact: true }),
  ).toHaveAttribute("href", "/api/openapi.json");
  const audit = await auditDesign(page);
  await info.attach("api-palette", {
    body: JSON.stringify(audit),
    contentType: "application/json",
  });
  expect(audit.violations).toEqual([]);
  if (browserName === "chromium")
    await page.screenshot({ path: info.outputPath("api-reference.png") });
});

test("direct operation links open their section and survive a reload", async ({
  page,
}) => {
  await page.goto("/developers#searchContacts");
  const target = section(page, "searchContacts");
  await expect(target).toBeInViewport();
  await page.reload();
  await expect(target).toBeInViewport();
  await page
    .getByRole("navigation", { name: referenceCopy.navigation, exact: true })
    .locator('a[href="#locateContactRow"]')
    .click();
  await expect(page).toHaveURL(/\/developers#locateContactRow$/u);
  await expect(section(page, "locateContactRow")).toBeInViewport();
});

test("code examples copy their exact text", async ({
  page,
  context,
  browserName,
  baseURL,
}) => {
  if (!baseURL) throw new Error("The clipboard test needs its server origin");
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: baseURL,
    });
  await page.addInitScript(() => {
    const write = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string): Promise<void> => {
      await write(text);
      document.documentElement.dataset.copied = text;
    };
  });
  await page.goto("/developers");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const item = section(page, "searchContacts");
  for (const [language, expected] of [
    ["curl", /^curl --get '.+\/api\/contacts' \\\n {2}--data-urlencode 'q=/u],
    ["JavaScript", /\/api\/contacts"\);\n(?:.+\n)*.+"limit", "5"\);\n.+fetch\(url\);/u],
  ] as const) {
    const code = await item
      .locator("figure")
      .filter({ hasText: language })
      .locator("pre")
      .textContent();
    expect(code).toMatch(expected);
    await item
      .getByRole("button", {
        name: `${referenceCopy.copyExample(language)}（GET /api/contacts）`,
        exact: true,
      })
      .click();
    await expect(
      item.getByText(`${language}のコード例をコピーしました。`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied",
      code ?? "",
    );
    if (browserName === "chromium")
      expect(
        await page.evaluate(async () => navigator.clipboard.readText()),
      ).toBe(code);
  }
});

test("the request form sends a request and shows the response with JavaScript", async ({
  page,
  baseURL,
  httpFailures,
}) => {
  if (!baseURL) throw new Error("The request form needs its server origin");
  const outside: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL).origin)
      outside.push(request.url());
  });
  httpFailures.add(400);
  await page.goto("/developers");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const item = section(page, "searchContacts");
  await expect(item.getByLabel(/^q（/u)).toHaveValue(library);
  await expect(item.getByLabel(/^limit（/u)).toHaveValue("5");
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/contacts",
  );
  await submitButton(item, "/api/contacts").click();
  const response = await sent;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get("q")).toBe(library);
  const result = item.locator("#searchContacts-response");
  await expect(result.getByRole("status")).toHaveText(
    referenceCopy.attempt.status(200),
  );
  await expect(
    result.getByRole("figure", { name: referenceCopy.attempt.body }),
  ).toContainText(`"name": "${library}"`);
  expect(new URL(page.url()).search).toBe("");
  await item.getByLabel(/^limit（/u).fill("101");
  const rejected = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === "/api/contacts" &&
      new URL(reply.url()).searchParams.get("limit") === "101",
  );
  await submitButton(item, "/api/contacts").click();
  expect((await rejected).status()).toBe(400);
  await expect(result.getByRole("status")).toHaveText(
    referenceCopy.attempt.status(400),
  );
  await expect(result).toContainText("application/problem+json");
  await expect(result).toContainText('"code": "invalid_query"');
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  expect((await auditDesign(page)).violations).toEqual([]);
  expect(outside).toEqual([]);
});

test("the request form works without JavaScript through a normal submission", async ({
  browser,
  baseURL,
  request,
}) => {
  if (!baseURL) throw new Error("The request form needs its server origin");
  const datasets = v.parse(
    DatasetsSchema,
    await (await request.get("/api/datasets")).json(),
  );
  const [archive] = datasets.files;
  if (!archive) throw new Error("The dataset fixture is missing");
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
    ignoreHTTPSErrors: true,
  });
  const outside: string[] = [];
  context.on("request", (event) => {
    if (new URL(event.url()).origin !== new URL(baseURL).origin)
      outside.push(event.url());
  });
  try {
    const page = await context.newPage();
    await page.goto("/developers");
    const search = section(page, "searchContacts");
    await search.getByLabel(/^q（/u).fill(library);
    await submitButton(search, "/api/contacts").click();
    await expect(page).toHaveURL(
      /\/developers\?operation=searchContacts&.*limit=5.*#searchContacts-response$/u,
    );
    const result = page.locator("#searchContacts-response");
    await expect(result.getByRole("status")).toHaveText(
      referenceCopy.attempt.status(200),
    );
    await expect(result).toContainText(`"name": "${library}"`);
    await expect(
      section(page, "searchContacts").getByLabel(/^q（/u),
    ).toHaveValue(library);
    await section(page, "searchContacts")
      .getByLabel(/^limit（/u)
      .fill("101");
    await submitButton(
      section(page, "searchContacts"),
      "/api/contacts",
    ).click();
    await expect(
      page.locator("#searchContacts-response").getByRole("status"),
    ).toHaveText(referenceCopy.attempt.status(400));
    await expect(page.locator("#searchContacts-response")).toContainText(
      '"code": "invalid_query"',
    );

    const contact = section(page, "getContact");
    await contact.getByLabel(/^id（/u).fill("fixture:0");
    await submitButton(contact, "/api/contacts/{id}").click();
    await expect(page).toHaveURL(/operation=getContact&id=fixture%3A0#/u);
    await expect(
      page.locator("#getContact-response").getByRole("status"),
    ).toHaveText(referenceCopy.attempt.status(200));
    await expect(page.locator("#getContact-response")).toContainText(
      `"id": "fixture:0"`,
    );

    await page.goto("/developers?operation=getContact&id=..");
    await expect(
      page.locator("#getContact-response").getByRole("status"),
    ).toHaveText(referenceCopy.attempt.incompletePath);

    const [snapshot = "", digest = "", file = ""] = archive.url
      .split("/")
      .slice(-3);
    const download = section(page, "downloadDataset");
    await download.getByLabel(/^snapshot（/u).fill(snapshot);
    await download.getByLabel(/^digest（/u).fill(digest);
    await download.getByLabel(/^file（/u).fill(file);
    await submitButton(
      download,
      "/api/datasets/{snapshot}/{digest}/{file}",
    ).click();
    await expect(
      page.locator("#downloadDataset-response").getByRole("status"),
    ).toHaveText(referenceCopy.attempt.status(200));
    await expect(page.locator("#downloadDataset-response")).toContainText(
      referenceCopy.attempt.binary(archive.bytes),
    );
    expect(outside).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the reference stays black and white in interaction states and the palette gate still detects planted colors", async ({
  page,
}) => {
  await page.goto("/developers");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const item = section(page, "searchContacts");
  await item.getByLabel(/^q（/u).focus();
  expect((await auditDesign(page)).violations).toEqual([]);
  await submitButton(item, "/api/contacts").hover();
  expect((await auditDesign(page)).violations).toEqual([]);
  await item.getByLabel(/^category（/u).selectOption("library");
  await item.getByLabel(/^category（/u).focus();
  expect((await auditDesign(page)).violations).toEqual([]);
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
  expect(audit.violations).toContain(".unused-api-color: color=rgb(255, 0, 0)");
  expect(audit.violations).toContain("SPAN: color=rgb(255, 0, 0)");
  await page
    .locator("#palette-negative-control, #inline-palette-negative-control")
    .evaluateAll((nodes) => {
      for (const node of nodes) node.remove();
    });
  expect((await auditDesign(page)).violations).toEqual([]);
});
