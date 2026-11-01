import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  compareUtf8,
  type DirectoryArchiveContact,
  type DirectoryArchiveInput,
  type DirectoryArchiveSource,
  decodeDirectoryArchive,
  directoryArchiveLimits,
  encodeDirectoryArchive,
} from "../../src/core/directory-archive.ts";
import {
  type Contact,
  ContactSchema,
  PhoneSchema,
  PublicUrlSchema,
} from "../../src/core/models.ts";

const libraryIndex = categoryDefinitions.findIndex(
  (category) => category.id === "library",
);
const sources: readonly DirectoryArchiveSource[] = [
  { id: "alpha", url: "https://example.org/alpha.csv", publisher: "Alpha" },
  { id: "beta", url: "https://example.org/beta.csv", title: "Beta" },
  { id: "γ", url: "https://example.org/gamma.csv" },
  { id: "unused", url: "https://example.org/unused.csv" },
];
const base = v.parse(ContactSchema, {
  id: "fixture:1",
  name: "例図書館",
  category: "library",
  prefectureCode: "13",
  municipalityCode: "13101",
  address: "東京都千代田区永田町1-10-1",
  phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
  website: "https://example.org/",
  sourceId: "alpha",
  sourceRecordId: "1",
  sourceUrls: ["https://example.org/data"],
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  dataAsOf: "2026-10-01",
  retrievedAt: "2026-10-29T00:00:00Z",
  phoneConfirmed: false,
  phoneConfirmationUrl: null,
});
const second = v.parse(ContactSchema, {
  ...base,
  id: "fixture:2",
  name: "Ａ図書館",
  prefectureCode: "01",
  municipalityCode: null,
  phones: [
    { display: "０３－３５８１－２３３１", e164: "+81335812331" },
    { display: "090-1234-5678", e164: "+819012345678" },
  ],
  website: null,
  sourceId: "beta",
  sourceUrls: ["https://example.org/b", "https://example.org/data"],
  phoneConfirmed: true,
});

function carried(contact: DirectoryArchiveContact): DirectoryArchiveContact {
  return {
    name: contact.name,
    category: contact.category,
    prefectureCode: contact.prefectureCode,
    municipalityCode: contact.municipalityCode,
    address: contact.address,
    phones: contact.phones.map((phone) => ({
      display: phone.display,
      e164: phone.e164,
    })),
    website: contact.website,
    sourceId: contact.sourceId,
    sourceUrls: [...contact.sourceUrls],
    license: contact.license,
    licenseUrl: contact.licenseUrl,
    dataAsOf: contact.dataAsOf,
    retrievedAt: contact.retrievedAt,
    phoneConfirmed: contact.phoneConfirmed,
    phoneConfirmationUrl: contact.phoneConfirmationUrl,
  };
}

function multiset(contacts: readonly DirectoryArchiveContact[]): string[] {
  return contacts
    .map((contact) => JSON.stringify(carried(contact)))
    .sort(compareUtf8);
}

function compareBytes(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  for (const [index, byte] of leftBytes.entries()) {
    const other = rightBytes[index];
    if (other === undefined) return 1;
    if (byte !== other) return byte - other;
  }
  return leftBytes.length - rightBytes.length;
}

function prefectureCode(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function input(
  contacts: readonly DirectoryArchiveContact[],
): DirectoryArchiveInput {
  return {
    snapshot: "a".repeat(64),
    sources,
    catalog: {
      generatedAt: "2026-10-30T00:00:00Z",
      categories: categoryDefinitions.map((category) => ({
        id: category.id,
        label: category.label,
        contacts: contacts.filter((contact) => contact.category === category.id)
          .length,
        publisher: "Publisher",
        license: "CC0-1.0",
        licenseUrl: "https://example.org/license",
      })),
      prefectures: prefectureNames.map((name, index) => ({
        code: v.parse(PrefectureCodeSchema, prefectureCode(index)),
        name,
        contacts: contacts.filter(
          (contact) => contact.prefectureCode === prefectureCode(index),
        ).length,
      })),
      municipalities: [
        {
          code: v.parse(MunicipalityCodeSchema, "13101"),
          prefectureCode: v.parse(PrefectureCodeSchema, "13"),
          name: "千代田区",
        },
      ],
    },
  };
}

function encode(contacts: readonly DirectoryArchiveContact[]): string {
  return encodeDirectoryArchive(contacts, input(contacts));
}

function mutate(text: string, change: (lines: string[]) => void): string {
  const lines = text.slice(0, -1).split("\n");
  change(lines);
  return `${lines.join("\n")}\n`;
}

function mutateField(text: string, field: number, value: string): string {
  return mutate(text, (lines) => {
    const fields = (lines[2] ?? "").split("\t");
    fields[field] = value;
    lines[2] = fields.join("\t");
  });
}

function mutateHeader(
  text: string,
  change: (header: Record<string, unknown>) => void,
): string {
  return mutate(text, (lines) => {
    const decoded: unknown = JSON.parse(lines[1] ?? "");
    const header = v.parse(v.record(v.string(), v.unknown()), decoded);
    change(header);
    lines[1] = JSON.stringify(header);
  });
}

const textUnit = fc.constantFrom(
  "a",
  "Z",
  "0",
  " ",
  ",",
  ";",
  "\\",
  '"',
  "<",
  "東",
  "京",
  "ー",
  "ｱ",
  "é",
  "",
  "�",
  "😀",
  "𠮷",
);
const phones = [
  { display: "03-3581-2331", e164: "+81335812331" },
  { display: "０３－３５８１－２３３１", e164: "+81335812331" },
  { display: "+81-3-3581-2331", e164: "+81335812331" },
  { display: "03-35１2-1805", e164: "+81335121805" },
  { display: "(0774) 98 1200", e164: "+81774981200" },
  { display: "090-1234-5678", e164: "+819012345678" },
].map((phone) => v.parse(PhoneSchema, phone));
const links = [
  "https://example.org/data",
  "https://example.org/b",
  "https://example.org/%E5%9B%B3?x=1&y=2#z",
  "http://example.net/",
].map((url) => v.parse(PublicUrlSchema, url));
const contactArbitrary = fc
  .record({
    name: fc.string({ unit: textUnit, minLength: 1, maxLength: 12 }),
    category: fc.constantFrom("library", "medical", "dental"),
    prefecture: fc.integer({ min: 0, max: 46 }),
    municipality: fc.option(fc.integer({ min: 0, max: 999 })),
    address: fc.string({ unit: textUnit, maxLength: 16 }),
    phones: fc.array(fc.constantFrom(...phones), {
      minLength: 1,
      maxLength: 3,
    }),
    website: fc.option(fc.constantFrom(...links)),
    sourceId: fc.constantFrom("alpha", "beta", "γ"),
    license: fc.constantFrom("CC0-1.0", "PDL-1.0"),
    licenseUrl: fc.constantFrom(
      "https://creativecommons.org/publicdomain/zero/1.0/",
      "https://www.digital.go.jp/resources/open_data/public_data_license_v1.0",
    ),
    dataAsOf: fc.constantFrom("2026-10-01", "Not specified by source", ""),
    retrievedAt: fc.constantFrom(
      "2026-10-29T00:00:00Z",
      "2026-10-29T05:52:24.238507Z",
    ),
    sourceUrls: fc.array(fc.constantFrom(...links), {
      minLength: 1,
      maxLength: 3,
    }),
    confirmation: fc.oneof(
      fc.constant({ confirmed: false, url: null }),
      fc.constant({ confirmed: true, url: null }),
      fc.constantFrom(...links).map((url) => ({ confirmed: true, url })),
    ),
  })
  .map((value) => {
    const code = prefectureCode(value.prefecture);
    return v.safeParse(ContactSchema, {
      id: "generated",
      sourceRecordId: "generated",
      name: value.name,
      category: value.category,
      prefectureCode: code,
      municipalityCode:
        value.municipality === null
          ? null
          : `${code}${String(value.municipality).padStart(3, "0")}`,
      address: value.address,
      phones: value.phones,
      website: value.website,
      sourceId: value.sourceId,
      sourceUrls: value.sourceUrls,
      license: value.license,
      licenseUrl: value.licenseUrl,
      dataAsOf: value.dataAsOf,
      retrievedAt: value.retrievedAt,
      phoneConfirmed: value.confirmation.confirmed,
      phoneConfirmationUrl: value.confirmation.url,
    });
  })
  .filter((result) => result.success)
  .map((result): Contact => {
    if (!result.success) throw new Error("Filtered contact");
    return result.output;
  });

describe("directory archive", () => {
  it("encodes the documented line format with canonical dictionaries", () => {
    const text = encode([base, second]);
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe("public-phonebook-directory\t1");
    const header: unknown = JSON.parse(lines[1] ?? "");
    expect(
      Object.keys(v.parse(v.record(v.string(), v.unknown()), header)),
    ).toEqual([
      "snapshot",
      "generatedAt",
      "contacts",
      "categories",
      "prefectures",
      "municipalities",
      "sources",
      "provenances",
      "links",
    ]);
    const provenance = {
      license: "CC0-1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      dataAsOf: "2026-10-01",
      retrievedAt: "2026-10-29T00:00:00Z",
    };
    expect(header).toMatchObject({
      snapshot: "a".repeat(64),
      generatedAt: "2026-10-30T00:00:00Z",
      contacts: 2,
      municipalities: [
        { code: "13101", prefectureCode: "13", name: "千代田区" },
      ],
      sources: [
        {
          id: "alpha",
          url: "https://example.org/alpha.csv",
          publisher: "Alpha",
        },
        { id: "beta", url: "https://example.org/beta.csv", title: "Beta" },
      ],
      provenances: [
        { source: 0, ...provenance },
        { source: 1, ...provenance },
      ],
      links: ["https://example.org/b", "https://example.org/data"],
    });
    const decoded = decodeDirectoryArchive(text);
    expect(decoded.header.categories[libraryIndex]).toEqual({
      id: "library",
      label: categoryDefinitions[libraryIndex]?.label,
      publisher: "Publisher",
      license: "CC0-1.0",
      licenseUrl: "https://example.org/license",
    });
    expect(decoded.header.prefectures).toHaveLength(47);
    expect(decoded.header.prefectures[0]).toEqual({
      code: "01",
      name: "北海道",
      contacts: 1,
    });
    expect(lines.slice(2, -1)).toEqual([
      [
        libraryIndex,
        "01",
        "Ａ図書館",
        "東京都千代田区永田町1-10-1",
        "0335812331\u001e０３－３５８１－２３３１\u001f090-1234-5678",
        "",
        1,
        "0\u001f1",
        "*",
      ].join("\t"),
      [
        libraryIndex,
        "13101",
        "例図書館",
        "東京都千代田区永田町1-10-1",
        "03-3581-2331",
        "https://example.org/",
        0,
        1,
        "",
      ].join("\t"),
    ]);
    expect(decoded.rows).toEqual([carried(second), carried(base)]);
  });

  it("round-trips every carried field in canonical UTF-8 order", () => {
    fc.assert(
      fc.property(
        fc.array(contactArbitrary, { maxLength: 24 }),
        (contacts: Contact[]) => {
          const text = encode(contacts);
          const decoded = decodeDirectoryArchive(text);
          expect(multiset(decoded.rows)).toEqual(multiset(contacts));
          expect(decoded.header.contacts).toBe(contacts.length);
          const rows = text.slice(0, -1).split("\n").slice(2);
          for (const [index, row] of rows.entries())
            if (index > 0)
              expect(
                compareBytes(rows[index - 1] ?? "", row),
              ).toBeLessThanOrEqual(0);
          expect(encode(contacts.toReversed())).toBe(text);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("compares strings exactly as their UTF-8 bytes", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary", maxLength: 8 }),
        fc.string({ unit: "binary", maxLength: 8 }),
        (left: string, right: string) => {
          expect(Math.sign(compareUtf8(left, right))).toBe(
            Math.sign(compareBytes(left, right)),
          );
        },
      ),
      { numRuns: 1000 },
    );
    const rows = encode([
      { ...base, name: "😀" },
      { ...base, name: "" },
    ]).split("\n");
    expect(rows[2]).toContain("");
    expect(rows[3]).toContain("😀");
  });

  it("keeps equal rows and an empty directory", () => {
    const duplicate = decodeDirectoryArchive(encode([base, base]));
    expect(duplicate.rows).toEqual([carried(base), carried(base)]);
    const empty = encode([]);
    expect(empty.split("\n")).toHaveLength(3);
    expect(decodeDirectoryArchive(empty).rows).toEqual([]);
  });

  it("rejects contacts the format cannot carry", () => {
    for (const character of ["\t", "\n", "\r", "\u001e", "\u001f", "\ud800"])
      for (const contact of [
        { ...base, name: `例${character}` },
        { ...base, address: `住所${character}` },
        {
          ...base,
          phones: [{ display: `03${character}`, e164: "+81335812331" }],
        },
        { ...base, website: `https://example.org/${character}` },
        { ...base, sourceUrls: [`https://example.org/${character}`] },
        { ...base, license: `CC0${character}` },
        { ...base, dataAsOf: `2026${character}` },
      ])
        expect(() => encode([contact]), JSON.stringify(character)).toThrow(
          "reserved character",
        );
    const withoutLibrary = input([base]);
    expect(() =>
      encodeDirectoryArchive([base], {
        ...withoutLibrary,
        catalog: {
          ...withoutLibrary.catalog,
          categories: withoutLibrary.catalog.categories.filter(
            (category) => category.id !== "library",
          ),
        },
      }),
    ).toThrow("Unknown directory archive category");
    expect(() =>
      encodeDirectoryArchive([base], { ...input([base]), sources: [] }),
    ).toThrow("Unknown directory archive source");
    expect(() =>
      encode([{ ...base, phoneConfirmationUrl: "https://example.org/" }]),
    ).toThrow("confirmed telephone");
    expect(() =>
      encode([
        { ...base, municipalityCode: v.parse(MunicipalityCodeSchema, "14100") },
      ]),
    ).toThrow("conflicting region");
    expect(() => encodeDirectoryArchive([base], input([]))).toThrow(
      "prefecture count mismatch",
    );
    expect(() =>
      encode([
        {
          ...base,
          sourceUrls: Array.from(
            { length: directoryArchiveLimits.links + 1 },
            (_, index) => `https://example.org/${index}`,
          ),
        },
      ]),
    ).toThrow("link dictionary exceeds its limit");
  });

  it("rejects malformed archives", () => {
    const text = encode([base, second]);
    const single = encode([base]);
    const cases: readonly (readonly [string, string])[] = [
      [`\u{feff}${text}`, "format"],
      [text.replace("\t1\n", "\t2\n"), "format"],
      [text.replaceAll("\n", "\r\n"), "format"],
      [text.slice(0, -1), "line feed"],
      [`${text}\n`, "contact count"],
      [
        mutate(text, (lines) => {
          lines.splice(2, 1);
        }),
        "contact count",
      ],
      [
        mutate(text, (lines) => {
          [lines[2], lines[3]] = [lines[3] ?? "", lines[2] ?? ""];
        }),
        "sorted",
      ],
      [
        mutate(single, (lines) => {
          lines[2] = `${lines[2]}\t`;
        }),
        "nine fields",
      ],
      [
        mutate(single, (lines) => {
          lines[2] = (lines[2] ?? "").split("\t").slice(0, -1).join("\t");
        }),
        "nine fields",
      ],
      [mutateField(single, 0, "999"), "category index is out of range"],
      [mutateField(single, 0, `0${libraryIndex}`), "not canonical"],
      [mutateField(single, 1, "131"), "region"],
      [mutateField(single, 1, "14"), "prefecture count mismatch: 13"],
      [mutateField(single, 2, "例\u001f"), "reserved character"],
      [mutateField(single, 3, "住所\r"), "reserved character"],
      [
        mutateField(single, 4, "0335812331\u001e03-3581-2331"),
        "repeats its spelling",
      ],
      [mutateField(single, 4, "03-3581"), "national number"],
      [mutateField(single, 4, "a\u001eb\u001ec"), "too many parts"],
      [mutateField(single, 6, "7"), "provenance index is out of range"],
      [mutateField(single, 7, ""), "origin index is not canonical"],
      [mutateField(single, 7, "1"), "origin index is out of range"],
      [mutateField(single, 8, "x"), "confirmation index is not canonical"],
      [
        mutateHeader(text, (header) => {
          header.contacts = 3;
        }),
        "contact count",
      ],
      [
        mutateHeader(text, (header) => {
          header.links = ["https://example.org/data", "https://example.org/b"];
        }),
        "links must be unique and ascending",
      ],
      [
        mutateHeader(text, (header) => {
          header.links = [
            "https://example.org/b",
            "https://example.org/data",
            "https://example.org/unused",
          ];
        }),
        "must be referenced",
      ],
      [
        mutateHeader(text, (header) => {
          header.sources = sources.slice(0, 3);
        }),
        "Every directory archive source must have a provenance",
      ],
      [
        mutateHeader(text, (header) => {
          header.sources = [
            { id: "beta", url: "https://example.org/beta.csv" },
            { id: "alpha", url: "https://example.org/alpha.csv" },
          ];
        }),
        "sources must be unique and ascending",
      ],
      [
        mutateHeader(text, (header) => {
          const [first, last] = v.parse(
            v.array(v.unknown()),
            header.provenances,
          );
          header.provenances = [first, last, last];
        }),
        "provenances must be unique and ascending",
      ],
      [
        mutateHeader(text, (header) => {
          header.links = Array.from(
            { length: directoryArchiveLimits.links + 1 },
            (_, index) =>
              `https://example.org/${String(index).padStart(6, "0")}`,
          );
        }),
        "Invalid length",
      ],
      [
        mutateHeader(text, (header) => {
          header.prefectures = v
            .parse(v.array(v.unknown()), header.prefectures)
            .slice(1);
        }),
        "Invalid length",
      ],
      [
        mutateHeader(text, (header) => {
          header.extra = true;
        }),
        "Invalid key",
      ],
    ];
    for (const [archive, message] of cases)
      expect(() => decodeDirectoryArchive(archive), message).toThrow(message);
  });
});
