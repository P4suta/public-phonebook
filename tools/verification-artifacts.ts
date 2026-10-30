import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";

const maximumArtifactBytes = 256_000_000;
const maximumExpandedBytes = 256_000_000;

export async function auditVerificationArtifacts(
  paths: readonly string[],
  credentials: readonly string[],
): Promise<number> {
  const forbidden = credentials
    .filter(Boolean)
    .flatMap((value) => [value, btoa(value)]);
  let files = 0;
  function inspect(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    if (forbidden.some((value) => text.includes(value)))
      throw new Error("Verification artifacts contain credential material");
  }
  async function visit(path: string): Promise<void> {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          throw new Error(
            "Verification artifacts cannot contain symbolic links",
          );
        await visit(join(path, entry.name));
      }
      return;
    }
    if (!metadata.isFile() || metadata.size > maximumArtifactBytes)
      throw new Error("Verification artifact exceeds its scan boundary");
    const bytes = new Uint8Array(await readFile(path));
    inspect(bytes);
    if (path.endsWith(".zip")) {
      let expanded = 0;
      const entries = unzipSync(bytes, {
        filter: (entry): boolean => {
          expanded += entry.originalSize;
          if (expanded > maximumExpandedBytes)
            throw new Error(
              "Verification trace exceeds its expanded scan boundary",
            );
          return true;
        },
      });
      for (const entry of Object.values(entries)) inspect(entry);
    }
    files += 1;
  }
  for (const path of paths) await visit(path);
  return files;
}
