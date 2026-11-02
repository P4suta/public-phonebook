import type { APIResponse, Page } from "@playwright/test";
import * as v from "valibot";
import { ContactSchema } from "../../src/core/models.ts";
import { uiCopy } from "../../src/ui/copy.ts";
import { iconIdPrefix, siteIcons } from "../../src/ui/icon-catalog.ts";
import { type PageMatch, pageIcons } from "../../src/ui/route-icons.ts";
import { expect, test } from "./fixtures.ts";

const ok = 200;
const iconFileType = 1;
const iconHeaderBytes = 6;
const iconEntryBytes = 16;
const iconFullSize = 256;
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const pngRgba = 6;
const pngDepth = 8;
const rgbaBitsPerPixel = 32;
const paintedExtent = 0;
const fixtureContact = `/contacts/${encodeURIComponent("fixture:0")}`;
const spritePattern = /<svg[^>]*data-icon-sprite=""[^>]*>(.*?)<\/svg>/gsu;
const symbolPattern = /<symbol id="([^"]+)"/gu;
const usePattern = /<use href="#([^"]+)"/gu;

const ManifestSchema = v.object({
  name: v.string(),
  description: v.string(),
  start_url: v.literal("/"),
  display: v.literal("standalone"),
  icons: v.array(
    v.object({
      src: v.string(),
      sizes: v.pipe(v.string(), v.regex(/^\d+x\d+$/u)),
      type: v.literal("image/png"),
      purpose: v.picklist(["any", "maskable"]),
    }),
  ),
});

interface IconEntry {
  readonly size: string;
  readonly bits: number;
  readonly decoded: string;
  readonly ihdr: string;
}

function size(width: number, height: number): string {
  return `${width}x${height}`;
}

async function attribute(
  page: Page,
  selector: string,
  name: string,
): Promise<string> {
  const value = await page.locator(selector).getAttribute(name);
  if (value === null) throw new Error(`${selector} lacks ${name}`);
  return value;
}

async function served(
  response: APIResponse,
  type: string,
): Promise<APIResponse> {
  expect(response.status(), response.url()).toBe(ok);
  expect(response.headers()["content-type"], response.url()).toContain(type);
  return response;
}

/** Decodes an image with the browser's own decoders and reports its intrinsic size. */
async function decodedSize(page: Page, href: string): Promise<string> {
  const [width, height] = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, href);
  return size(width ?? 0, height ?? 0);
}

/** Reads a Windows icon directory and decodes each embedded image in the browser. */
async function iconEntries(
  page: Page,
  href: string,
): Promise<readonly IconEntry[]> {
  return page.evaluate(
    async ({ source, layout }) => {
      const bytes = new Uint8Array(await (await fetch(source)).arrayBuffer());
      const view = new DataView(bytes.buffer);
      if (
        view.getUint16(0, true) !== 0 ||
        view.getUint16(2, true) !== layout.type
      )
        throw new Error("Not a Windows icon directory");
      const entries = [];
      for (let index = 0; index < view.getUint16(4, true); index += 1) {
        const at = layout.header + layout.entry * index;
        const width = view.getUint8(at) || layout.full;
        const height = view.getUint8(at + 1) || layout.full;
        const length = view.getUint32(at + 8, true);
        const offset = view.getUint32(at + 12, true);
        const image = bytes.slice(offset, offset + length);
        if (layout.signature.some((byte, place) => image[place] !== byte))
          throw new Error("An icon image isn't a PNG");
        const header = new DataView(image.buffer);
        const bitmap = await createImageBitmap(
          new Blob([image], { type: "image/png" }),
        );
        entries.push({
          size: `${width}x${height}`,
          bits: view.getUint16(at + 6, true),
          decoded: `${bitmap.width}x${bitmap.height}`,
          ihdr: `${header.getUint32(16)}x${header.getUint32(20)}:${image[25]}:${image[24]}`,
        });
      }
      return entries;
    },
    {
      source: href,
      layout: {
        type: iconFileType,
        header: iconHeaderBytes,
        entry: iconEntryBytes,
        full: iconFullSize,
        signature: pngSignature,
      },
    },
  );
}

test("the server returns each declared site icon, the manifest, and the sharing image at its declared size", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const favicon = await attribute(page, 'link[rel="icon"][sizes]', "href");
  await served(await request.get(favicon), "image/");
  const declared = await attribute(page, 'link[rel="icon"][sizes]', "sizes");
  const entries = await iconEntries(page, favicon);
  expect(entries.map((entry) => entry.size).join(" ")).toBe(declared);
  for (const entry of entries)
    expect(entry).toEqual({
      size: entry.size,
      bits: rgbaBitsPerPixel,
      decoded: entry.size,
      ihdr: `${entry.size}:${pngRgba}:${pngDepth}`,
    });

  const vector = await attribute(
    page,
    'link[rel="icon"][type="image/svg+xml"]',
    "href",
  );
  await served(await request.get(vector), "image/svg+xml");
  expect(await decodedSize(page, vector)).not.toBe(size(0, 0));

  const touch = 'link[rel="apple-touch-icon"]';
  const touchIcon = await attribute(page, touch, "href");
  await served(await request.get(touchIcon), "image/png");
  expect(await decodedSize(page, touchIcon)).toBe(
    await attribute(page, touch, "sizes"),
  );

  const mask = await attribute(page, 'link[rel="mask-icon"]', "href");
  await served(await request.get(mask), "image/svg+xml");
  expect(await decodedSize(page, mask)).not.toBe(size(0, 0));

  const manifestResponse = await served(
    await request.get(await attribute(page, 'link[rel="manifest"]', "href")),
    "application/manifest+json",
  );
  const manifest = v.parse(ManifestSchema, await manifestResponse.json());
  expect(manifest.name).toBe(await page.title());
  expect(manifest.description).toBe(
    await attribute(page, 'meta[name="description"]', "content"),
  );
  const purposes = new Map<string, string[]>();
  for (const icon of manifest.icons) {
    await served(await request.get(icon.src), "image/png");
    expect(await decodedSize(page, icon.src), icon.src).toBe(icon.sizes);
    purposes.set(icon.sizes, [
      ...(purposes.get(icon.sizes) ?? []),
      icon.purpose,
    ]);
  }
  expect(purposes.size).toBeGreaterThan(0);
  for (const kinds of purposes.values())
    expect(kinds.sort()).toEqual(["any", "maskable"]);

  const sharing = new URL(
    await attribute(page, 'meta[property="og:image"]', "content"),
  );
  expect(sharing.protocol).toBe("https:");
  expect(sharing.pathname).toBe(siteIcons.socialPreview.href);
  await served(await request.get(sharing.pathname), "image/png");
  expect(await decodedSize(page, sharing.pathname)).toBe(
    size(
      Number(
        await attribute(page, 'meta[property="og:image:width"]', "content"),
      ),
      Number(
        await attribute(page, 'meta[property="og:image:height"]', "content"),
      ),
    ),
  );
});

test("each server render inlines one sprite with exactly the symbols its routes can draw", async ({
  request,
}) => {
  const contact = v.parse(
    ContactSchema,
    await (await request.get(`/api${fixtureContact}`)).json(),
  );
  const root = { routeId: "__root__" } as const;
  const pages: readonly (readonly [string, readonly PageMatch[]])[] = [
    ["/", [root, { routeId: "/" }]],
    [`/?q=${encodeURIComponent(contact.name)}`, [root, { routeId: "/" }]],
    [fixtureContact, [root, { routeId: "/contacts/$id", loaderData: contact }]],
    [`${fixtureContact}/source`, [root, { routeId: "/contacts/$id_/source" }]],
    ["/about", [root, { routeId: "/about" }]],
    ["/data", [root, { routeId: "/data" }]],
    ["/developers", [root, { routeId: "/developers" }]],
    ["/privacy", [root, { routeId: "/privacy" }]],
    ["/support", [root, { routeId: "/support" }]],
    ["/missing-page", [root]],
  ];
  for (const [path, matches] of pages) {
    const html = await (await request.get(path)).text();
    const sprites = [...html.matchAll(spritePattern)];
    expect(sprites, path).toHaveLength(1);
    const defined = [...(sprites[0]?.[1] ?? "").matchAll(symbolPattern)].map(
      (match) => match[1],
    );
    expect(defined, path).toEqual(
      pageIcons(matches).map((name) => `${iconIdPrefix}${name}`),
    );
    const used = [...new Set([...html.matchAll(usePattern)].map((m) => m[1]))];
    expect(used.length, path).toBeGreaterThan(0);
    expect(
      used.filter((id) => !defined.includes(id)),
      path,
    ).toEqual([]);
  }
});

test("symbols draw from the sprite in the foreground color of plain and solid controls", async ({
  page,
}) => {
  await page.goto("/");
  const controls = [
    page.getByRole("link", { name: uiCopy.about }),
    page.getByRole("button", { name: uiCopy.search.action }),
  ];
  const colors = new Set<string>();
  for (const control of controls) {
    const symbol = control.locator("svg[data-icon]");
    await expect(symbol).toHaveCount(1);
    await expect
      .poll(() =>
        symbol.evaluate((element, empty) => {
          const use = element.querySelector("use");
          return use instanceof SVGGraphicsElement
            ? Math.min(use.getBBox().width, use.getBBox().height)
            : empty;
        }, paintedExtent),
      )
      .toBeGreaterThan(paintedExtent);
    const [symbolColor, controlColor] = await symbol.evaluate((element) => [
      getComputedStyle(element).color,
      getComputedStyle(element.parentElement ?? element).color,
    ]);
    expect(symbolColor).toBe(controlColor);
    colors.add(symbolColor ?? "");
  }
  expect(colors).toEqual(new Set(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]));
});
