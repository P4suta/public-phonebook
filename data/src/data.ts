import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareSnapshot } from "@public-phonebook/data/snapshot";

const commandArgumentOffset = 2;
const deltaBaseFlag = "--delta-base";
const deltaBaseRootFlag = "--delta-base-root";
const forgivingSearchFlag = "--forgiving-search";
const usage =
  "Usage: npm run data -- prepare SOURCE_DATABASE OUTPUT_DIRECTORY [COLLECTION_DIRECTORY] [--delta-base PREPARED_BUNDLE]... [--delta-base-root DIRECTORY_OF_BUNDLES] [--forgiving-search]";

export interface PrepareArguments {
  readonly source: string;
  readonly output: string;
  readonly collection: string | undefined;
  readonly deltaBases: readonly string[];
  readonly deltaBaseRoot: string | undefined;
  readonly forgivingSearch: boolean;
}

export function parsePrepareArguments(
  args: readonly string[],
): PrepareArguments {
  const [command, ...rest] = args;
  const positional: string[] = [];
  const deltaBases: string[] = [];
  let deltaBaseRoot: string | undefined;
  let forgivingSearch = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index] ?? "";
    if (value === forgivingSearchFlag) {
      if (forgivingSearch) throw new Error(usage);
      forgivingSearch = true;
      continue;
    }
    if (value !== deltaBaseFlag && value !== deltaBaseRootFlag) {
      if (value.startsWith("--")) throw new Error(usage);
      positional.push(value);
      continue;
    }
    const operand = rest[index + 1];
    if (!operand) throw new Error(usage);
    if (value === deltaBaseFlag) deltaBases.push(operand);
    else if (deltaBaseRoot === undefined) deltaBaseRoot = operand;
    else throw new Error(usage);
    index += 1;
  }
  const [source, output, collection, ...extra] = positional;
  if (command !== "prepare" || !source || !output || extra.length > 0)
    throw new Error(usage);
  return {
    source,
    output,
    collection: collection || undefined,
    deltaBases,
    deltaBaseRoot,
    forgivingSearch,
  };
}

/** Lists each prepared bundle directly inside `root` in name order, and refuses any other entry so a stray file can't pass unnoticed. */
export async function deltaBaseDirectories(
  root: string,
): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const strays = entries.filter((entry) => !entry.isDirectory());
  if (strays.length > 0)
    throw new Error(
      `The delta base root holds entries that aren't bundles: ${strays.map((entry) => entry.name).join(", ")}`,
    );
  return entries
    .map((entry) => entry.name)
    .toSorted()
    .map((name) => join(root, name));
}

if (import.meta.main) {
  const options = parsePrepareArguments(
    process.argv.slice(commandArgumentOffset),
  );
  await mkdir(dirname(options.output), { recursive: true });
  const rooted = options.deltaBaseRoot
    ? await deltaBaseDirectories(options.deltaBaseRoot)
    : [];
  console.info(
    JSON.stringify(
      await prepareSnapshot(
        options.source,
        options.output,
        options.collection,
        [...options.deltaBases, ...rooted],
        options.forgivingSearch,
      ),
    ),
  );
}
