import { Buffer } from "node:buffer";
import { versionHeader } from "../../src/server/version-header.ts";
import { checkedFetch, publicAccess } from "../../tools/public-request.ts";
import { test as base, expect } from "../browser/fixtures.ts";

const transportHeaders = ["set-cookie", "content-encoding", "content-length"];
// Browsers send these over HTTPS and Node's fetch decodes them; Playwright doesn't report the browser's own value.
const browserContentCodings = "gzip, deflate, br";

export const test = base.extend({
  context: async ({ context, baseURL }, use): Promise<void> => {
    const access = publicAccess();
    if (access.version) {
      if (baseURL !== access.origin)
        throw new Error("Version verification has a mismatched origin");
      const hidden =
        access.version.mode === "override"
          ? [...transportHeaders, versionHeader]
          : transportHeaders;
      // Node sends each same-origin request so that pages and assets carry the override and count against the probe budget.
      await context.route("**/*", async (route): Promise<void> => {
        const request = route.request();
        if (new URL(request.url()).origin !== access.origin)
          return route.continue();
        const response = await checkedFetch(
          request.url(),
          {
            method: request.method(),
            headers: {
              ...request.headers(),
              "accept-encoding": browserContentCodings,
            },
          },
          access,
        );
        const headers = new Headers(response.headers);
        for (const name of hidden) headers.delete(name);
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
    }
    await use(context);
  },
});
export { expect };
