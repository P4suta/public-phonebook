import type { InferEnv } from "cf/config";
import type configuration from "../../cloudflare.config.ts";

export type DirectoryBindings = InferEnv<
  ReturnType<typeof configuration>["worker"]
>;

declare global {
  namespace Cloudflare {
    interface Env extends DirectoryBindings {}
  }
}
