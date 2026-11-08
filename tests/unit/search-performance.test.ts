import { describe, expect, it } from "vitest";
import { type LocalQuery, matchIndex } from "../../src/core/local-search.ts";
import {
  decodeSearchIndex,
  type SearchIndex,
} from "../../src/core/search-index.ts";
import {
  performanceBudget,
  performanceLatency,
  processFootprints,
  searchWork,
} from "../../tools/search-performance.ts";
import { type ModelContact, modelDirectory } from "./local-search-fixture.ts";

const snapshot = "b".repeat(64);
const contacts: ModelContact[] = [
  "Ａ図書館",
  "a図書館",
  "ABC分室",
  "北診療所",
].map((name, position) => ({
  id: `c:${position}`,
  name,
  category: "library",
  prefectureCode: "13",
  municipalityCode: null,
  phones: [{ e164: "+81774981200" }],
}));
const index = decodeSearchIndex(modelDirectory(contacts, snapshot).bytes);

describe("search work", () => {
  it("retains a measured current footprint when the native lifetime peak lags", () => {
    expect(
      processFootprints(
        JSON.stringify([
          {
            pid: 7,
            physicalFootprintBytes: 57_623_944,
            lifetimePeakPhysicalFootprintBytes: 57_607_560,
          },
        ]),
        [7],
      ),
    ).toEqual({
      currentBytes: 57_623_944,
      sumProcessLifetimePeaksBytes: 57_607_560,
    });
  });
  it("requires one valid native footprint for every attributed process", () => {
    const readings = [
      {
        pid: 7,
        physicalFootprintBytes: 12,
        lifetimePeakPhysicalFootprintBytes: 18,
      },
      {
        pid: 8,
        physicalFootprintBytes: 20,
        lifetimePeakPhysicalFootprintBytes: 30,
      },
    ];
    expect(processFootprints(JSON.stringify(readings), [7, 8])).toEqual({
      currentBytes: 32,
      sumProcessLifetimePeaksBytes: 48,
    });
    for (const invalid of [
      [],
      readings.slice(0, 1),
      [...readings, readings[0]],
      [{ ...readings[0], pid: 9 }, readings[1]],
      [{ ...readings[0], physicalFootprintBytes: 0 }, readings[1]],
      [{ ...readings[0], physicalFootprintBytes: 12.5 }, readings[1]],
      [{ ...readings[0], lifetimePeakPhysicalFootprintBytes: 0 }, readings[1]],
      readings.map((reading) => ({
        ...reading,
        physicalFootprintBytes: Number.MAX_SAFE_INTEGER,
        lifetimePeakPhysicalFootprintBytes: Number.MAX_SAFE_INTEGER,
      })),
    ])
      expect(() =>
        processFootprints(JSON.stringify(invalid), [7, 8]),
      ).toThrow();
    expect(() => processFootprints("invalid", [7, 8])).toThrow();
    expect(() => processFootprints("[]", [])).toThrow();
    expect(() => processFootprints(JSON.stringify(readings), [7, 7])).toThrow();
  });

  it("keeps literal interactions and complete-ranking measurements distinct", () => {
    for (const baseline of [10.2, 11.2, 10, 13]) {
      const literal = performanceLatency("literal", 50, null, baseline);
      expect(literal).toEqual({
        metric: "searchRoundTripMs",
        p95Ms: 50,
        maximumP95Ms: 50,
      });
      expect(
        performanceBudget(
          1500,
          400_000_000,
          literal.p95Ms,
          literal.maximumP95Ms,
        ).passed,
      ).toBe(true);
      const ranking = performanceLatency("forgiving", 0, baseline, baseline);
      expect(ranking).toEqual({
        metric: "completeRankingRoundTripMs",
        p95Ms: baseline,
        maximumP95Ms: baseline,
      });
      expect(
        performanceLatency("forgiving", 0, null, baseline).p95Ms,
      ).toBeNull();
      const slower = performanceLatency("literal", 50.01, 0, baseline);
      expect(
        performanceBudget(1500, 400_000_000, slower.p95Ms, slower.maximumP95Ms)
          .passed,
      ).toBe(false);
    }
  });

  it("records inclusive budgets and refuses missing measurements and regressions", () => {
    expect(performanceBudget(1500, 400_000_000, 10.2, 10.2).passed).toBe(true);
    expect(performanceBudget(1500.01, 400_000_000, 10.2, 10.2).passed).toBe(
      false,
    );
    expect(performanceBudget(1500, 400_000_001, 10.2, 10.2).passed).toBe(false);
    expect(performanceBudget(1500, 400_000_000, 10.21, 10.2).passed).toBe(
      false,
    );
    expect(performanceBudget(1500, null, 10.2, 10.2)).toMatchObject({
      memory: null,
      passed: false,
    });
    expect(performanceBudget(null, 1, null, 10.2).passed).toBe(false);
    expect(performanceBudget(1500, 400_000_000, null, 10.2)).toEqual({
      admission: true,
      memory: true,
      latency: null,
      passed: false,
    });
  });
  it("counts the index rows that the matcher reads and the rows it matches", () => {
    expect(searchWork(index, ["図書館", "", "0774981200"])).toEqual({
      queries: 3,
      rowsScanned: { count: 3, p50: 4, p95: 4, max: 4, total: 8 },
      rowsMatched: { count: 3, p50: 4, p95: 4, max: 4, total: 8 },
    });
  });

  it("counts every row read of the matcher it runs", () => {
    const readsTwice = (
      searched: SearchIndex,
      query: LocalQuery,
    ): ReturnType<typeof matchIndex> => {
      let phones = 0;
      for (let position = 0; position < searched.rows.length; position += 1)
        phones += searched.rows[position]?.phones.length ?? 0;
      expect(phones).toBe(contacts.length);
      return matchIndex(searched, query);
    };
    expect(searchWork(index, ["図書館"], readsTwice).rowsScanned.total).toBe(
      2 * contacts.length,
    );
    expect(() => searchWork(index, ["図書館\0"])).toThrow(
      "The sampled query is invalid",
    );
  });
});
