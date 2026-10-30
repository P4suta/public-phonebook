import { bindings, defineConfig } from "cf/config";
import * as v from "valibot";
import {
  databaseResourceName,
  deploymentEnvironment,
  environments,
} from "./src/core/environment.ts";
import { DigestSchema } from "./src/core/models.ts";
import { parseAccessConfiguration } from "./src/server/staging-access.ts";

const workerCpuLimitMs = 100;

export default defineConfig(({ mode }) => {
  const environment = deploymentEnvironment(mode);
  const target = environments[environment];
  const access =
    environment === "staging"
      ? parseAccessConfiguration({
          PUBLIC_ORIGIN: target.origin,
          ACCESS_ISSUER: process.env.ACCESS_ISSUER,
          ACCESS_AUDIENCE: process.env.ACCESS_AUDIENCE,
          ACCESS_REVIEWERS: process.env.ACCESS_REVIEWERS,
          ACCESS_SERVICE_CLIENT_ID: process.env.ACCESS_SERVICE_CLIENT_ID,
        })
      : undefined;
  return {
    worker: {
      name: target.worker,
      entrypoint: "./src/server.ts",
      compatibilityDate: "2026-10-29",
      compatibilityFlags: ["nodejs_compat"],
      domains: target.domains,
      workersDev: false,
      previewUrls: false,
      assets: { runWorkerFirst: true },
      env: {
        ASSETS: bindings.assets(),
        DB: bindings.d1({
          name: databaseResourceName(
            environment,
            process.env.DIAL_DATABASE_SHA256,
          ),
          dev: { remote: false },
        }),
        DATASETS: bindings.r2({ name: target.bucket, dev: { remote: false } }),
        CF_VERSION_METADATA: bindings.versionMetadata(),
        APP_ENV: bindings.text(environment),
        PUBLIC_ORIGIN: bindings.text(target.origin),
        DATASET_MANIFEST_SHA256: bindings.text(
          environment === "development"
            ? ""
            : v.parse(DigestSchema, process.env.DIAL_MANIFEST_SHA256),
        ),
        ACCESS_ISSUER: bindings.text(access?.ACCESS_ISSUER ?? ""),
        ACCESS_AUDIENCE: bindings.text(access?.ACCESS_AUDIENCE ?? ""),
        ACCESS_REVIEWERS: bindings.text(
          JSON.stringify(access?.ACCESS_REVIEWERS ?? []),
        ),
        ACCESS_SERVICE_CLIENT_ID: bindings.text(
          access?.ACCESS_SERVICE_CLIENT_ID ?? "",
        ),
      },
      limits: { cpuMs: workerCpuLimitMs },
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, invocationLogs: false },
        traces: { enabled: false },
      },
    },
  };
});
