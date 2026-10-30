import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { vanillaExtractPlugin } from "@vanilla-extract/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { referenceStyles } from "./tools/reference-styles.ts";

const developmentHost = "127.0.0.1";
const developmentPort = 8787;

const configuration = defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: false,
      remoteBindings: false,
      persistState: { path: process.env.DIAL_LOCAL_STATE ?? ".local/state" },
      types: { includeRuntime: false },
    }),
    vanillaExtractPlugin(),
    {
      name: "bundle-vanilla-extract-in-workers",
      configEnvironment(name, environment): void {
        if (name !== "ssr" || !Array.isArray(environment.resolve?.external))
          return;
        const styles = new Set([
          "@vanilla-extract/css",
          "@vanilla-extract/css/fileScope",
          "@vanilla-extract/css/adapter",
        ]);
        environment.resolve.external = environment.resolve.external.filter(
          (module) => !styles.has(module),
        );
      },
    },
    tanstackStart(),
    react(),
  ],
  publicDir: "public",
  css: { postcss: { plugins: [referenceStyles()] } },
  optimizeDeps: {
    include: [
      "@tanstack/react-router",
      "@tanstack/react-query",
      "react",
      "react-dom/client",
      "lucide-react",
      "valibot",
    ],
  },
  server: {
    host: developmentHost,
    port: developmentPort,
    strictPort: true,
    cors: false,
    watch: {
      ignored: [
        "**/test-results/**",
        "**/playwright-report/**",
        "**/.local/**",
        "**/.cloudflare/output/**",
      ],
    },
  },
});

export default configuration;
