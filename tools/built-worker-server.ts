import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { requireBuildBudget } from "./build-budget.ts";
import { developmentHost, developmentPort } from "./local-data.ts";

const buildOutput = ".cloudflare/output/v0/workers/default";
const defaultState = ".local/state";
const persistenceVersion = "v3";
const commandArgumentOffset = 2;

const DevelopmentSchema = v.optional(
  v.strictObject({ remote: v.optional(v.boolean()) }),
);
const BindingSchema = v.variant("type", [
  v.strictObject({ type: v.literal("assets") }),
  v.strictObject({
    type: v.literal("d1"),
    name: v.string(),
    dev: DevelopmentSchema,
  }),
  v.strictObject({
    type: v.literal("r2"),
    name: v.string(),
    dev: DevelopmentSchema,
  }),
  v.strictObject({ type: v.literal("text"), value: v.string() }),
  v.strictObject({ type: v.literal("version-metadata") }),
]);
const BuiltWorkerSchema = v.object({
  name: v.string(),
  compatibilityDate: v.string(),
  compatibilityFlags: v.array(v.string()),
  assets: v.strictObject({ runWorkerFirst: v.boolean() }),
  env: v.record(v.string(), BindingSchema),
  manifest: v.strictObject({
    type: v.literal("partial"),
    mainModule: v.string(),
    modules: v.strictObject({}),
  }),
});
const PortSchema = v.pipe(
  v.string(),
  v.regex(/^[1-9][0-9]*$/u),
  v.transform(Number),
  v.safeInteger(),
);

type ModuleType = "esm" | "sourcemap";
type Modules = Record<string, { type: ModuleType; contents: string }>;

function moduleType(path: string): ModuleType | undefined {
  const extension = extname(path);
  if (extension === ".js" || extension === ".mjs") return "esm";
  if (extension === ".map") return "sourcemap";
  return undefined;
}

/** Infers the bundle's modules from file extensions, as a partial Build Output manifest specifies. */
async function bundleModules(root: string): Promise<Modules> {
  const modules: Modules = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const type = moduleType(path);
    if (type === undefined) continue;
    modules[relative(root, path).split(sep).join("/")] = {
      type,
      contents: await readFile(path, "utf8"),
    };
  }
  return modules;
}

/**
 * Serves the built Worker from workerd's own HTTPS socket.
 * The Vite preview relays responses through Node's fetch, which decodes a pre-encoded body but keeps its encoded length.
 * Firefox and Chromium send `br` over loopback HTTP, but WebKit advertises it only over HTTPS, as production serves the site.
 */
export async function serveBuiltWorker(options: {
  readonly port: number;
  readonly state: string;
  readonly tls?: { readonly key: string; readonly cert: string };
}): Promise<Miniflare> {
  const root = resolve(buildOutput);
  const decoded: unknown = JSON.parse(
    await readFile(join(root, "worker.config.json"), "utf8"),
  );
  const worker = v.parse(BuiltWorkerSchema, decoded);
  const bundle = join(root, "bundle");
  const modules = await bundleModules(bundle);
  if (modules[worker.manifest.mainModule]?.type !== "esm")
    throw new Error("The built Worker has no main ES module");
  const runtime = new Miniflare({
    host: developmentHost,
    port: options.port,
    ...(options.tls
      ? { httpsKey: options.tls.key, httpsCert: options.tls.cert }
      : { https: true }),
    resourcePersistencePath: resolve(options.state, persistenceVersion),
    resourceTmpPath: resolve(".cloudflare/tmp"),
    telemetry: { enabled: false },
    enableDevRegistry: false,
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: worker.env,
          manifest: {
            mainModule: worker.manifest.mainModule,
            modulesRoot: bundle,
            modules,
          },
          assets: {
            ...worker.assets,
            directory: join(root, "assets"),
            hasUserWorker: true,
          },
        },
      },
    ],
  });
  await runtime.ready;
  return runtime;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(commandArgumentOffset),
    options: {
      port: { type: "string" },
      "local-forgiving-search": { type: "boolean", default: false },
    },
    strict: true,
  });
  const port = v.parse(PortSchema, values.port ?? String(developmentPort));
  const state = process.env.DIAL_LOCAL_STATE ?? defaultState;
  if (values["local-forgiving-search"]) {
    const worker = v.parse(
      BuiltWorkerSchema,
      JSON.parse(
        await readFile(join(buildOutput, "worker.config.json"), "utf8"),
      ),
    );
    const environment = worker.env.APP_ENV;
    if (environment?.type !== "text" || environment.value !== "development")
      throw new Error("Local forgiving search requires development mode");
  } else await requireBuildBudget();
  const runtime = await serveBuiltWorker({ port, state });
  console.info(
    JSON.stringify({
      operation: "preview.ready",
      origin: `https://${developmentHost}:${port}`,
      state,
    }),
  );
  const stop = (): void => {
    void runtime.dispose().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
