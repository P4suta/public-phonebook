import {
  bindings,
  defineConfig,
  defineContainer,
  defineWorker,
  exports,
} from "cf/config";
import * as entrypoint from "./cloudflare/worker.ts" with { type: "cf-worker" };

const directory = defineContainer({
  name: "public-phonebook-directory",
  image: { dockerfile: "./cloudflare/Dockerfile", buildContext: "." },
  instanceType: "basic",
  maxInstances: 1,
  schedulingPolicy: "default",
  ssh: { enabled: false },
  observability: { logs: { enabled: true } },
});

const worker = defineWorker({
  name: "public-phonebook",
  domains: ["dial.page"],
  entrypoint,
  compatibilityDate: "2026-10-23",
  workersDev: false,
  previewUrls: false,
  exports: {
    Phonebook: exports.durableObject({
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
  worker: {
    ...worker,
    env: {
      ...worker.env,
      PHONEBOOK: bindings.durableObject({ worker, exportName: "Phonebook" }),
    },
  },
  containers: [directory],
});
