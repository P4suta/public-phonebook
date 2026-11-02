import { build } from "vite";

/** Serves the bundled API module as the Worker's fetch handler. */
export const apiWorkerEntry =
  "import { api } from './api.js'; export default { fetch: (request, env, context) => api.fetch(request, env, context) };";

/** Bundles the actual API module for workerd, so the runtime and not Node handles its responses. */
export async function bundledApi(): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "warn",
    ssr: { target: "webworker", noExternal: true },
    resolve: { conditions: ["workerd", "worker", "browser", "import"] },
    build: {
      write: false,
      ssr: "src/server/api.ts",
      minify: false,
      rollupOptions: { output: { format: "es", codeSplitting: false } },
    },
  });
  for (const result of Array.isArray(output) ? output : [output])
    if ("output" in result)
      for (const chunk of result.output)
        if (chunk.type === "chunk" && chunk.exports.includes("api"))
          return chunk.code;
  throw new Error("The API bundle has no entry chunk");
}
