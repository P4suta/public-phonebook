import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { prepareSnapshot } from "./snapshot.ts";

const commandArgumentOffset = 2;
const prepareArgumentCount = 3;
const prepareWithCollectionArgumentCount = 4;

async function main(args: readonly string[]): Promise<void> {
  const [command, source, output, collection] = args;
  if (
    command !== "prepare" ||
    !source ||
    !output ||
    (args.length !== prepareArgumentCount &&
      args.length !== prepareWithCollectionArgumentCount)
  )
    throw new Error(
      "Usage: npm run data -- prepare SOURCE_DATABASE OUTPUT_DIRECTORY [COLLECTION_DIRECTORY]",
    );
  await mkdir(dirname(output), { recursive: true });
  console.info(
    JSON.stringify(await prepareSnapshot(source, output, collection)),
  );
}

await main(process.argv.slice(commandArgumentOffset));
