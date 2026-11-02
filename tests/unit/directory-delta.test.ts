import { createHash } from "node:crypto";
import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  PrefectureCodeSchema,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  type DirectoryArchiveContact,
  type DirectoryArchiveSource,
  decodeDirectoryArchive,
  encodeDirectoryArchive,
} from "../../src/core/directory-archive.ts";
import {
  applyDirectoryDelta,
  type DeltaDigest,
  type DirectoryText,
  decodeDirectoryDelta,
  deltaMatchesTarget,
  directoryDeltaFile,
  directoryDeltaFilePattern,
  encodeDirectoryDelta,
  readDirectoryText,
} from "../../src/core/directory-delta.ts";
import {
  copyAdmission,
  deltaAdmission,
  deltaPublication,
} from "../../src/core/directory-delta-policy.ts";
import {
  type Contact,
  ContactSchema,
  PhoneSchema,
  PublicUrlSchema,
} from "../../src/core/models.ts";

const baseSnapshot = "a".repeat(64);
const targetSnapshot = "b".repeat(64);
const otherSnapshot = "c".repeat(64);
const sources: readonly DirectoryArchiveSource[] = [
  { id: "alpha", url: "https://example.org/alpha.csv", publisher: "Alpha" },
  { id: "beta", url: "https://example.org/beta.csv", title: "Beta" },
  { id: "γ", url: "https://example.org/gamma.csv" },
];
const phones = [
  { display: "03-3581-2331", e164: "+81335812331" },
  { display: "０３－３５８１－２３３１", e164: "+81335812331" },
  { display: "(0774) 98 1200", e164: "+81774981200" },
  { display: "090-1234-5678", e164: "+819012345678" },
].map((phone) => v.parse(PhoneSchema, phone));
const links = [
  "https://example.org/data",
  "https://example.org/b",
  "https://example.org/%E5%9B%B3?x=1&y=2#z",
  "http://example.net/",
].map((url) => v.parse(PublicUrlSchema, url));
const earlyLink = v.parse(PublicUrlSchema, "http://a.example/first");
const recollected = "2026-11-30T00:00:00Z";

function digest(): DeltaDigest {
  const hash = createHash("sha256");
  return {
    update: (bytes): void => {
      hash.update(bytes);
    },
    digest: (): string => hash.digest("hex"),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function prefectureCode(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** Encodes an archive with the categories present, like a prepared snapshot. */
function archive(
  contacts: readonly DirectoryArchiveContact[],
  snapshot: string,
): string {
  return encodeDirectoryArchive(contacts, {
    snapshot,
    sources,
    catalog: {
      generatedAt: "2026-10-30T00:00:00Z",
      categories: categoryDefinitions
        .map((category) => ({
          id: category.id,
          label: category.label,
          contacts: contacts.filter(
            (contact) => contact.category === category.id,
          ).length,
          publisher: "Publisher",
          license: "CC0-1.0",
          licenseUrl: "https://example.org/license",
        }))
        .filter((category) => category.contacts > 0),
      prefectures: prefectureNames.map((name, index) => ({
        code: v.parse(PrefectureCodeSchema, prefectureCode(index)),
        name,
        contacts: contacts.filter(
          (contact) => contact.prefectureCode === prefectureCode(index),
        ).length,
      })),
      municipalities: [],
    },
  });
}

function text(value: string): DirectoryText {
  const parsed = readDirectoryText(value);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function identity(value: string): {
  archiveSha256: string;
  sha256: string;
  bytes: number;
} {
  return {
    archiveSha256: sha256(`archive\n${value}`),
    sha256: sha256(value),
    bytes: new TextEncoder().encode(value).byteLength,
  };
}

function delta(baseText: string, targetText: string): string {
  return encodeDirectoryDelta(text(baseText), text(targetText), {
    base: identity(baseText),
    target: identity(targetText),
  });
}

function header(deltaText: string): {
  kept: number;
  added: number;
  removed: number;
} {
  const decoded = decodeDirectoryDelta(deltaText);
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.value.header;
}

function expectReproduces(baseText: string, targetText: string): string {
  const encoded = delta(baseText, targetText);
  expect(delta(baseText, targetText)).toBe(encoded);
  const applied = applyDirectoryDelta(baseText, encoded, digest);
  expect(applied.admission).toBe("apply");
  expect(applied.text).toBe(targetText);
  const decoded = decodeDirectoryDelta(encoded);
  if (!decoded.ok) throw new Error(decoded.error);
  expect(
    deltaMatchesTarget(decoded.value, text(targetText), {
      snapshot: text(targetText).header.snapshot,
      ...identity(targetText),
    }),
  ).toBe(true);
  return encoded;
}

function mutateLines(value: string, change: (lines: string[]) => void): string {
  const lines = value.slice(0, -1).split("\n");
  change(lines);
  return `${lines.join("\n")}\n`;
}

function mutateHeader(
  value: string,
  change: (decoded: Record<string, unknown>) => void,
): string {
  return mutateLines(value, (lines) => {
    const decoded = v.parse(
      v.record(v.string(), v.unknown()),
      JSON.parse(lines[1] ?? ""),
    );
    change(decoded);
    lines[1] = JSON.stringify(decoded);
  });
}

const library = v.parse(ContactSchema, {
  id: "fixture",
  sourceRecordId: "fixture",
  name: "例図書館",
  category: "library",
  prefectureCode: "13",
  municipalityCode: "13101",
  address: "東京都千代田区永田町1-10-1",
  phones: [phones[0]],
  website: null,
  sourceId: "alpha",
  sourceUrls: [links[0]],
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  dataAsOf: "2026-10-01",
  retrievedAt: "2026-10-29T00:00:00Z",
  phoneConfirmed: false,
  phoneConfirmationUrl: null,
});

function libraries(count: number): Contact[] {
  return Array.from({ length: count }, (_, index) => ({
    ...library,
    name: `図書館${String(index).padStart(3, "0")}`,
    sourceId: sources[index % sources.length]?.id ?? "alpha",
    sourceUrls: [links[index % links.length] ?? library.sourceUrls[0] ?? ""],
  }));
}

const textUnit = fc.constantFrom(
  "a",
  "Z",
  "0",
  " ",
  "東",
  "ｱ",
  "é",
  "😀",
  "𠮷",
);
const contactArbitrary = fc
  .record({
    name: fc.string({ unit: textUnit, minLength: 1, maxLength: 8 }),
    category: fc.constantFrom(
      "library",
      "medical",
      "dental",
      "municipal_office",
    ),
    prefecture: fc.integer({ min: 0, max: 46 }),
    municipality: fc.option(fc.integer({ min: 0, max: 999 })),
    address: fc.string({ unit: textUnit, maxLength: 8 }),
    phones: fc.array(fc.constantFrom(...phones), {
      minLength: 1,
      maxLength: 2,
    }),
    website: fc.option(fc.constantFrom(...links)),
    sourceId: fc.constantFrom("alpha", "beta", "γ"),
    license: fc.constantFrom("CC0-1.0", "PDL-1.0"),
    dataAsOf: fc.constantFrom("2026-10-01", ""),
    retrievedAt: fc.constantFrom(
      "2026-10-29T00:00:00Z",
      "2026-10-29T05:52:24.238507Z",
    ),
    sourceUrls: fc.array(fc.constantFrom(...links), {
      minLength: 1,
      maxLength: 2,
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
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
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

const changeArbitrary = fc.record({
  base: fc.array(contactArbitrary, { maxLength: 30 }),
  removed: fc.array(fc.boolean(), { maxLength: 30 }),
  renamed: fc.array(fc.boolean(), { maxLength: 30 }),
  added: fc.array(contactArbitrary, { maxLength: 10 }),
  recollect: fc.boolean(),
  linkShift: fc.boolean(),
  newCategory: fc.boolean(),
  duplicate: fc.boolean(),
});

describe("directory deltas", () => {
  it("names each delta file by its base snapshot", () => {
    expect(directoryDeltaFile(baseSnapshot)).toBe(
      `directory-delta-${baseSnapshot}.tsv.br`,
    );
    expect(
      directoryDeltaFilePattern.test(directoryDeltaFile(baseSnapshot)),
    ).toBe(true);
    for (const name of [
      "directory.tsv.br",
      `directory-delta-${baseSnapshot.toUpperCase()}.tsv.br`,
      `directory-delta-${baseSnapshot}.tsv`,
      `directory-delta-${baseSnapshot}.tsv.br/`,
    ])
      expect(directoryDeltaFilePattern.test(name), name).toBe(false);
    expect(() => directoryDeltaFile("short")).toThrow();
  });

  it("reproduces every generated target byte for byte", () => {
    fc.assert(
      fc.property(changeArbitrary, (change) => {
        const target: Contact[] = [];
        for (const [index, contact] of change.base.entries()) {
          if (change.removed[index]) continue;
          target.push(
            change.renamed[index]
              ? { ...contact, name: `${contact.name}改` }
              : contact,
          );
        }
        target.push(...change.added);
        const base = change.duplicate
          ? [...change.base, ...change.base.slice(0, 1)]
          : change.base;
        const edited = target.map((contact) => ({
          ...contact,
          retrievedAt:
            change.recollect && contact.sourceId === "alpha"
              ? recollected
              : contact.retrievedAt,
        }));
        const [first, ...rest] = edited;
        const shifted =
          change.linkShift && first
            ? [
                { ...first, sourceUrls: [earlyLink, ...first.sourceUrls] },
                ...rest,
              ]
            : edited;
        const final = change.newCategory
          ? [
              ...shifted,
              v.parse(ContactSchema, { ...library, category: "pharmacy" }),
            ]
          : shifted;
        const baseText = archive(base, baseSnapshot);
        const targetText = archive(final, targetSnapshot);
        expectReproduces(baseText, targetText);
        expect(decodeDirectoryArchive(targetText).rows).toHaveLength(
          final.length,
        );
      }),
      { seed: 20261102, numRuns: 300 },
    );
  });

  it("covers empty, identical, all-removed, and all-new pairs", () => {
    const contacts = libraries(8);
    const cases = [
      { base: [], target: [], kept: 0, added: 0, removed: 0 },
      { base: contacts, target: contacts, kept: 8, added: 0, removed: 0 },
      { base: contacts, target: [], kept: 0, added: 0, removed: 8 },
      { base: [], target: contacts, kept: 0, added: 8, removed: 0 },
    ];
    for (const item of cases) {
      const encoded = expectReproduces(
        archive(item.base, baseSnapshot),
        archive(item.target, targetSnapshot),
      );
      expect(header(encoded)).toMatchObject({
        kept: item.kept,
        added: item.added,
        removed: item.removed,
      });
    }
    const identical = delta(
      archive(contacts, baseSnapshot),
      archive(contacts, targetSnapshot),
    );
    expect(identical.slice(0, -1).split("\n").slice(3)).toEqual(["=\t0\t8"]);
  });

  it("copies rows whose provenance, links, or category numbering changed", () => {
    const contacts = libraries(12);
    const baseText = archive(contacts, baseSnapshot);
    const recollection = contacts.map((contact) => ({
      ...contact,
      retrievedAt: recollected,
    }));
    expect(
      header(expectReproduces(baseText, archive(recollection, targetSnapshot))),
    ).toMatchObject({ kept: 12, added: 0, removed: 0 });
    const [first, ...rest] = contacts;
    if (!first) throw new Error("Missing fixture");
    const relinked = [
      { ...first, sourceUrls: [earlyLink] },
      ...rest,
      v.parse(ContactSchema, {
        ...library,
        name: "新しい診療所",
        category: "medical",
      }),
    ];
    expect(
      header(expectReproduces(baseText, archive(relinked, targetSnapshot))),
    ).toMatchObject({ kept: 11, added: 2, removed: 1 });
    const duplicated = archive([...contacts, first], baseSnapshot);
    expect(
      header(expectReproduces(duplicated, archive(contacts, targetSnapshot))),
    ).toMatchObject({ kept: 12, added: 0, removed: 1 });
  });

  it("rejects mismatched bases and corrupted, inconsistent, or altered deltas", () => {
    const contacts = libraries(10);
    const baseText = archive(contacts, baseSnapshot);
    const target = [
      ...contacts.slice(0, 4),
      ...contacts.slice(5),
      { ...library, name: "追加図書館" },
    ];
    const targetText = archive(target, targetSnapshot);
    const encoded = expectReproduces(baseText, targetText);
    const lines = encoded.slice(0, -1).split("\n");
    const addIndex = lines.findIndex((line) => line.startsWith("+\t"));
    const copyIndex = lines.findIndex((line) => line.startsWith("=\t"));
    expect(addIndex).toBeGreaterThan(2);
    expect(copyIndex).toBeGreaterThan(2);
    const apply = (base: string, value: string): string =>
      applyDirectoryDelta(base, value, digest).admission;

    expect(apply(archive(contacts, otherSnapshot), encoded)).toBe(
      "base_mismatch",
    );
    expect(
      apply(
        archive([...contacts, { ...library, name: "別" }], baseSnapshot),
        encoded,
      ),
    ).toBe("base_mismatch");
    expect(apply("not an archive\n", encoded)).toBe("base_mismatch");
    expect(
      apply(
        baseText,
        mutateLines(encoded, (all) => {
          all[addIndex] = (all[addIndex] ?? "").replace("追加", "追伸");
        }),
      ),
    ).toBe("digest_mismatch");
    expect(
      apply(
        baseText,
        mutateLines(encoded, (all) => {
          all[2] = (all[2] ?? "").replace("2026-10-30", "2026-10-31");
        }),
      ),
    ).toBe("digest_mismatch");
    expect(
      apply(
        baseText,
        mutateHeader(encoded, (decoded) => {
          decoded.target = {
            ...v.parse(v.record(v.string(), v.unknown()), decoded.target),
            bytes: identity(targetText).bytes + 1,
          };
        }),
      ),
    ).toBe("length_mismatch");
    expect(
      apply(
        baseText,
        mutateHeader(encoded, (decoded) => {
          decoded.categories = v
            .parse(v.array(v.unknown()), decoded.categories)
            .map(() => null);
        }),
      ),
    ).toBe("malformed");
    const lineChanges: Record<string, (all: string[]) => void> = {
      signature: (all): void => {
        all[0] = "public-phonebook-directory\t1";
      },
      range: (all): void => {
        all[copyIndex] = "=\t0\t11";
      },
      overlap: (all): void => {
        all.splice(copyIndex + 1, 0, "=\t0\t1");
      },
      truncation: (all): void => {
        all.pop();
      },
      "zero copy": (all): void => {
        all[copyIndex] = "=\t0\t0";
      },
      "leading zero": (all): void => {
        all[copyIndex] = "=\t00\t4";
      },
      "unknown instruction": (all): void => {
        all.push("-\trow");
      },
      "short row": (all): void => {
        all[addIndex] = "+\tonly\tfour\tfields\there";
      },
    };
    for (const [label, change] of Object.entries(lineChanges))
      expect(apply(baseText, mutateLines(encoded, change)), label).toBe(
        "malformed",
      );
    const headerChanges: Record<
      string,
      (decoded: Record<string, unknown>) => void
    > = {
      kept: (decoded): void => {
        decoded.kept = Number(decoded.kept) + 1;
      },
      "same snapshot": (decoded): void => {
        decoded.target = {
          ...v.parse(v.record(v.string(), v.unknown()), decoded.target),
          snapshot: baseSnapshot,
        };
      },
      "map range": (decoded): void => {
        decoded.links = v
          .parse(v.array(v.unknown()), decoded.links)
          .map((): number => 99);
      },
    };
    for (const [label, change] of Object.entries(headerChanges))
      expect(apply(baseText, mutateHeader(encoded, change)), label).toBe(
        "malformed",
      );
    const decoded = decodeDirectoryDelta(encoded);
    if (!decoded.ok) throw new Error(decoded.error);
    const otherTarget = archive(contacts, targetSnapshot);
    expect(
      deltaMatchesTarget(decoded.value, text(otherTarget), {
        snapshot: targetSnapshot,
        ...identity(otherTarget),
      }),
    ).toBe(false);
  });

  it("exhausts the delta admission, copy range, and publication decisions", () => {
    for (const baseMatches of [false, true])
      for (const wellFormed of [false, true])
        for (const rows of [0, 1])
          for (const bytes of [0, 1])
            for (const digestMatches of [false, true]) {
              const result = deltaAdmission(
                baseMatches,
                wellFormed,
                rows,
                1,
                bytes,
                1,
                digestMatches,
              );
              expect(result === "apply").toBe(
                baseMatches &&
                  wellFormed &&
                  rows === 1 &&
                  bytes === 1 &&
                  digestMatches,
              );
              expect(result === "base_mismatch").toBe(!baseMatches);
              expect(result === "malformed").toBe(baseMatches && !wellFormed);
              expect(result === "count_mismatch").toBe(
                baseMatches && wellFormed && rows !== 1,
              );
              expect(result === "length_mismatch").toBe(
                baseMatches && wellFormed && rows === 1 && bytes !== 1,
              );
            }
    for (let start = -1; start <= 4; start += 1)
      for (let count = -1; count <= 4; count += 1)
        expect(copyAdmission(start, count, 3), `${start}+${count}`).toBe(
          start >= 0 && count >= 1 && start + count <= 3,
        );
    for (let deltaBytes = 1; deltaBytes <= 12; deltaBytes += 1)
      for (let completeBytes = 0; completeBytes <= 12; completeBytes += 1)
        expect(deltaPublication(deltaBytes, completeBytes)).toBe(
          deltaBytes * 2 <= completeBytes,
        );
  });
});
