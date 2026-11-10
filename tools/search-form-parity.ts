import { readFile, writeFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import { searchForm } from "@public-phonebook/directory/search-text";

const headerLines = 2;
const nameField = 2;
const commandArgumentOffset = 2;

/**
 * Writes each display name of a directory archive beside the website's comparison form, one tab-separated pair per line.
 * `BundledAdmission --search-forms` reads the file and requires the app's own form for every name, and `just ios-check` runs both for each bundled archive.
 */
export function searchFormLines(archive: Uint8Array): string {
  const lines = new TextDecoder("utf-8", { fatal: true })
    .decode(brotliDecompressSync(archive))
    .split("\n")
    .slice(headerLines)
    .filter((line) => line !== "");
  return lines
    .map((line) => {
      const name = line.split("\t")[nameField];
      if (name === undefined) throw new Error("An archive line has no name");
      return `${name}\t${searchForm(name)}\n`;
    })
    .join("");
}

if (import.meta.main) {
  const [archive, output] = process.argv.slice(commandArgumentOffset);
  if (!archive || !output)
    throw new Error("Usage: node tools/search-form-parity.ts ARCHIVE OUTPUT");
  await writeFile(
    output,
    searchFormLines(new Uint8Array(await readFile(archive))),
  );
}
