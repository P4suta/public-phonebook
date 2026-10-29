import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const configuration = defineConfig({
  plugins: [
    cloudflare({
      inspectorPort: false,
      remoteBindings: false,
      persistState: false,
    }),
  ],
  publicDir: "static",
  server: { host: "127.0.0.1", port: 8787, strictPort: true, cors: false },
});

export default configuration;
