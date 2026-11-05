import { createBuilder } from "vite";
import {
  deploymentEnvironment,
  type Environment,
} from "../src/core/environment.ts";

const commandArgumentOffset = 2;

interface BuildArguments {
  readonly mode: Environment;
  readonly localForgivingSearch: boolean;
}

export function parseBuildArguments(args: readonly string[]): BuildArguments {
  const [mode = "development", flag, ...extra] = args;
  const environment = deploymentEnvironment(mode);
  if (
    extra.length ||
    (flag !== undefined && flag !== "--local-forgiving-search")
  )
    throw new Error(
      "Usage: node tools/build.ts [development|production] [--local-forgiving-search]",
    );
  const localForgivingSearch = flag !== undefined;
  if (localForgivingSearch && environment !== "development")
    throw new Error("Local forgiving search requires development mode");
  return { mode: environment, localForgivingSearch };
}

if (import.meta.main) {
  const options = parseBuildArguments(
    process.argv.slice(commandArgumentOffset),
  );
  const builder = await createBuilder({
    mode: options.mode,
    ...(options.localForgivingSearch
      ? {
          define: { __PHONEBOOK_LOCAL_FORGIVING_SEARCH__: "true" },
          worker: { format: "es" as const },
        }
      : {}),
  });
  await builder.buildApp();
}
