import { Buffer } from "node:buffer";
import { checkedFetch, publicAccess } from "../../tools/public-request.ts";
import { test as base, expect } from "../browser/fixtures.ts";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumRedirectHops = 5;

export const test = base.extend({
  context: async ({ context, baseURL }, use): Promise<void> => {
    const access = publicAccess();
    if (access.origin === "https://staging.dial.page") {
      if (baseURL !== access.origin)
        throw new Error("Staging browser verification has a mismatched origin");
      await context.route("**/*", async (route): Promise<void> => {
        const request = route.request();
        if (new URL(request.url()).origin !== access.origin)
          return route.continue();
        const init = { method: request.method(), headers: request.headers() };
        let url = new URL(request.url());
        let response = await checkedFetch(url, init, access);
        // Playwright routes only the first request of a redirect chain, so same-origin hops keep the credential here.
        for (let hops = 0; redirectStatuses.has(response.status); hops += 1) {
          const location = response.headers.get("location");
          const next = location ? new URL(location, url) : null;
          if (!next || next.origin !== access.origin) break;
          if (hops === maximumRedirectHops)
            throw new Error("Staging verification exceeded its redirect limit");
          url = next;
          response = await checkedFetch(url, init, access);
        }
        const headers = new Headers(response.headers);
        for (const name of [
          "set-cookie",
          "cf-access-jwt-assertion",
          "cf-access-client-id",
          "cf-access-client-secret",
          "content-encoding",
          "content-length",
        ])
          headers.delete(name);
        const body = Buffer.from(await response.arrayBuffer());
        if (
          [access.clientId, access.clientSecret].some(
            (credential) => credential && body.includes(credential),
          )
        )
          throw new Error("Staging returned credential material");
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(headers),
          body,
        });
      });
    }
    await use(context);
  },
});
export { expect };
