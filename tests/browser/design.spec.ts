import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import * as v from "valibot";
import { SearchResponseSchema } from "../../src/core/models.ts";
import { auditDesign } from "./design-policy.ts";
import { expect, test } from "./fixtures.ts";

test.use({ video: "on" });

test("every retained Figma token has a defined CSS variable", async ({
  page,
}) => {
  const raw: unknown = JSON.parse(
    await readFile("docs/design-system.json", "utf8"),
  );
  const spec = v.parse(
    v.object({
      variables: v.array(
        v.object({
          syntax: v.pipe(v.string(), v.regex(/^var\(--dial-[a-z0-9-]+\)$/)),
        }),
      ),
    }),
    raw,
  );
  expect(spec.variables.length).toBeGreaterThan(0);
  await page.goto("/");
  const missing = await page.evaluate(
    (names: string[]) => {
      const style = getComputedStyle(document.documentElement);
      return names.filter((name) => !style.getPropertyValue(name).trim());
    },
    spec.variables.map((variable) => variable.syntax.slice(4, -1)),
  );
  expect(missing).toEqual([]);
});

test("the palette gate accepts black and white and rejects prohibited styles", async ({
  page,
}) => {
  await page.goto("about:blank");
  for (const declaration of [
    "color:gray",
    "color:red",
    "background-color:color(srgb 0 0 0 / .1)",
    "opacity:.5",
    "background:linear-gradient(black,white)",
    "box-shadow:1px 1px black",
    "text-shadow:1px 1px black",
    "filter:blur(1px)",
    "mix-blend-mode:multiply",
    "mask-image:linear-gradient(black,transparent)",
    "fill-opacity:.5",
    "stroke-opacity:.5",
    "all:unset; color:red",
  ]) {
    await page.setContent(
      `<style>body { color:black; background:white } div { ${declaration} }</style><div>fixture</div>`,
    );
    expect((await auditDesign(page)).violations, declaration).not.toEqual([]);
  }
  await page.setContent(
    "<style>body { color:black; background:white } div { all:unset; border:2px solid black; opacity:1 }</style><div>fixture</div>",
  );
  expect((await auditDesign(page)).violations).toEqual([]);
  await page.setContent(
    "<style>body { color:color(srgb 0 0 0); background:color(srgb 1 1 1) } div { background:color(srgb 0 0 0 / 0) }</style><div>fixture</div>",
  );
  expect((await auditDesign(page)).violations).toEqual([]);
  await page.setContent(
    "<style>body { color:black; background:white } * { color:black !important; opacity:1 !important; mix-blend-mode:normal !important } .unused { color:red; opacity:.5; mix-blend-mode:multiply }</style><div>fixture</div>",
  );
  const isolated = (await auditDesign(page)).violations;
  expect(isolated).toContain(".unused: color=rgb(255, 0, 0)");
  expect(isolated).toContain(".unused: opacity=0.5");
  expect(isolated).toContain(".unused: mix-blend-mode=multiply");
});

for (const width of [320, 390, 1440]) {
  test(`layout, palette, and accessibility at ${width}px`, async ({
    page,
    request,
    httpFailures,
    browserName,
  }, info) => {
    httpFailures.add(400);
    httpFailures.add(404);
    const raw: unknown = await (
      await request.get("/api/contacts?q=国立国会図書館")
    ).json();
    const contact = v.parse(SearchResponseSchema, raw).data[0];
    if (!contact) throw new Error("Known visual fixture missing");
    const detail = `/contacts/${encodeURIComponent(contact.id)}`;
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [
      ["home", "/"],
      ["about", "/about"],
      ["results", "/?q=国立国会図書館&prefecture=13&category=library"],
      ["empty", "/?q=存在しない施設000000"],
      ["data", "/data"],
      ["api", "/developers"],
      ["detail", detail],
      ["source", `${detail}/source`],
      ["invalid", "/?prefecture=99"],
      ["missing", "/contacts/does-not-exist"],
    ]) {
      if (!name || !path) throw new Error("Missing visual case");
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute(
        "data-enhanced",
        "true",
      );
      if (name === "api")
        await expect(page.locator("[data-api-reference]")).toHaveAttribute(
          "data-ready",
          "true",
        );
      await page.evaluate(async () => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        name,
      ).toBe(true);
      const audit = await auditDesign(page);
      expect(audit.rules).toBeGreaterThan(20);
      expect(audit.elements).toBeGreaterThan(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      expect(audit.violations, name).toEqual([]);
      if (name === "home") {
        const searchbox = page.getByRole("searchbox");
        await expect(searchbox).not.toHaveAttribute("placeholder");
        const hint = page.locator("#directory-search-hint");
        await expect(hint).toBeVisible();
        expect(
          await hint.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
          "The persistent search hint must not be clipped",
        ).toBe(true);
        const [field, button] = await Promise.all(
          [
            searchbox,
            page.getByRole("button", { name: "電話番号をさがす" }),
          ].map(async (control) => control.boundingBox()),
        );
        if (!field || !button)
          throw new Error("The search controls are hidden");
        expect(
          button.y >= field.y + field.height ||
            button.x >= field.x + field.width,
          "The search button must sit beside or below the field",
        ).toBe(true);
      }
      for (const size of await page
        .locator("article [data-phone]")
        .evaluateAll((items) =>
          items.map((item) =>
            Number.parseFloat(getComputedStyle(item).fontSize),
          ),
        ))
        expect(size, name).toBe(name === "detail" ? 32 : 24);
      if (name === "results" || name === "detail") {
        const hierarchy = await page
          .locator("article")
          .first()
          .evaluate((card) => {
            const heading = card.querySelector("h1, h2");
            const phone = card.querySelector("[data-phone]");
            if (!heading || !phone)
              throw new Error("Missing contact hierarchy");
            return {
              heading: Number.parseFloat(getComputedStyle(heading).fontSize),
              phone: Number.parseFloat(getComputedStyle(phone).fontSize),
              height: card.getBoundingClientRect().height,
            };
          });
        expect(hierarchy.heading).toBe(name === "detail" ? 24 : 20);
        expect(hierarchy.phone / hierarchy.heading).toBeLessThanOrEqual(1.6);
        if (name === "results" && width >= 800)
          expect(hierarchy.height).toBeLessThanOrEqual(240);
      }
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations, name).toEqual([]);
      const controls = await page
        .locator("#main a, #main button, #main input, #main select")
        .evaluateAll((items) =>
          items
            .filter((item) => item.getClientRects().length > 0)
            .map((item) => ({
              label: item.textContent,
              height: item.getBoundingClientRect().height,
            })),
        );
      expect(
        controls.filter((control) => control.height < 44),
        name,
      ).toEqual([]);
      const clippedActions = await page
        .locator("#main a, #main button")
        .evaluateAll((items) =>
          items
            .filter(
              (node) =>
                node.getClientRects().length > 0 &&
                (node.scrollWidth > node.clientWidth + 1 ||
                  node.scrollHeight > node.clientHeight + 1),
            )
            .map((node) => ({
              text: node.textContent,
              client: [node.clientWidth, node.clientHeight],
              scroll: [node.scrollWidth, node.scrollHeight],
              box: node.getBoundingClientRect(),
              children: Array.from(node.children).map((child) => ({
                tag: child.tagName,
                box: child.getBoundingClientRect(),
                lineHeight: getComputedStyle(child).lineHeight,
                fontSize: getComputedStyle(child).fontSize,
              })),
            })),
        );
      expect(clippedActions, name).toEqual([]);
      if (name === "api") {
        const lines = await page
          .getByRole("button", { name: "API仕様書のURLをコピー", exact: true })
          .evaluate((button) => {
            const tops = new Set<number>();
            const walker = document.createTreeWalker(
              button,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const rect of range.getClientRects())
                tops.add(Math.round(rect.top));
            }
            return tops.size;
          });
        expect(lines, "The schema URL action should fit on one line").toBe(1);
      }
      if (browserName !== "webkit")
        await page.screenshot({
          path: info.outputPath(`${name}-${width}.png`),
          fullPage: name !== "data",
        });
      if (name === "results" && width < 600) {
        const prefecture = await page
          .getByLabel("都道府県", { exact: true })
          .boundingBox();
        const municipality = await page
          .getByLabel("市区町村", { exact: true })
          .boundingBox();
        expect(
          prefecture &&
            municipality &&
            Math.abs(prefecture.y - municipality.y) < 1,
        ).toBe(true);
      }
    }
  });
}

for (const width of [320, 1440]) {
  test(`contact text can double without clipping or horizontal page scroll at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?q=国立国会図書館&prefecture=13&category=library");
    await page.evaluate(() => {
      const nonce = document.querySelector<HTMLMetaElement>(
        'meta[property="csp-nonce"]',
      )?.content;
      if (!nonce) throw new Error("The document nonce is missing");
      const sheet = document.createElement("style");
      sheet.nonce = nonce;
      sheet.textContent = ":root { font-size: 200%; }";
      document.head.appendChild(sheet);
    });
    await expect(page.locator("article").first()).toBeVisible();
    expect(
      await page
        .locator("[data-phone]")
        .first()
        .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ).toBe(48);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const clipped = await page
      .locator("article button, article a")
      .evaluateAll((items) =>
        items
          .filter(
            (node) =>
              node.scrollWidth > node.clientWidth + 1 ||
              node.scrollHeight > node.clientHeight + 1,
          )
          .map((node) => ({
            text: node.textContent,
            client: [node.clientWidth, node.clientHeight],
            scroll: [node.scrollWidth, node.scrollHeight],
            box: node.getBoundingClientRect(),
            children: Array.from(node.children).map((child) => ({
              tag: child.tagName,
              box: child.getBoundingClientRect(),
              lineHeight: getComputedStyle(child).lineHeight,
              fontSize: getComputedStyle(child).fontSize,
            })),
          })),
      );
    expect(clipped).toEqual([]);
  });
}
