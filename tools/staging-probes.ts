import { resolve } from "node:path";
import * as v from "valibot";
import { environments } from "../src/core/environment.ts";
import { httpStatus } from "../src/core/http-status.ts";
import { DatasetManifestSchema } from "../src/core/models.ts";
import { checkedFetch } from "./public-request.ts";

const deniedStatuses = [302, 303, 401, 403];
const requestTimeoutMs = 15000;
const requestMethods = ["GET", "HEAD", "OPTIONS"];
const protectedPaths = [
  "/",
  "/about",
  "/developers",
  "/api",
  "/api/catalog",
  "/api/contact-groups?q=図書館",
  "/api/openapi.json",
  "/api/datasets",
];
export async function probeStaging(): Promise<void> {
  const paths = [...protectedPaths];
  const access = {
    origin: environments.staging.origin,
    clientId: process.env.ACCESS_SERVICE_CLIENT_ID,
    clientSecret: process.env.ACCESS_SERVICE_CLIENT_SECRET,
  };
  const authorized = await checkedFetch("/", {}, access);
  if (authorized.status !== httpStatus.ok)
    throw new Error("Authorized staging access failed");
  const html = await authorized.text();
  for (const match of html.matchAll(/(?:src|href)="(\/[^" ]+\.(?:js|css))"/gu))
    if (match[1]) paths.push(match[1]);
  const manifestResponse = await checkedFetch("/api/datasets", {}, access);
  if (manifestResponse.status !== httpStatus.ok)
    throw new Error("Authorized staging datasets failed");
  const manifest = v.parse(
    DatasetManifestSchema,
    await manifestResponse.json(),
  );
  paths.push(...manifest.files.map((file) => file.url));
  const uniquePaths = [...new Set(paths)];
  for (const path of uniquePaths)
    for (const method of requestMethods) {
      const response = await fetch(new URL(path, environments.staging.origin), {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!deniedStatuses.includes(response.status))
        throw new Error(`Anonymous staging ${method} was not denied`);
      const location = response.headers.get("location");
      if (
        location &&
        new URL(location, response.url).origin !== process.env.ACCESS_ISSUER
      )
        throw new Error("Unexpected staging authentication redirect");
      await response.body?.cancel();
    }
  console.info(
    JSON.stringify({
      operation: "staging.access.probes",
      anonymousRequests: uniquePaths.length * requestMethods.length,
      authorized: "passed",
      result: "verified",
    }),
  );
}
if (process.argv[1] === resolve("tools/staging-probes.ts"))
  await probeStaging();
