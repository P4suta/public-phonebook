import {
  deploymentEnvironment,
  environments,
} from "@public-phonebook/directory/environment";
import { bindings, defineConfig } from "cf/config";
import { productionDataset } from "../../infrastructure/cloudflare/dataset.ts";

const workerCpuLimitMs = 100;

export default defineConfig(({ mode }) => {
  const environment = deploymentEnvironment(mode);
  const target = environments[environment];
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
          ...(environment === "development"
            ? { name: target.database }
            : { id: productionDataset.databaseId }),
          dev: { remote: false },
        }),
        DATASETS: bindings.r2({ name: target.bucket, dev: { remote: false } }),
        CF_VERSION_METADATA: bindings.versionMetadata(),
        APP_ENV: bindings.text(environment),
        PUBLIC_ORIGIN: bindings.text(target.origin),
        DATASET_MANIFEST_SHA256: bindings.text(
          environment === "development" ? "" : productionDataset.manifestSha256,
        ),
      },
      limits: { cpuMs: workerCpuLimitMs },
      logpush: false,
      tailConsumers: [],
      observability: {
        enabled: false,
        redactQueryString: true,
        issues: { enabled: false },
        logs: {
          enabled: false,
          invocationLogs: false,
          persist: false,
          destinations: [],
        },
        traces: { enabled: false, persist: false, destinations: [] },
      },
    },
  };
});
