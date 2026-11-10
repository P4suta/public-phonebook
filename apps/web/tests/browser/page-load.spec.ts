import type { APIRequestContext } from "@playwright/test";
import { SearchResponseSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";
import { siteIcons } from "../../src/ui/icon-catalog.ts";
import { expect, test } from "./fixtures.ts";

const redirectFree = 0;

async function knownContactPath(request: APIRequestContext): Promise<string> {
  const raw: unknown = await (
    await request.get("/api/contacts?q=国立国会図書館")
  ).json();
  const contact = v.parse(SearchResponseSchema, raw).data[0];
  if (!contact) throw new Error("Known contact fixture missing");
  return `/contacts/${encodeURIComponent(contact.id)}`;
}

test("every page declares the site icon, and the icon is served", async ({
  page,
  request,
}) => {
  const { favicon, vectorFavicon } = siteIcons;
  for (const path of ["/", "/about", await knownContactPath(request)]) {
    await page.goto(path);
    await expect(page.locator('link[rel="icon"][sizes]'), path).toHaveAttribute(
      "href",
      favicon.href,
    );
    await expect(
      page.locator(`link[rel="icon"][type="${vectorFavicon.type}"]`),
      path,
    ).toHaveAttribute("href", vectorFavicon.href);
  }
  const icon = await request.get(vectorFavicon.href);
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain(vectorFavicon.type);
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
