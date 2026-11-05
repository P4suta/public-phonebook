import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import * as v from "valibot";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  createRankedSearch,
  type RankedSearch,
} from "../src/core/local-search.ts";
import {
  decodeSearchIndex,
  type SearchIndex,
} from "../src/core/search-index.ts";
import {
  decodeRankingArtifact,
  type RankingArtifact,
} from "../src/core/search-ranking-artifact.ts";
import { command } from "./process.ts";

const contractFormat = "public-phonebook-name-ranking/1";
const fixtureQueries = 2200;
const minimumFixtureQueries = 2000;
const commandArgumentOffset = 2;
const NaturalSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const HitSchema = v.tuple([
  NaturalSchema,
  v.pipe(NaturalSchema, v.maxValue(1_000_000)),
]);
export const RankingContractSchema = v.strictObject({
  format: v.literal(contractFormat),
  snapshot: v.string(),
  contacts: NaturalSchema,
  indexSha256: v.string(),
  rankingSha256: v.string(),
  queries: v.array(
    v.strictObject({ query: v.string(), hits: v.array(HitSchema) }),
  ),
});
export type RankingContract = v.InferOutput<typeof RankingContractSchema>;
export interface RankingBundle {
  readonly index: SearchIndex;
  readonly ranking: RankingArtifact;
  readonly indexSha256: string;
  readonly rankingSha256: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readRankingBundle(
  bundle: string,
): Promise<RankingBundle> {
  const manifest = v.parse(
    PreparedDatasetManifestSchema,
    JSON.parse(await readFile(join(bundle, "manifest.ready.json"), "utf8")),
  );
  const ranking = manifest.searchRanking;
  if (!ranking) throw new Error("The snapshot has no device ranking artifact");
  async function decoded(file: typeof ranking): Promise<Uint8Array> {
    if (!file) throw new Error("Missing ranking artifact");
    const bytes = await readFile(join(bundle, file.file));
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error("Ranking bundle file checksum mismatch");
    const result = brotliDecompressSync(bytes, {
      maxOutputLength: file.uncompressedBytes,
    });
    if (
      result.byteLength !== file.uncompressedBytes ||
      digest(result) !== file.uncompressedSha256
    )
      throw new Error("Decoded ranking bundle checksum mismatch");
    return result;
  }
  const indexArtifact = manifest.searchIndex;
  const indexBytes = await readFile(join(bundle, indexArtifact.file));
  if (
    indexBytes.length !== indexArtifact.bytes ||
    digest(indexBytes) !== indexArtifact.sha256
  )
    throw new Error("Search index checksum mismatch");
  const indexPlain = brotliDecompressSync(indexBytes, {
    maxOutputLength: indexArtifact.uncompressedBytes,
  });
  if (
    indexPlain.length !== indexArtifact.uncompressedBytes ||
    digest(indexPlain) !== indexArtifact.uncompressedSha256
  )
    throw new Error("Decoded search index checksum mismatch");
  const index = decodeSearchIndex(indexPlain);
  if (
    index.header.snapshot !== manifest.snapshot ||
    index.rows.length !== manifest.contacts
  )
    throw new Error("Search index snapshot mismatch");
  return {
    index,
    ranking: decodeRankingArtifact(
      await decoded(ranking),
      manifest.snapshot,
      manifest.contacts,
    ),
    indexSha256: indexArtifact.uncompressedSha256,
    rankingSha256: ranking.uncompressedSha256,
  };
}

type ReferenceFactory = (directory: string) => Promise<RankedSearch>;
async function referenceSearch(
  path: string,
  directory: string,
): Promise<RankedSearch> {
  const module: unknown = await import(pathToFileURL(resolve(path)).href);
  const factory = v.parse(
    v.object({
      build: v.custom<ReferenceFactory>((value) => typeof value === "function"),
    }),
    module,
  );
  return factory.build(directory);
}

export async function contractQueries(
  paths: readonly string[],
): Promise<readonly string[]> {
  const queries = new Set<string>();
  const schema = v.object({
    query: v.string(),
    split: v.picklist(["train", "test", "eval", "blind", "blind2"]),
  });
  for (const path of paths) {
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line) continue;
      const record = v.parse(schema, JSON.parse(line));
      if (record.split !== "train") queries.add(record.query);
    }
  }
  return [...queries].slice(0, fixtureQueries);
}

export async function generateRankingContract(
  bundle: RankingBundle,
  queries: readonly string[],
  reference: RankedSearch,
): Promise<RankingContract> {
  if (queries.length < minimumFixtureQueries)
    throw new Error("A shared ranking fixture needs at least 2000 queries");
  const search = createRankedSearch(bundle.index, bundle.ranking);
  const cases: RankingContract["queries"] = [];
  for (const [position, query] of queries.entries()) {
    const hits = search.search(query).map((hit) => [hit.row, hit.score]);
    const expected = reference.search(query).map((hit) => [hit.row, hit.score]);
    if (JSON.stringify(hits) !== JSON.stringify(expected))
      throw new Error(`Frozen ranking divergence at fixture case ${position}`);
    cases.push(
      v.parse(RankingContractSchema.entries.queries.item, { query, hits }),
    );
  }
  return {
    format: contractFormat,
    snapshot: bundle.index.header.snapshot,
    contacts: bundle.index.rows.length,
    indexSha256: bundle.indexSha256,
    rankingSha256: bundle.rankingSha256,
    queries: cases,
  };
}

export function verifyRankingContract(
  bundle: RankingBundle,
  contract: RankingContract,
): void {
  if (
    contract.snapshot !== bundle.index.header.snapshot ||
    contract.contacts !== bundle.index.rows.length ||
    contract.indexSha256 !== bundle.indexSha256 ||
    contract.rankingSha256 !== bundle.rankingSha256
  )
    throw new Error("Ranking fixture belongs to different snapshot artifacts");
  if (contract.queries.length < minimumFixtureQueries)
    throw new Error("Incomplete shared ranking fixture");
  const search = createRankedSearch(bundle.index, bundle.ranking);
  for (const [position, query] of contract.queries.entries()) {
    const actual = search
      .search(query.query)
      .map((hit) => [hit.row, hit.score]);
    if (JSON.stringify(actual) !== JSON.stringify(query.hits))
      throw new Error(
        `Ranking contract divergence at fixture case ${position}`,
      );
  }
}

if (import.meta.main) {
  const [operation, directory, output, reference, ...paths] =
    process.argv.slice(commandArgumentOffset);
  if (!directory || !output)
    throw new Error(
      "Usage: search-ranking-contract.ts generate BUNDLE OUTPUT REFERENCE QUERY_FILES... | check BUNDLE FIXTURE",
    );
  if (operation === "reference" && reference && paths.length) {
    const queries = await contractQueries(paths);
    const search = await referenceSearch(reference, directory);
    const expected = queries.map((query) => ({
      query,
      hits: search.search(query).map((hit) => [hit.row, hit.score]),
    }));
    await writeFile(
      output,
      JSON.stringify(v.parse(RankingContractSchema.entries.queries, expected)),
      { flag: "wx" },
    );
    console.info(
      JSON.stringify({
        operation: "search.ranking.reference",
        queries: queries.length,
      }),
    );
  } else if (operation === "generate" && reference && paths.length) {
    await mkdir(".local/ranking-contract", { recursive: true });
    const temporary = await mkdtemp(resolve(".local/ranking-contract/run-"));
    let contract: RankingContract;
    try {
      const expectedPath = join(temporary, "reference.json");
      const result = await command(
        process.execPath,
        [
          "tools/search-ranking-contract.ts",
          "reference",
          directory,
          expectedPath,
          reference,
          ...paths,
        ],
        true,
      );
      if (result.code !== 0)
        throw new Error(`Frozen reference failed: ${result.output}`);
      const expected = v.parse(
        RankingContractSchema.entries.queries,
        JSON.parse(await readFile(expectedPath, "utf8")),
      );
      const byQuery = new Map(
        expected.map((record) => [
          record.query,
          record.hits.map(([row, score]) => ({ row, score })),
        ]),
      );
      contract = await generateRankingContract(
        await readRankingBundle(directory),
        expected.map((record) => record.query),
        {
          search: (query) => byQuery.get(query) ?? [],
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await mkdir(dirname(output), { recursive: true });
    const { queries, ...header } = contract;
    const text = `${JSON.stringify(header).slice(0, -1)},"queries":[\n${queries.map((query) => JSON.stringify(query)).join(",\n")}\n]}\n`;
    await writeFile(output, text, { flag: "wx" });
    console.info(
      JSON.stringify({
        operation: "search.ranking.contract",
        result: "generated",
        queries: queries.length,
        divergences: 0,
        output,
      }),
    );
  } else if (operation === "check" && !reference) {
    const bundle = await readRankingBundle(directory);
    const contract = v.parse(
      RankingContractSchema,
      JSON.parse(await readFile(output, "utf8")),
    );
    verifyRankingContract(bundle, contract);
    console.info(
      JSON.stringify({
        operation: "search.ranking.contract",
        result: "passed",
        queries: contract.queries.length,
        divergences: 0,
      }),
    );
  } else throw new Error("Invalid ranking contract arguments");
}
