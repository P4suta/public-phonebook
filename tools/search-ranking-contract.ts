import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import * as v from "valibot";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  createRankedSearch,
  type RankedSearch,
} from "../src/core/local-search.ts";
import { DigestSchema, TextSchema } from "../src/core/models.ts";
import {
  decodeSearchIndex,
  type SearchIndex,
} from "../src/core/search-index.ts";
import {
  measureSearchQuality,
  type QualityCase,
  type QualityCounts,
  qualityPasses,
} from "../src/core/search-quality.ts";
import {
  decodeRankingArtifact,
  type RankingArtifact,
} from "../src/core/search-ranking-artifact.ts";
import { command } from "./process.ts";

const contractFormat = "public-phonebook-name-ranking/1";
const fixtureQueries = 2200;
const minimumFixtureQueries = 2000;
const commandArgumentOffset = 2;
const jsonIndentation = 2;
export const qualityCorpusDirectory = "tests/fixtures/search-quality";
const qualityFormat = "public-phonebook-search-quality/1";
const qualityMaximum = 1_000_000;
const NaturalSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const PositiveSchema = v.pipe(NaturalSchema, v.minValue(1));
const QualitySplitSchema = v.picklist(["eval", "test", "blind", "blind2"]);
type QualitySplit = v.InferOutput<typeof QualitySplitSchema>;
const QualityQuerySchema = v.object({
  query: TextSchema,
  targets: v.pipe(v.array(PositiveSchema), v.minLength(1)),
  kind: TextSchema,
  source: TextSchema,
  split: QualitySplitSchema,
});
type QualityQuery = v.InferOutput<typeof QualityQuerySchema>;
const QualityCountsSchema = v.pipe(
  v.strictObject({
    queries: v.pipe(PositiveSchema, v.maxValue(qualityMaximum)),
    top1: NaturalSchema,
    top3: NaturalSchema,
    top10: NaturalSchema,
  }),
  v.check(
    (counts) =>
      counts.top1 <= counts.top3 &&
      counts.top3 <= counts.top10 &&
      counts.top10 <= counts.queries,
  ),
);
const QualityCorpusSchema = v.strictObject({
  format: v.literal(qualityFormat),
  snapshot: DigestSchema,
  nameTableSha256: DigestSchema,
  frozenScorerSha256: DigestSchema,
  developmentReportSha256: DigestSchema,
  validationReportSha256: DigestSchema,
  targets: v.strictObject({
    file: v.literal("targets.json"),
    sha256: DigestSchema,
    count: PositiveSchema,
  }),
  populations: v.pipe(
    v.array(
      v.strictObject({
        name: v.pipe(TextSchema, v.regex(/^[a-z][a-z-]*$/u)),
        file: v.pipe(TextSchema, v.regex(/^[a-z][a-z-]*\.jsonl$/u)),
        sourceFile: TextSchema,
        sourceSha256: DigestSchema,
        sha256: DigestSchema,
        split: QualitySplitSchema,
        minimum: QualityCountsSchema,
      }),
    ),
    v.minLength(1),
  ),
});
type QualityCorpus = v.InferOutput<typeof QualityCorpusSchema>;
const TargetSchema = v.array(v.tuple([PositiveSchema, TextSchema]));
const ContactSchema = v.object({
  rowid: PositiveSchema,
  id: TextSchema,
  name: TextSchema,
});

export function parseQualityQueries(
  text: string,
  split: QualitySplit,
): readonly QualityQuery[] {
  const records = text
    .split("\n")
    .filter(Boolean)
    .map((line) => v.parse(QualityQuerySchema, JSON.parse(line)));
  if (!records.length) throw new Error("Empty quality population");
  for (const record of records) {
    if (record.split !== split)
      throw new Error("Quality population has an unexpected split");
    if (new Set(record.targets).size !== record.targets.length)
      throw new Error("Duplicate quality targets");
  }
  return records;
}

export function resolveQualityTargets(
  queries: readonly QualityCase[],
  targets: ReadonlyMap<number, string>,
  currentRows: ReadonlyMap<string, number>,
): readonly QualityCase[] {
  return queries.map((record) => ({
    query: record.query,
    targets: record.targets.map((target) => {
      const id = targets.get(target);
      if (!id)
        throw new Error(`No stable target mapping for research row ${target}`);
      const row = currentRows.get(id);
      if (row === undefined)
        throw new Error(`Quality target is missing from the snapshot: ${id}`);
      return row;
    }),
  }));
}

async function checkedQualityFile(
  directory: string,
  file: string,
  sha256: string,
): Promise<string> {
  const bytes = await readFile(join(directory, file));
  if (digest(bytes) !== sha256)
    throw new Error(`Quality corpus checksum mismatch: ${file}`);
  return bytes.toString("utf8");
}

export interface QualityReport {
  readonly format: typeof qualityFormat;
  readonly snapshot: string;
  readonly corpusSha256: string;
  readonly indexSha256: string;
  readonly rankingSha256: string;
  readonly rankingArtifactSha256: string;
  readonly populations: readonly {
    readonly name: string;
    readonly minimum: QualityCounts;
    readonly measured: QualityCounts;
    readonly passed: boolean;
  }[];
  readonly passed: boolean;
}

export interface LoadedQualityCorpus {
  readonly sha256: string;
  readonly targets: ReadonlyMap<number, string>;
  readonly populations: readonly {
    readonly definition: QualityCorpus["populations"][number];
    readonly queries: readonly QualityQuery[];
  }[];
}

export async function readQualityCorpus(
  corpusDirectory: string,
): Promise<LoadedQualityCorpus> {
  const corpusText = await readFile(
    join(corpusDirectory, "manifest.json"),
    "utf8",
  );
  const corpus = v.parse(QualityCorpusSchema, JSON.parse(corpusText));
  if (
    new Set(corpus.populations.map((population) => population.name)).size !==
      corpus.populations.length ||
    new Set(corpus.populations.map((population) => population.file)).size !==
      corpus.populations.length
  )
    throw new Error("Duplicate quality population");
  const targetRecords = v.parse(
    TargetSchema,
    JSON.parse(
      await checkedQualityFile(
        corpusDirectory,
        corpus.targets.file,
        corpus.targets.sha256,
      ),
    ),
  );
  const targets = new Map(targetRecords);
  if (
    targets.size !== targetRecords.length ||
    targets.size !== corpus.targets.count ||
    new Set(targetRecords.map(([, id]) => id)).size !== targets.size
  )
    throw new Error("Invalid stable target mapping");
  const required = new Set<number>();
  const populations: LoadedQualityCorpus["populations"][number][] = [];
  for (const definition of corpus.populations) {
    const queries = parseQualityQueries(
      await checkedQualityFile(
        corpusDirectory,
        definition.file,
        definition.sha256,
      ),
      definition.split,
    );
    if (queries.length !== definition.minimum.queries)
      throw new Error("Quality population count changed");
    for (const query of queries)
      for (const target of query.targets) {
        if (!targets.has(target))
          throw new Error(
            `No stable target mapping for research row ${target}`,
          );
        required.add(target);
      }
    populations.push({ definition, queries });
  }
  if (required.size !== targets.size)
    throw new Error("Quality target mapping contains unused rows");
  return {
    sha256: digest(new TextEncoder().encode(corpusText)),
    targets,
    populations,
  };
}

export async function checkSearchQuality(
  directory: string,
  corpusDirectory: string = qualityCorpusDirectory,
): Promise<QualityReport> {
  const corpus = await readQualityCorpus(corpusDirectory);
  const bundle = await readRankingBundle(directory);
  const currentRows = new Map<string, number>();
  const db = new DatabaseSync(join(directory, "directory.sqlite"), {
    readOnly: true,
  });
  try {
    for (const value of db
      .prepare("SELECT rowid, id, name FROM contacts ORDER BY rowid")
      .iterate()) {
      const contact = v.parse(ContactSchema, value);
      if (
        contact.rowid !== currentRows.size + 1 ||
        bundle.index.rows[contact.rowid - 1]?.name !== contact.name ||
        currentRows.has(contact.id)
      )
        throw new Error("Quality database and search index rows differ");
      currentRows.set(contact.id, contact.rowid - 1);
    }
  } finally {
    db.close();
  }
  if (currentRows.size !== bundle.index.rows.length)
    throw new Error("Quality database contact count mismatch");
  const search = createRankedSearch(bundle.index, bundle.ranking);
  const populations: QualityReport["populations"][number][] = [];
  for (const { definition: population, queries } of corpus.populations) {
    const measured = measureSearchQuality(
      search,
      resolveQualityTargets(queries, corpus.targets, currentRows),
    );
    const minimum = population.minimum;
    const passed = qualityPasses(
      measured.queries,
      measured.top1,
      measured.top3,
      measured.top10,
      minimum.queries,
      minimum.top1,
      minimum.top3,
      minimum.top10,
    );
    populations.push({ name: population.name, minimum, measured, passed });
    console.info(
      JSON.stringify({
        operation: "search.quality.population",
        ...populations.at(-1),
      }),
    );
  }
  return {
    format: qualityFormat,
    snapshot: bundle.index.header.snapshot,
    corpusSha256: corpus.sha256,
    indexSha256: bundle.indexSha256,
    rankingSha256: bundle.rankingSha256,
    rankingArtifactSha256: bundle.rankingArtifactSha256,
    populations,
    passed: populations.every((population) => population.passed),
  };
}

export async function importQualityCorpus(
  directory: string,
  output: string,
  laboratory: string,
): Promise<void> {
  const freezeBytes = await readFile(
    join(laboratory, "reports/ranking3-freeze.json"),
  );
  const freeze = v.parse(
    v.object({ sourceHashes: v.record(v.string(), DigestSchema) }),
    JSON.parse(freezeBytes.toString("utf8")),
  );
  const validation = v.parse(
    v.object({
      freezeSha256: DigestSchema,
      queryHashes: v.record(v.string(), DigestSchema),
      groups: v.record(v.string(), v.unknown()),
    }),
    JSON.parse(
      await readFile(
        join(laboratory, "reports/ranking3-validation.json"),
        "utf8",
      ),
    ),
  );
  if (validation.freezeSha256 !== digest(freezeBytes))
    throw new Error(
      "Independent validation belongs to a different frozen scorer",
    );
  const developmentBytes = await readFile(
    join(laboratory, "reports/ranking3-development.json"),
  );
  if (
    digest(developmentBytes) !==
    freeze.sourceHashes["reports/ranking3-development.json"]
  )
    throw new Error("Development report changed after freezing");
  const development = v.parse(
    v.object({ groups: v.record(v.string(), v.unknown()) }),
    JSON.parse(developmentBytes.toString("utf8")),
  );
  const definitions: readonly {
    readonly name: string;
    readonly source: string;
    readonly split: QualitySplit;
  }[] = [
    { name: "curated", source: "bench/queries.jsonl", split: "eval" },
    {
      name: "synthetic-test",
      source: "bench/queries-synthetic.jsonl",
      split: "test",
    },
    {
      name: "reading-curated",
      source: "bench/queries-readings.jsonl",
      split: "eval",
    },
    {
      name: "reading-test",
      source: "bench/queries-readings.jsonl",
      split: "test",
    },
    {
      name: "prominence-curated",
      source: "bench/queries-prominence.jsonl",
      split: "eval",
    },
    {
      name: "prominence-test",
      source: "bench/queries-prominence.jsonl",
      split: "test",
    },
    {
      name: "blind-development",
      source: "bench/queries-blind.jsonl",
      split: "blind",
    },
    {
      name: "blind-independent",
      source: "bench/queries-blind2.jsonl",
      split: "blind2",
    },
  ];
  const populations: QualityCorpus["populations"] = [];
  const required = new Set<number>();
  await mkdir(output, { recursive: true });
  for (const definition of definitions) {
    const sourceSha256 =
      freeze.sourceHashes[definition.source] ??
      validation.queryHashes[definition.source];
    if (!sourceSha256)
      throw new Error(`Missing frozen query digest: ${definition.source}`);
    const original = await checkedQualityFile(
      laboratory,
      definition.source,
      sourceSha256,
    );
    const lines = original
      .split("\n")
      .filter(
        (line) =>
          line &&
          v.parse(v.object({ split: v.string() }), JSON.parse(line)).split ===
            definition.split,
      );
    const text = `${lines.join("\n")}\n`;
    const queries = parseQualityQueries(text, definition.split);
    for (const query of queries)
      for (const target of query.targets) required.add(target);
    const group =
      definition.split === "blind2"
        ? validation.groups[`${definition.source}:blind`]
        : development.groups[`${definition.source}:${definition.split}`];
    const baseline = v.parse(
      v.object({
        n: PositiveSchema,
        top1: NaturalSchema,
        top3: NaturalSchema,
        top10: NaturalSchema,
      }),
      group,
    );
    const minimum = v.parse(QualityCountsSchema, {
      queries: baseline.n,
      top1: baseline.top1,
      top3: baseline.top3,
      top10: baseline.top10,
    });
    if (minimum.queries !== queries.length)
      throw new Error(`Frozen population count mismatch: ${definition.name}`);
    const file = `${definition.name}.jsonl`;
    await writeFile(join(output, file), text, { flag: "wx" });
    populations.push({
      name: definition.name,
      file,
      sourceFile: definition.source,
      sourceSha256,
      sha256: digest(new TextEncoder().encode(text)),
      split: definition.split,
      minimum,
    });
  }
  const bundle = await readRankingBundle(directory);
  const namesSha256 = freeze.sourceHashes["data/names.tsv"];
  if (!namesSha256) throw new Error("Missing frozen name table digest");
  const nameTable = await checkedQualityFile(
    laboratory,
    "data/names.tsv",
    namesSha256,
  );
  const frozenTargets = new Map<number, string>();
  for (const line of nameTable.split("\n").slice(1)) {
    if (!line) continue;
    const [rawRow, id] = line.split("\t");
    const row = v.parse(PositiveSchema, Number(rawRow));
    if (!required.has(row)) continue;
    frozenTargets.set(row, v.parse(TextSchema, id));
  }
  const targets: [number, string][] = [];
  const db = new DatabaseSync(join(directory, "directory.sqlite"), {
    readOnly: true,
  });
  try {
    const contacts = db.prepare(
      "SELECT rowid, id, name FROM contacts WHERE rowid = ?",
    );
    for (const rowid of [...required].sort((left, right) => left - right)) {
      const contact = v.parse(ContactSchema, contacts.get(rowid));
      const frozen = frozenTargets.get(rowid);
      if (
        bundle.index.rows[rowid - 1]?.name !== contact.name ||
        frozen !== contact.id
      )
        throw new Error(
          "Imported quality target has a different search index row",
        );
      targets.push([rowid, contact.id]);
    }
  } finally {
    db.close();
  }
  const targetText = `${JSON.stringify(targets)}\n`;
  await writeFile(join(output, "targets.json"), targetText, { flag: "wx" });
  const corpus = v.parse(QualityCorpusSchema, {
    format: qualityFormat,
    snapshot: bundle.index.header.snapshot,
    nameTableSha256: namesSha256,
    frozenScorerSha256: freeze.sourceHashes["scorers/place-reading.ts"],
    developmentReportSha256: digest(developmentBytes),
    validationReportSha256: digest(
      await readFile(join(laboratory, "reports/ranking3-validation.json")),
    ),
    targets: {
      file: "targets.json",
      sha256: digest(new TextEncoder().encode(targetText)),
      count: targets.length,
    },
    populations,
  });
  await writeFile(
    join(output, "manifest.json"),
    `${JSON.stringify(corpus, null, jsonIndentation)}\n`,
    { flag: "wx" },
  );
  console.info(
    JSON.stringify({
      operation: "search.quality.import",
      populations: populations.length,
      queries: populations.reduce(
        (total, population) => total + population.minimum.queries,
        0,
      ),
      targets: targets.length,
    }),
  );
}
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
  readonly rankingArtifactSha256: string;
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
  const decodedRanking = decodeRankingArtifact(
    await decoded(ranking),
    manifest.snapshot,
    manifest.contacts,
  );
  return {
    index,
    ranking: decodedRanking,
    indexSha256: indexArtifact.uncompressedSha256,
    rankingSha256:
      decodedRanking.packed?.sourceSha256 ?? ranking.uncompressedSha256,
    rankingArtifactSha256: ranking.uncompressedSha256,
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
      "Usage: search-ranking-contract.ts generate BUNDLE OUTPUT REFERENCE QUERY_FILES... | check BUNDLE FIXTURE | quality BUNDLE OUTPUT | import-quality BUNDLE OUTPUT LABORATORY",
    );
  if (operation === "quality" && !reference) {
    const report = await checkSearchQuality(directory);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `${JSON.stringify(report, null, jsonIndentation)}\n`,
    );
    console.info(
      JSON.stringify({
        operation: "search.quality",
        passed: report.passed,
        output,
      }),
    );
    if (!report.passed) throw new Error("Frozen search quality regressed");
  } else if (operation === "import-quality" && reference && !paths.length) {
    await importQualityCorpus(directory, output, reference);
  } else if (operation === "reference" && reference && paths.length) {
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
