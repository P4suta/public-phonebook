import {
  admitFileSearch,
  type FileSearch,
  maximumSearchBufferBytes,
} from "@public-phonebook/directory/file-search";
import { searchLocalIndex } from "@public-phonebook/directory/local-search";
import { decodeSearchIndex } from "@public-phonebook/directory/search-index";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryFile } from "./file-search-fixture.ts";
import { modelDirectory } from "./local-search-fixture.ts";

const source = modelDirectory(
  Array.from({ length: 90 }, (_, row) => ({
    id: `c:${row}`,
    name: `${row % 3 === 0 ? "図書館" : "Ａ診療所"}${row}`,
    category: row % 2 === 0 ? "library" : "medical",
    prefectureCode: "13",
    municipalityCode: "13101",
    phones: [{ e164: row % 2 === 0 ? "+81335812331" : "+819012345678" }],
  })),
  "d".repeat(64),
);

async function fixture(bytes: Uint8Array = source.bytes): Promise<{
  readonly index: FileSearch;
  readonly files: Readonly<
    Record<"raw" | "folded" | "names" | "phones", MemoryFile>
  >;
}> {
  const raw = new MemoryFile(bytes);
  const files = {
    raw,
    folded: new MemoryFile(),
    names: new MemoryFile(),
    phones: new MemoryFile(),
  };
  const index = await admitFileSearch(files, async () => {});
  return { index, files };
}

describe("search from bounded file buffers", () => {
  it("bounds retained buffers and supports names with an empty comparison form", async () => {
    const directory = modelDirectory(
      [
        {
          id: "c:1",
          name: "\ufe0f",
          category: "library",
          prefectureCode: "13",
          municipalityCode: "13101",
          phones: [{ e164: "+81335812331" }],
        },
      ],
      "d".repeat(64),
    );
    const { index } = await fixture(directory.bytes);
    expect(index.retainedBufferBytes).toBeLessThanOrEqual(
      maximumSearchBufferBytes,
    );
    expect(index.search("東京")).toEqual(
      searchLocalIndex(decodeSearchIndex(directory.bytes), "東京"),
    );
  });
  it("keeps Unicode matching and ordering across file boundaries", async () => {
    const directory = modelDirectory(
      Array.from({ length: 2500 }, (_, row) => ({
        id: `c:${row}`,
        name: `${row % 3 === 0 ? "髙田 図書館𠮷田" : "Ａ診療所 カタカナ"}${"分室".repeat(12)}${row}`,
        category: row % 2 === 0 ? "library" : "medical",
        prefectureCode: "13",
        municipalityCode: "13101",
        phones: [{ e164: "+81335812331" }, { e164: "+819012345678" }],
      })),
      "d".repeat(64),
    );
    const { index } = await fixture(directory.bytes);
    const reference = decodeSearchIndex(directory.bytes);
    for (const query of [
      "髙田",
      "図書館",
      "吉田",
      "かたかな",
      "東京 医療",
      "Ａ 分室",
      "分室2499",
      "090-1234-5678",
    ]) {
      expect(index.search(query)).toEqual(searchLocalIndex(reference, query));
    }
    for (const row of [0, 511, 512, 1499, 2499])
      expect(index.row(row).name).toBe(reference.rows[row]?.name);
  });

  it("matches the in-memory oracle for generated names and queries", async () => {
    const name = fc
      .array(
        fc.constantFrom(
          "あ",
          "亜",
          "Ａ",
          "1",
          "😀",
          "ー",
          " ",
          "髙",
          "図",
          "館",
        ),
        { minLength: 1, maxLength: 20 },
      )
      .map((letters) => letters.join("").trim() || "図");
    await fc.assert(
      fc.asyncProperty(
        fc.array(name, { maxLength: 24 }),
        name,
        async (names, query) => {
          const directory = modelDirectory(
            names.map((name, row) => ({
              id: `c:${row}`,
              name,
              category: row % 2 === 0 ? "library" : "medical",
              prefectureCode: "13",
              municipalityCode: "13101",
              phones: [{ e164: "+81335812331" }],
            })),
            "d".repeat(64),
          );
          const { index } = await fixture(directory.bytes);
          const reference = decodeSearchIndex(directory.bytes);
          expect(index.search(query)).toEqual(
            searchLocalIndex(reference, query),
          );
          expect(index.search("東京 図書館")).toEqual(
            searchLocalIndex(reference, "東京 図書館"),
          );
        },
      ),
      { seed: 20261108, numRuns: 100 },
    );
  });
  it.each([
    "",
    "図書館",
    "診療",
    "とうきょう としょかん",
    "Ａ",
    "0",
    "03-3581-2331",
    "不存在",
    "\ud800",
  ])("keeps literal ranking, groups, and previews for %s", async (query) => {
    const { index } = await fixture();
    const expected = searchLocalIndex(decodeSearchIndex(source.bytes), query);
    expect(index.search(query)).toEqual(expected);
  });

  it("continues a broad result without retaining every matched row", async () => {
    const { index } = await fixture();
    const result = index.search("東京");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const group of result.value.groups) {
      const page = index.continue("東京", group.category, group.rows.length);
      expect(page.ok).toBe(true);
      if (!page.ok) continue;
      expect(page.value.rows).toHaveLength(Math.min(30, group.total - 3));
      expect(new Set([...group.rows, ...page.value.rows]).size).toBe(
        page.value.visible,
      );
      expect(index.continue("東京", group.category, group.total + 1).ok).toBe(
        false,
      );
    }
  });

  it("reads display data only for selected rows", async () => {
    const { index, files } = await fixture();
    const decoded = decodeSearchIndex(source.bytes);
    for (const row of [0, 30, 89]) {
      const expected = decoded.rows[row];
      expect(index.row(row)).toEqual({
        row,
        ...expected,
        normalizedName: undefined,
        searchName: undefined,
      });
    }
    expect(files.raw.largestRead).toBeLessThanOrEqual(1_048_576);
    expect(() => index.row(90)).toThrow();
  });

  it.each([
    source.bytes.subarray(0, source.bytes.length - 1),
    new Uint8Array([0, 1, 2]),
  ])("rejects malformed bytes before becoming searchable", async (bytes) => {
    await expect(fixture(bytes)).rejects.toThrow();
  });
});
