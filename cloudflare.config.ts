import {
  bindings,
  defineConfig,
  defineContainer,
  defineWorker,
  exports,
} from "cf/config";
import * as entrypoint from "./cloudflare/worker.ts" with { type: "cf-worker" };

const DIRECTORY_CLASS = "Phonebook" satisfies keyof typeof entrypoint;

const directory = defineContainer({
  name: "public-phonebook-directory",
  images: {
    directory: { dockerfile: "./cloudflare/Dockerfile", buildContext: "." },
  },
  schedulingPolicy: "durable-object",
  ssh: { enabled: false },
  observability: { logs: { enabled: true } },
});

const worker = defineWorker({
  name: "public-phonebook",
  domains: ["www.dial.page"],
  entrypoint,
  compatibilityDate: "2026-10-23",
  compatibilityFlags: ["enable_ctx_exports"],
  workersDev: false,
  previewUrls: false,
  exports: {
    [DIRECTORY_CLASS]: exports.durableObject({
      storage: "sqlite",
      container: directory,
    }),
  },
  env: {
    ASSETS: bindings.assets(),
  },
  assets: {
    htmlHandling: "none",
    notFoundHandling: "none",
    runWorkerFirst: true,
  },
  limits: { cpuMs: 50 },
  observability: {
    enabled: true,
    redactQueryString: true,
    logs: { enabled: true, invocationLogs: false },
    traces: { enabled: false },
  },
});

export default defineConfig({
  worker,
  containers: [directory],
});
