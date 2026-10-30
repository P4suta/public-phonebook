import { Buffer } from "node:buffer";
import { checkedFetch, publicAccess } from "../../tools/public-request.ts";
import { test as base, expect } from "../browser/fixtures.ts";

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
        const response = await checkedFetch(
          request.url(),
          { method: request.method(), headers: request.headers() },
          access,
        );
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
