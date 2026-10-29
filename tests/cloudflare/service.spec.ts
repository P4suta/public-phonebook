import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  checkCards,
  contacts,
  contents,
  coverage,
  download,
  object,
  string,
} from "../e2e/support.js";

test("the Cloudflare runtime and Linux container serve the same identified national snapshot", async ({
  request,
}) => {
  const health = await request.get("/healthz");
  expect(health.status()).toBe(200);
  const body: unknown = await health.json();
  object(body);
  expect(body.status).toBe("ok");
  const snapshot = string(body.snapshot);
  expect(snapshot).toMatch(/^[0-9a-f]{64}$/);
  const manifest: unknown = JSON.parse(
    await readFile("data/service/snapshot.json", "utf8"),
  );
  object(manifest);
  expect(manifest.schema).toBe(1);
  expect(snapshot).toBe(string(manifest.sha256));
  expect(body.contacts).toBe(manifest.contacts);
  expect(health.headers()["x-public-phonebook-snapshot"]).toBe(snapshot);
  const report = coverage(await (await request.get("/coverage.json")).json());
  expect(body.contacts).toBe(report.total_contacts);
  expect(report.prefectures_covered).toBe(47);
  expect(report.cells).toHaveLength(47 * 39);
});

test("real search, vCard saving and source navigation work through the Worker", async ({
  page,
  baseURL,
}) => {
  if (baseURL === undefined) throw new Error("Missing target origin");
  const origin = new URL(baseURL).origin;
  const errors: string[] = [];
  const remote: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) remote.push(request.url());
  });
  await page.goto("/?q=横浜市役所&category=municipal_office");
  await expect(page.locator(".contact")).toHaveCount(1);
  await expect(page.locator("a.phone").first()).toHaveAttribute(
    "href",
    /^tel:\+81[0-9]+$/,
  );
  const records = contacts(await contents(await download(page, "JSON ↓")));
  expect(records[0]?.name).toBe("横浜市役所");
  checkCards(await contents(await download(page, "連絡先に保存")), 1);
  await page.getByRole("link", { name: "くわしく", exact: true }).click();
  await page
    .getByRole("link", { name: "この番号の出典を見る", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "この番号の出典", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "連絡先に もどる", exact: true })
    .click();
  await page.getByRole("link", { name: "結果に もどる", exact: true }).click();
  await expect(page.getByLabel("施設名か電話番号")).toHaveValue("横浜市役所");
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});

test("privacy and browser protections survive Worker, origin and routing errors", async ({
  request,
}) => {
  for (const [path, status] of [
    ["/", 200],
    ["/?prefecture=48", 400],
    ["/missing", 404],
  ] as const) {
    const response = await request.get(path, {
      headers: { "x-request-id": "untrusted", cookie: "private=value" },
    });
    expect(response.status()).toBe(status);
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers()["cache-control"]).toBe("no-store, no-transform");
    expect(await response.text()).not.toContain(
      "static.cloudflareinsights.com",
    );
    expect(response.headers()["x-request-id"]).not.toBe("untrusted");
    expect(response.headers()["x-public-phonebook-snapshot"]).toMatch(
      /^[0-9a-f]{64}$/,
    );
  }
  const rejected = await request.post("/");
  expect(rejected.status()).toBe(405);
  expect(rejected.headers().allow).toBe("GET, HEAD");
  const head = await request.head("/export?format=csv");
  expect(head.status()).toBe(200);
  expect(await head.body()).toHaveLength(0);
  const next = await request.get(
    "/export?format=json&q=横浜市役所&category=municipal_office",
  );
  expect(next.status()).toBe(200);
  expect(contacts(await next.text())).toHaveLength(1);
});

test("Cloudflare asset delivery preserves exact files and cache validators", async ({
  request,
}) => {
  for (const path of [
    "style.css",
    "app.js",
    "api.js",
    "icons/search.svg",
    "fonts/noto-sans-jp.woff2",
    "fonts/OFL.txt",
  ]) {
    const response = await request.get(`/${path}?q=discarded`);
    expect(response.status()).toBe(200);
    expect(
      createHash("sha256")
        .update(await response.body())
        .digest("hex"),
    ).toBe(
      createHash("sha256")
        .update(await readFile(`static/${path}`))
        .digest("hex"),
    );
    const etag = response.headers().etag;
    expect(etag).toBeDefined();
    const unchanged = await request.get(`/${path}`, {
      headers: { "if-none-match": etag ?? "missing" },
    });
    expect(unchanged.status()).toBe(304);
    expect(unchanged.headers()["cache-control"]).toBe(
      "public, max-age=0, must-revalidate",
    );
  }
});

test("the Cloudflare page loads its local font, fits the viewport and passes accessibility checks", async ({
  page,
}, info) => {
  await page.goto("/?prefecture=13&category=library");
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(() =>
      Array.from(document.fonts).some(
        (face) =>
          face.family.includes("Noto Sans JP") && face.status === "loaded",
      ),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const report = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(report.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("cloudflare-directory.png"),
    fullPage: false,
  });
});
