import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  decodeSearchIndex,
  type SearchIndex,
} from "../src/core/search-index.ts";
import {
  encodeRankingArtifact,
  type RankingArtifact,
  rankingArtifactFile,
  rankingArtifactFormat,
} from "../src/core/search-ranking-artifact.ts";
import {
  compactSearchText,
  rankingName,
  rankingVariants,
  searchGrams,
} from "../src/core/search-ranking-text.ts";
import { command } from "./process.ts";
import { compressSearchIndex, readSearchIndex } from "./search-index.ts";

const dictionaryDigest =
  "b38318ca26a444cd713a5a377a353308ef38c733c64cc0be905122527516c793";
const lexicalGramWidth = 2;
const readingGramWidth = 3;
const inverseFrequencyScale = 1024;
const jsonIndentation = 2;
const commandArgumentOffset = 2;
const dictionaryUrl =
  "https://d2ej7fkh96fzlu.cloudfront.net/sudachidict/v1/sudachi-dictionary-20261015-full.zip";
const ReadingInputSchema = v.strictObject({
  readings: v.array(v.string()),
  lexicon: v.array(
    v.tuple([
      v.string(),
      v.string(),
      v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    ]),
  ),
});
export type RankingReadings = v.InferOutput<typeof ReadingInputSchema>;
const AliasSchema = v.strictObject({
  id: v.string(),
  name: v.string(),
  kana: v.string(),
  source: v.string(),
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function dictionaryArchive(): Promise<string> {
  const destination = resolve(".local/search-readings/dictionary.zip");
  await mkdir(resolve(".local/search-readings"), { recursive: true });
  try {
    if (digest(await readFile(destination)) === dictionaryDigest)
      return destination;
    throw new Error("Cached dictionary checksum mismatch");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const response = await fetch(dictionaryUrl);
  if (!response.ok)
    throw new Error(`Dictionary download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== dictionaryDigest)
    throw new Error("Dictionary download checksum mismatch");
  await writeFile(destination, bytes, { flag: "wx" });
  return destination;
}

export async function generateRankingReadings(
  names: readonly string[],
): Promise<RankingReadings> {
  const dictionary = await dictionaryArchive();
  const temporary = await mkdtemp(resolve(".local/search-readings/run-"));
  try {
    const input = join(temporary, "names.json");
    const output = join(temporary, "readings.json");
    await writeFile(input, JSON.stringify(names));
    const result = await command(
      "mise",
      [
        "x",
        "python",
        "uv",
        "--",
        "uv",
        "run",
        "--locked",
        "--no-dev",
        "python",
        "-I",
        "build.py",
        "--dictionary",
        dictionary,
        "--input",
        input,
        "--output",
        output,
      ],
      true,
      resolve("tools/readings"),
    );
    if (result.code !== 0)
      throw new Error(`Reading generation failed: ${result.output}`);
    return v.parse(
      ReadingInputSchema,
      JSON.parse(await readFile(output, "utf8")),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function buildRankingArtifact(
  index: SearchIndex,
  input: RankingReadings,
  aliases: readonly (readonly [number, string])[],
): RankingArtifact {
  if (input.readings.length !== index.rows.length)
    throw new Error("Reading count differs from snapshot");
  const variants = new Map(rankingVariants);
  const lexical = new Map<string, number[]>();
  const phonetic = new Map<string, number[]>();
  for (const [position, row] of index.rows.entries()) {
    const literal = rankingName(row.name, variants);
    for (const [target, keys] of [
      [lexical, searchGrams(literal, lexicalGramWidth)],
      [
        phonetic,
        [
          ...new Set([
            ...searchGrams(compactSearchText(literal), readingGramWidth),
            ...searchGrams(
              compactSearchText(input.readings[position] ?? ""),
              readingGramWidth,
            ),
          ]),
        ],
      ],
    ] as const) {
      for (const key of keys) {
        const rows = target.get(key) ?? [];
        rows.push(position);
        target.set(key, rows);
      }
    }
  }
  const weight = (count: number): number =>
    Math.max(
      1,
      Math.round(
        inverseFrequencyScale * Math.log((index.rows.length + 1) / (count + 1)),
      ),
    );
  return {
    snapshot: index.header.snapshot,
    contacts: index.rows.length,
    analyzer: {
      engine: "sudachipy/0.7.0;python/3.13.16;unicode/15.1.0;mode/C",
      dictionary: dictionaryDigest,
    },
    readings: input.readings,
    lexicon: input.lexicon.filter(
      ([surface, reading]) => surface.length > 0 && reading.length > 0,
    ),
    aliases,
    variants: rankingVariants,
    unknownWeight: weight(0),
    lexical: [...lexical].map(([key, rows]) => [
      key,
      weight(rows.length),
      rows,
    ]),
    phonetic: [...phonetic].map(([key, rows]) => [key, 0, rows]),
  };
}

export async function rankingAliases(
  db: DatabaseSync,
): Promise<readonly (readonly [number, string])[]> {
  const aliases = v.parse(
    v.array(AliasSchema),
    JSON.parse(await readFile("tools/search-aliases.json", "utf8")),
  );
  const query = db.prepare("SELECT rowid, name FROM contacts WHERE id = ?");
  const result: [number, string][] = [];
  for (const alias of aliases) {
    const row = query.get(alias.id);
    if (!row) continue;
    const checked = v.parse(
      v.object({ rowid: v.number(), name: v.string() }),
      row,
    );
    if (checked.name !== alias.name) continue;
    result.push([checked.rowid - 1, compactSearchText(alias.kana)]);
  }
  return result;
}

export async function writeSearchRanking(
  directory: string,
  db: DatabaseSync,
  index: SearchIndex,
  readings?: RankingReadings,
): Promise<{
  readonly file: typeof rankingArtifactFile;
  readonly format: typeof rankingArtifactFormat;
  readonly sha256: string;
  readonly bytes: number;
  readonly uncompressedSha256: string;
  readonly uncompressedBytes: number;
}> {
  const input =
    readings ??
    (await generateRankingReadings(index.rows.map((row) => row.name)));
  const bytes = encodeRankingArtifact(
    buildRankingArtifact(index, input, await rankingAliases(db)),
  );
  const compressed = compressSearchIndex(bytes);
  await writeFile(join(directory, rankingArtifactFile), compressed, {
    flag: "wx",
  });
  return {
    file: rankingArtifactFile,
    format: rankingArtifactFormat,
    sha256: digest(compressed),
    bytes: compressed.length,
    uncompressedSha256: digest(bytes),
    uncompressedBytes: bytes.length,
  };
}

async function importAliases(
  source: string,
  bundle: string,
  destination: string,
): Promise<void> {
  const rows = v.parse(
    v.array(
      v.object({
        rowid: v.number(),
        kana: v.string(),
        source: v.string(),
        group: v.string(),
      }),
    ),
    JSON.parse(await readFile(source, "utf8")),
  );
  const db = new DatabaseSync(join(bundle, "directory.sqlite"), {
    readOnly: true,
  });
  try {
    const query = db.prepare("SELECT id, name FROM contacts WHERE rowid = ?");
    const aliases = rows
      .filter((row) => row.group === "retained")
      .map((row) => ({
        ...v.parse(
          v.object({ id: v.string(), name: v.string() }),
          query.get(row.rowid),
        ),
        kana: row.kana,
        source: row.source,
      }));
    await writeFile(
      destination,
      `${JSON.stringify(aliases, null, jsonIndentation)}\n`,
    );
    console.info(
      JSON.stringify({
        operation: "search.aliases.import",
        aliases: aliases.length,
      }),
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [operation, source, bundle, destination, ...extra] = process.argv.slice(
    commandArgumentOffset,
  );
  if (
    operation === "import-aliases" &&
    source &&
    bundle &&
    destination &&
    !extra.length
  ) {
    await importAliases(source, bundle, destination);
  } else if (operation === "attach" && source && !bundle) {
    const manifest = v.parse(
      PreparedDatasetManifestSchema,
      JSON.parse(await readFile(join(source, "manifest.ready.json"), "utf8")),
    );
    const db = new DatabaseSync(join(source, "directory.sqlite"), {
      readOnly: true,
    });
    try {
      const catalog: unknown = JSON.parse(
        await readFile(join(source, "catalog.json"), "utf8"),
      );
      const { CatalogSchema } = await import("../src/core/models.ts");
      const index = decodeSearchIndex(
        readSearchIndex(db, {
          snapshot: manifest.snapshot,
          catalog: v.parse(CatalogSchema, catalog),
        }),
      );
      const searchRanking = await writeSearchRanking(source, db, index);
      const updated = v.parse(PreparedDatasetManifestSchema, {
        ...manifest,
        searchRanking,
      });
      await copyFile(
        join(source, "manifest.ready.json"),
        join(source, "manifest.before-ranking.json"),
      );
      for (const file of ["manifest.json", "manifest.ready.json"])
        await writeFile(
          join(source, file),
          `${JSON.stringify(updated, null, jsonIndentation)}\n`,
        );
      console.info(
        JSON.stringify({
          operation: "search.ranking.attach",
          ...searchRanking,
        }),
      );
    } finally {
      db.close();
    }
  } else
    throw new Error(
      "Usage: search-ranking.ts attach BUNDLE | import-aliases SOURCE BUNDLE DESTINATION",
    );
}
