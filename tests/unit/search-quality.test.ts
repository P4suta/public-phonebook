import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RankedSearch } from "../../src/core/local-search.ts";
import {
  measureSearchQuality,
  qualityPasses,
} from "../../src/core/search-quality.ts";
import {
  parseQualityQueries,
  readQualityCorpus,
  resolveQualityTargets,
} from "../../tools/search-ranking-contract.ts";

describe("search quality", () => {
  it("binds corpus files, target identities, counts, and split admission before reading national data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phonebook-quality-"));
    const hash = (text: string): string =>
      createHash("sha256").update(text).digest("hex");
    const targets = '[[1,"contact:a"]]\n';
    const query = JSON.stringify({
      query: "a",
      targets: [1],
      kind: "kana",
      source: "curated",
      split: "eval",
    });
    const population = {
      name: "curated",
      file: "curated.jsonl",
      sourceFile: "bench/queries.jsonl",
      sourceSha256: hash(query),
      sha256: hash(query),
      split: "eval",
      minimum: { queries: 1, top1: 1, top3: 1, top10: 1 },
    };
    const manifest = {
      format: "public-phonebook-search-quality/1",
      snapshot: "a".repeat(64),
      nameTableSha256: "b".repeat(64),
      frozenScorerSha256: "c".repeat(64),
      developmentReportSha256: "d".repeat(64),
      validationReportSha256: "e".repeat(64),
      targets: { file: "targets.json", sha256: hash(targets), count: 1 },
      populations: [population],
    };
    const save = async (value: unknown): Promise<void> => {
      await writeFile(join(directory, "manifest.json"), JSON.stringify(value));
    };
    try {
      await writeFile(join(directory, "targets.json"), targets);
      await writeFile(join(directory, "curated.jsonl"), query);
      await save(manifest);
      expect((await readQualityCorpus(directory)).targets.get(1)).toBe(
        "contact:a",
      );
      await writeFile(join(directory, "curated.jsonl"), `${query}\n`);
      await expect(readQualityCorpus(directory)).rejects.toThrow("checksum");
      await writeFile(join(directory, "curated.jsonl"), query);
      await save({ ...manifest, populations: [population, population] });
      await expect(readQualityCorpus(directory)).rejects.toThrow("Duplicate");
      await save({
        ...manifest,
        populations: [
          {
            ...population,
            minimum: { queries: 2, top1: 1, top3: 1, top10: 1 },
          },
        ],
      });
      await expect(readQualityCorpus(directory)).rejects.toThrow("count");
      await save(manifest);
      await writeFile(
        join(directory, "targets.json"),
        '[[1,"contact:changed"]]',
      );
      await expect(readQualityCorpus(directory)).rejects.toThrow("checksum");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("counts each query once and accepts any declared target at the cutoff", () => {
    const result = measureSearchQuality(
      {
        search: (query) =>
          (query === "alternate"
            ? [8, 4, 5]
            : query === "tenth"
              ? [...Array.from({ length: 9 }, (_, row) => row), 12]
              : []
          ).map((row) => ({ row, score: 0 })),
      },
      [
        { query: "alternate", targets: [4, 5] },
        { query: "tenth", targets: [12] },
        { query: "missing", targets: [20] },
      ],
    );
    expect(result).toEqual({ queries: 3, top1: 0, top3: 1, top10: 2 });
  });

  it("rejects an empty population and absent target labels", () => {
    const search: RankedSearch = { search: () => [] };
    expect(() => measureSearchQuality(search, [])).toThrow();
    expect(() =>
      measureSearchQuality(search, [{ query: "x", targets: [] }]),
    ).toThrow();
  });

  it("rejects a regression at any cutoff, a changed population, and an empty campaign", () => {
    expect(qualityPasses(10, 7, 8, 9, 10, 7, 8, 9)).toBe(true);
    expect(qualityPasses(10, 6, 9, 10, 10, 7, 8, 9)).toBe(false);
    expect(qualityPasses(10, 7, 7, 10, 10, 7, 8, 9)).toBe(false);
    expect(qualityPasses(10, 7, 8, 8, 10, 7, 8, 9)).toBe(false);
    expect(qualityPasses(11, 8, 9, 10, 10, 7, 8, 9)).toBe(false);
    expect(qualityPasses(0, 0, 0, 0, 0, 0, 0, 0)).toBe(false);
    const emptyRanker = measureSearchQuality({ search: () => [] }, [
      { query: "x", targets: [1] },
    ]);
    expect(
      qualityPasses(
        emptyRanker.queries,
        emptyRanker.top1,
        emptyRanker.top3,
        emptyRanker.top10,
        1,
        1,
        1,
        1,
      ),
    ).toBe(false);
  });

  it("refuses training records, wrong splits, duplicate targets, and missing labels", () => {
    const record = {
      query: "x",
      targets: [1, 2],
      kind: "kana",
      source: "curated",
      split: "eval",
    };
    expect(parseQualityQueries(`${JSON.stringify(record)}\n`, "eval")).toEqual([
      record,
    ]);
    for (const change of [
      { split: "train" },
      { split: "blind" },
      { targets: [] },
      { targets: [1, 1] },
      { targets: [0] },
    ])
      expect(() =>
        parseQualityQueries(JSON.stringify({ ...record, ...change }), "eval"),
      ).toThrow();
  });

  it("resolves stable contact identities after snapshot row ordering changes", () => {
    const records = [{ query: "x", targets: [1, 2] }];
    const targets = new Map([
      [1, "a"],
      [2, "b"],
    ]);
    expect(
      resolveQualityTargets(
        records,
        targets,
        new Map([
          ["a", 8],
          ["b", 3],
        ]),
      ),
    ).toEqual([{ query: "x", targets: [8, 3] }]);
    expect(() =>
      resolveQualityTargets(records, targets, new Map([["a", 8]])),
    ).toThrow("missing");
    expect(() => resolveQualityTargets(records, new Map(), new Map())).toThrow(
      "mapping",
    );
  });
});
