import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
  prefectureNames,
} from "../../src/core/catalog.ts";
import { PreparedDatasetManifestSchema } from "../../src/core/dataset-storage.ts";
import { compareUtf8 } from "../../src/core/directory-archive.ts";
import { normalizeName } from "../../src/core/identity.ts";
import {
  compareRowOrder,
  decodeSearchIndex,
  encodeSearchIndex,
  type SearchIndexHeader,
  SearchIndexHeaderSchema,
  type SearchIndexInput,
  type SearchIndexRow,
  searchIndexLimits,
  searchIndexRow,
} from "../../src/core/search-index.ts";
import { searchForm } from "../../src/core/search-text.ts";

const snapshot = "a".repeat(64);
const libraryIndex = categoryDefinitions.findIndex(
  (category) => category.id === "library",
);
const medicalIndex = categoryDefinitions.findIndex(
  (category) => category.id === "medical",
);
const input: SearchIndexInput = {
  snapshot,
  catalog: {
    categories: categoryDefinitions.map((category) => ({
      id: category.id,
      label: category.label,
      contacts: 0,
      publisher: "Publisher",
      license: "CC0-1.0",
      licenseUrl: "https://example.org/license",
    })),
    prefectures: prefectureNames.map((name, index) => ({
      code: v.parse(PrefectureCodeSchema, String(index + 1).padStart(2, "0")),
      name,
      contacts: 0,
    })),
    municipalities: [
      {
        code: v.parse(MunicipalityCodeSchema, "13101"),
        prefectureCode: v.parse(PrefectureCodeSchema, "13"),
        name: "千代田区",
      },
      {
        code: v.parse(MunicipalityCodeSchema, "26366"),
        prefectureCode: v.parse(PrefectureCodeSchema, "26"),
        name: "精華町",
      },
    ],
  },
};
const library: SearchIndexRow = {
  normalizedName: "a図書館",
  searchName: "a図書館",
  name: "Ａ図書館",
  category: "library",
  region: "13101",
  phones: ["0335812331", "09012345678"],
  hasAddress: true,
};
const clinic: SearchIndexRow = {
  normalizedName: "例診療所",
  searchName: "例診療所",
  name: "例診療所",
  category: "medical",
  region: "01",
  phones: ["0774981200"],
  hasAddress: false,
};

interface Layout {
  readonly header: SearchIndexHeader;
  readonly parts: readonly Uint8Array[];
}

function layout(bytes: Uint8Array): Layout {
  const signatureEnd = bytes.indexOf(0x0a);
  const headerEnd = bytes.indexOf(0x0a, signatureEnd + 1);
  const decoded: unknown = JSON.parse(
    new TextDecoder().decode(bytes.subarray(signatureEnd + 1, headerEnd)),
  );
  const header = v.parse(SearchIndexHeaderSchema, decoded);
  const lengths = [
    header.parts.names,
    header.parts.categories,
    header.parts.regions,
    header.parts.phones,
  ];
  let offset = headerEnd + 1;
  const parts = lengths.map((length) => {
    const part = bytes.slice(offset, offset + length);
    offset += length;
    return part;
  });
  return { header, parts };
}

function assemble(
  header: unknown,
  parts: readonly Uint8Array[],
  signature = "public-phonebook-search-index\t1",
): Uint8Array {
  const prefix = new TextEncoder().encode(
    `${signature}\n${JSON.stringify(header)}\n`,
  );
  const output = new Uint8Array(
    prefix.length + parts.reduce((sum, part) => sum + part.length, 0),
  );
  output.set(prefix);
  let offset = prefix.length;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const partNames = ["names", "categories", "regions", "phones"] as const;

function withPart(
  bytes: Uint8Array,
  index: number,
  part: Uint8Array,
): Uint8Array {
  const { header, parts } = layout(bytes);
  const name = partNames[index] ?? "names";
  return assemble(
    { ...header, parts: { ...header.parts, [name]: part.length } },
    parts.map((item, position) => (position === index ? part : item)),
  );
}

function withNames(bytes: Uint8Array, names: string): Uint8Array {
  return withPart(bytes, 0, text(names));
}

function withPhones(bytes: Uint8Array, phones: string): Uint8Array {
  return withPart(bytes, partNames.indexOf("phones"), text(phones));
}

function withHeader(
  bytes: Uint8Array,
  change: (header: Record<string, unknown>) => void,
): Uint8Array {
  const { header, parts } = layout(bytes);
  const copy: Record<string, unknown> = structuredClone({ ...header });
  change(copy);
  return assemble(copy, parts);
}

const nameUnit = fc.constantFrom(
  "a",
  "Z",
  "Ａ",
  "0",
  "０",
  " ",
  "図",
  "書",
  "館",
  "ｱ",
  "ー",
  "é",
  "İ",
  "",
  "😀",
  "𠮷",
);
const rowArbitrary = fc
  .record({
    name: fc.string({ unit: nameUnit, minLength: 1, maxLength: 10 }),
    category: fc.constantFrom("library", "medical", "dental"),
    region: fc.constantFrom("01", "13", "13101", "26366", "47"),
    phones: fc.uniqueArray(
      fc.constantFrom("0335812331", "0774981200", "09012345678", "0120123456"),
      { minLength: 1, maxLength: 3 },
    ),
    hasAddress: fc.boolean(),
  })
  .map((row) => ({
    ...row,
    normalizedName: normalizeName(row.name),
    searchName: searchForm(row.name),
  }))
  .filter((row) => row.normalizedName !== "");

function sorted(rows: readonly SearchIndexRow[]): SearchIndexRow[] {
  return rows.toSorted((left, right) =>
    compareUtf8(left.normalizedName, right.normalizedName),
  );
}

describe("search index", () => {
  it("encodes the documented signature, header, and parts", () => {
    const bytes = encodeSearchIndex([library, clinic], input);
    const lines = new TextDecoder().decode(bytes).split("\n");
    expect(lines[0]).toBe("public-phonebook-search-index\t1");
    const header: unknown = JSON.parse(lines[1] ?? "");
    expect(
      Object.keys(v.parse(v.record(v.string(), v.unknown()), header)),
    ).toEqual([
      "snapshot",
      "contacts",
      "categories",
      "prefectures",
      "municipalities",
      "regions",
      "rowsWithoutAddress",
      "parts",
    ]);
    const decoded = layout(bytes);
    expect(decoded.header).toMatchObject({
      snapshot,
      contacts: 2,
      regions: ["01", "13101"],
      rowsWithoutAddress: [1],
      parts: { categories: 2, regions: 4 },
    });
    expect(decoded.header.categories[libraryIndex]).toEqual({
      id: "library",
      label: "図書館",
    });
    expect(decoded.header.prefectures[12]).toEqual({
      code: "13",
      name: "東京都",
    });
    expect(decoded.header.municipalities).toEqual(input.catalog.municipalities);
    const [names, categories, regions, phones] = decoded.parts;
    expect(new TextDecoder().decode(names)).toBe(
      "a図書館\tＡ図書館\n例診療所\n",
    );
    expect([...(categories ?? [])]).toEqual([libraryIndex, medicalIndex]);
    expect([...(regions ?? [])]).toEqual([1, 0, 0, 0]);
    expect(new TextDecoder().decode(phones)).toBe(
      "0335812331 09012345678\n0774981200\n",
    );
    expect(decodeSearchIndex(bytes).rows).toEqual([library, clinic]);
  });

  it("round-trips every row in normalized name order", () => {
    fc.assert(
      fc.property(fc.array(rowArbitrary, { maxLength: 24 }), (generated) => {
        const rows = sorted(generated);
        const bytes = encodeSearchIndex(rows, input);
        const decoded = decodeSearchIndex(bytes);
        expect(decoded.rows).toEqual(rows);
        expect(decoded.header.contacts).toBe(rows.length);
        expect(decoded.header.regions).toEqual(
          [...new Set(rows.map((row) => row.region))].sort(compareUtf8),
        );
        expect(decoded.header.rowsWithoutAddress).toEqual(
          rows.flatMap((row, position) => (row.hasAddress ? [] : [position])),
        );
        expect(encodeSearchIndex(decoded.rows, input)).toEqual(bytes);
      }),
      { seed: 20261106, numRuns: 200 },
    );
  });

  it("orders rows by the normalized name's UTF-8 bytes and then the identifier", () => {
    const keys = [
      { normalizedName: "𠮷野家", id: "c:5" },
      { normalizedName: "\u{e000}施設", id: "c:6" },
      { normalizedName: "a図書館", id: "c:3" },
      { normalizedName: "a図書館", id: "c:2" },
      { normalizedName: "ab", id: "c:4" },
    ];
    expect(keys.toSorted(compareRowOrder).map((key) => key.id)).toEqual([
      "c:4",
      "c:2",
      "c:3",
      "c:6",
      "c:5",
    ]);
  });

  it("derives rows from contacts with national telephone numbers", () => {
    expect(
      searchIndexRow({
        name: "Ａ図書館",
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: "+81335812331" }, { e164: "+819012345678" }],
        hasAddress: false,
      }),
    ).toEqual({
      normalizedName: "a図書館",
      searchName: "a図書館",
      name: "Ａ図書館",
      category: "library",
      region: "13",
      phones: ["0335812331", "09012345678"],
      hasAddress: false,
    });
    expect(() =>
      searchIndexRow({
        name: "例",
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: "+12025550123" }],
        hasAddress: true,
      }),
    ).toThrow("Japanese number");
  });

  it("reads an older header without the address list as rows that all have an address", () => {
    const bytes = encodeSearchIndex([library, clinic], input);
    const older = withHeader(bytes, (header) => {
      delete header.rowsWithoutAddress;
    });
    expect(decodeSearchIndex(older).rows).toEqual([
      library,
      { ...clinic, hasAddress: true },
    ]);
    expect(decodeSearchIndex(bytes).rows).toEqual([library, clinic]);
  });

  it("rejects rows the format can't carry", () => {
    for (const character of ["\t", "\n", "\r", "\ud800"])
      for (const name of [`例${character}館`, `例館${character}`])
        expect(
          () =>
            encodeSearchIndex(
              [{ ...library, name, normalizedName: normalizeName(name) }],
              input,
            ),
          JSON.stringify(name),
        ).toThrow("reserved character");
    const cases: readonly (readonly [readonly SearchIndexRow[], string])[] = [
      [[clinic, library], "normalized name order"],
      [[{ ...library, normalizedName: "Ａ図書館" }], "normalized form"],
      [[{ ...library, normalizedName: "", name: " " }], "normalized form"],
      [[{ ...library, category: "unknown" }], "Unknown search index category"],
      [[{ ...library, region: "48" }], "region code"],
      [[{ ...library, region: "131" }], "region code"],
      [[{ ...library, phones: [] }], "distinct national"],
      [[{ ...library, phones: ["0335812331", "0335812331"] }], "distinct"],
      [[{ ...library, phones: ["+81335812331"] }], "distinct national"],
      [[{ ...library, phones: ["03-3581-2331"] }], "distinct national"],
    ];
    for (const [rows, message] of cases)
      expect(() => encodeSearchIndex(rows, input), message).toThrow(message);
    expect(() =>
      encodeSearchIndex([library], {
        ...input,
        catalog: {
          ...input.catalog,
          municipalities: input.catalog.municipalities.toReversed(),
        },
      }),
    ).toThrow("municipalities must be unique and ascending");
  });

  it("rejects malformed indexes", () => {
    const bytes = encodeSearchIndex([library, clinic], input);
    const single = encodeSearchIndex([library], input);
    const { parts } = layout(bytes);
    const cases: readonly (readonly [Uint8Array, string])[] = [
      [new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]), "format"],
      [
        assemble(
          layout(bytes).header,
          parts,
          "public-phonebook-search-index\t2",
        ),
        "format",
      ],
      [bytes.slice(0, 20), "format"],
      [text("public-phonebook-search-index\t1\n{}"), "header"],
      [new Uint8Array([...bytes, 0x0a]), "length differs"],
      [bytes.slice(0, -1), "length differs"],
      [
        withHeader(bytes, (header) => {
          header.extra = true;
        }),
        "Invalid key",
      ],
      [
        withHeader(bytes, (header) => {
          header.contacts = 3;
        }),
        "part lengths",
      ],
      [
        withHeader(bytes, (header) => {
          header.regions = ["01", "13101", "26366"];
        }),
        "must be referenced",
      ],
      [
        withHeader(bytes, (header) => {
          header.regions = ["13101", "01"];
        }),
        "regions must be unique and ascending",
      ],
      [
        withHeader(bytes, (header) => {
          header.snapshot = "A".repeat(64);
        }),
        "Invalid",
      ],
      ...[[2], [1, 1], [1, 0], [-1], [0.5]].map(
        (rows) =>
          [
            withHeader(bytes, (header) => {
              header.rowsWithoutAddress = rows;
            }),
            rows.every((row) => Number.isSafeInteger(row) && row >= 0)
              ? "unique, ascending row positions"
              : "Invalid",
          ] as const,
      ),
      [withNames(bytes, "a図書館\tＡ図書館\n例診療所"), "line feed"],
      [withNames(bytes, "a図書館\tＡ図書館\n"), "contact count"],
      [withNames(bytes, "a図書館\ta図書館\n例診療所\n"), "repeats"],
      [withNames(bytes, "a図書館\tＡ図書館\tx\n例診療所\n"), "too many fields"],
      [withNames(bytes, "Ａ図書館\n例診療所\n"), "normalized form"],
      [withNames(bytes, "a図書館\r\n例診療所\n"), "reserved character"],
      [
        withNames(bytes, "例診療所\na図書館\tＡ図書館\n"),
        "normalized name order",
      ],
      [withNames(bytes, "\n例診療所\n"), "normalized form"],
      [
        withPart(bytes, 0, new Uint8Array([0xff, 0x0a, ...text("例診療所\n")])),
        "isn't UTF-8",
      ],
      [
        withPart(bytes, 1, new Uint8Array([255, medicalIndex])),
        "category index",
      ],
      [withPart(bytes, 2, new Uint8Array([2, 0, 0, 0])), "region index"],
      [
        withPhones(bytes, "0335812331  09012345678\n0774981200\n"),
        "distinct national",
      ],
      [withPhones(bytes, "0335812331 0335812331\n0774981200\n"), "distinct"],
      [withPhones(bytes, "\n0774981200\n"), "distinct national"],
      [withPhones(bytes, "0335812331\n"), "contact count"],
      [withPhones(single, "0335812331\n0774981200\n"), "contact count"],
    ];
    for (const [archive, message] of cases)
      expect(() => decodeSearchIndex(archive), message).toThrow(message);
    const empty = encodeSearchIndex([], input);
    expect(decodeSearchIndex(empty).rows).toEqual([]);
    expect(() => decodeSearchIndex(withNames(empty, "\n"))).toThrow(
      "extra lines",
    );
  });

  it("caps the compressed index at 8 MiB in the prepared manifest", () => {
    expect(searchIndexLimits.compressedBytes).toBe(8 * 1024 * 1024);
    const manifest = {
      snapshot,
      generatedAt: "2026-11-01T00:00:00Z",
      contacts: 1,
      phones: 1,
      sourceCount: 1,
      sourceDatabaseSha256: "b".repeat(64),
      databaseSha256: "c".repeat(64),
      files: [
        "contacts.jsonl.gz",
        "contacts.csv.gz",
        "contacts.vcf.gz",
        "directory.tsv.br",
      ].map((file) => ({
        file,
        sha256: "d".repeat(64),
        bytes: 1,
        url: `/api/datasets/${snapshot}/${"d".repeat(64)}/${file}`,
      })),
      searchIndex: {
        file: "search-index.br",
        sha256: "e".repeat(64),
        bytes: searchIndexLimits.compressedBytes,
        uncompressedSha256: "f".repeat(64),
        uncompressedBytes: searchIndexLimits.compressedBytes * 4,
      },
    };
    expect(v.safeParse(PreparedDatasetManifestSchema, manifest).success).toBe(
      true,
    );
    for (const invalid of [
      {
        ...manifest,
        searchIndex: {
          ...manifest.searchIndex,
          bytes: searchIndexLimits.compressedBytes + 1,
        },
      },
      {
        ...manifest,
        searchIndex: { ...manifest.searchIndex, file: "directory.tsv.br" },
      },
      { ...manifest, files: manifest.files.slice(1) },
      Object.fromEntries(
        Object.entries(manifest).filter(([key]) => key !== "searchIndex"),
      ),
    ])
      expect(v.safeParse(PreparedDatasetManifestSchema, invalid).success).toBe(
        false,
      );
  });
});
