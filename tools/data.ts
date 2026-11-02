import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { prepareSnapshot } from "./snapshot.ts";

const commandArgumentOffset = 2;
const deltaBaseFlag = "--delta-base";
const usage =
  "Usage: npm run data -- prepare SOURCE_DATABASE OUTPUT_DIRECTORY [COLLECTION_DIRECTORY] [--delta-base PREPARED_BUNDLE]...";

export interface PrepareArguments {
  readonly source: string;
  readonly output: string;
  readonly collection: string | undefined;
  readonly deltaBases: readonly string[];
}

export function parsePrepareArguments(
  args: readonly string[],
): PrepareArguments {
  const [command, ...rest] = args;
  const positional: string[] = [];
  const deltaBases: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] ?? "";
    if (value !== deltaBaseFlag) {
      positional.push(value);
      continue;
    }
    const base = rest[index + 1];
    if (!base) throw new Error(usage);
    deltaBases.push(base);
    index += 1;
  }
  const [source, output, collection, ...extra] = positional;
  if (command !== "prepare" || !source || !output || extra.length > 0)
    throw new Error(usage);
  return { source, output, collection: collection || undefined, deltaBases };
}

if (import.meta.main) {
  const options = parsePrepareArguments(
    process.argv.slice(commandArgumentOffset),
  );
  await mkdir(dirname(options.output), { recursive: true });
  console.info(
    JSON.stringify(
      await prepareSnapshot(
        options.source,
        options.output,
        options.collection,
        options.deltaBases,
      ),
    ),
  );
}
