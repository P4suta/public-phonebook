import { bindings, defineConfig } from "cf/config";
import {
  databaseResourceName,
  deploymentEnvironment,
  environments,
} from "./src/core/environment.ts";

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
      env: {
        DB: bindings.d1({
          name: databaseResourceName(
            environment,
            process.env.DIAL_DATABASE_SHA256,
          ),
          dev: { remote: false },
        }),
        DATASETS: bindings.r2({ name: target.bucket, dev: { remote: false } }),
        APP_ENV: bindings.text(environment),
        PUBLIC_ORIGIN: bindings.text(target.origin),
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
