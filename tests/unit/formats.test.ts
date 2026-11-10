import { importContact } from "@public-phonebook/data/import-contact";
import {
  contactCsv,
  contactCsvColumns,
  FormulaInertTelephonesSchema,
  guardSpreadsheetFormula,
} from "@public-phonebook/data/snapshot";
import {
  type Contact,
  ContactSchema,
  PublicUrlSchema,
} from "@public-phonebook/directory/models";
import { normalizePhone } from "@public-phonebook/directory/phone";
import { decodeCursor, encodeCursor } from "@public-phonebook/directory/search";
import {
  contactVCard,
  escapeVCard,
  foldVCardLine,
} from "@public-phonebook/directory/vcard";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

/** The leading characters that csv-stringify's `escape_formulas` guards in a string cell. */
const spreadsheetFormulaPrefixes = [
  "=",
  "+",
  "-",
  "@",
  "\t",
  "\r",
  "\u{ff1d}",
  "\u{ff0b}",
  "\u{ff0d}",
  "\u{ff20}",
] as const;

function csvRows(text: string): string[][] {
  const decoded: unknown = parse(text);
  return v.parse(v.array(v.array(v.string())), decoded);
}

function csvColumn(name: (typeof contactCsvColumns)[number]): number {
  return contactCsvColumns.indexOf(name);
}

const fixture: Contact = v.parse(ContactSchema, {
  id: "fixture:1",
  name: '施設;名前,改行\n"例"',
  category: "library",
  prefectureCode: "13",
  municipalityCode: "13101",
  address: "東京都千代田区（本館）",
  phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
  website: "https://example.org/",
  sourceId: "fixture",
  sourceRecordId: "1",
  sourceUrls: ["https://example.org/data"],
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  dataAsOf: "2026-10-01",
  retrievedAt: "2026-10-29T00:00:00Z",
  phoneConfirmed: false,
  phoneConfirmationUrl: null,
});

describe("validated wire formats", () => {
  it("rejects unsafe or malformed URLs without throwing inside validation", () => {
    for (const url of [
      "",
      "javascript:alert(1)",
      "data:text/html,bad",
      "file:///tmp/file",
      "https://user:password@example.org/",
    ])
      expect(v.safeParse(PublicUrlSchema, url).success).toBe(false);
    expect(v.safeParse(PublicUrlSchema, "https://example.org/").success).toBe(
      true,
    );
  });
  it("normalizes domestic, international, full-width, and compatibility-hyphen telephone numbers", () => {
    for (const number of [
      "03-3581-2331",
      "+81 3 3581 2331",
      "０３－３５８１－２３３１",
      "03‐3581‐2331",
      "(03) 3581 2331",
    ])
      expect(normalizePhone(number)).toEqual({
        ok: true,
        value: "+81335812331",
      });
    for (const number of [
      "03-35",
      "+1 202 555 1234",
      "not a phone",
      "0000000000",
    ])
      expect(normalizePhone(number).ok).toBe(false);
  });
  it("round-trips cursors and refuses malformed byte encodings", () => {
    const cursor = {
      snapshot: "a".repeat(64),
      query: "b".repeat(64),
      rank: 1,
      name: "図書館🏛",
      id: "fixture:1",
    } as const;
    expect(decodeCursor(encodeCursor(cursor))).toEqual({
      ok: true,
      value: cursor,
    });
    for (const value of ["!", "e30", "____", "bnVsbA"])
      expect(decodeCursor(value).ok).toBe(false);
  });
  it("keeps admitted cursor representations within the request limit", () => {
    for (const name of ['"'.repeat(384), "\0".repeat(384), "あ".repeat(128)]) {
      const cursor = {
        snapshot: "a".repeat(64),
        query: "b".repeat(64),
        rank: 2,
        name,
        id: "a".repeat(256),
      } as const;
      const encoded = encodeCursor(cursor);
      expect(encoded.length).toBeLessThanOrEqual(4096);
      expect(decodeCursor(encoded)).toEqual({ ok: true, value: cursor });
    }
  });
  it("folds vCard lines at 75 UTF-8 bytes without splitting a codepoint", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (input: string) => {
        const safe = input.replaceAll("\r", "").replaceAll("\n", "");
        const folded = foldVCardLine(safe);
        expect(folded.replaceAll("\r\n ", "")).toBe(safe);
        for (const line of folded.split("\r\n"))
          expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      }),
      { seed: 78455, numRuns: 300 },
    );
    const card = contactVCard(fixture);
    expect(card).toContain("FN:施設\\;名前\\,改行\\n");
    expect(card).toContain("TEL;TYPE=WORK,VOICE:+81335812331\r\n");
    expect(card.split("BEGIN:VCARD")).toHaveLength(2);
    expect(escapeVCard("\\,;\r\n")).toBe("\\\\\\,\\;\\n");
  });
  it("escapes CSV cells and guards spreadsheet formulas", () => {
    const rows = csvRows(contactCsv(fixture));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[csvColumn("name")]).toBe(fixture.name);
    expect(rows[0]?.[csvColumn("address")]).toBe(fixture.address);
    expect(rows[0]?.[csvColumn("phone_numbers")]).toBe("+81335812331");
    expect(
      contactCsv({ ...fixture, name: '=HYPERLINK("https://example.org")' }),
    ).toContain('"\'=HYPERLINK(""https://example.org"")"');
    expect(contactCsv(fixture)).toContain('"施設;名前,改行\n""例"""');
  });
  it("preserves empty fields and quotes every spreadsheet formula prefix through the CSV writer", () => {
    for (const prefix of spreadsheetFormulaPrefixes) {
      const name = `${prefix}式,"引用"\r\n次の行`;
      const rows = csvRows(
        contactCsv({ ...fixture, name, website: null, municipalityCode: null }),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[csvColumn("name")]).toBe(`'${name}`);
      expect(rows[0]?.[csvColumn("municipality_code")]).toBe("");
      expect(rows[0]?.[csvColumn("website")]).toBe("");
    }
  });
  it("guards every free-text CSV column and writes telephone numbers verbatim", () => {
    for (const prefix of spreadsheetFormulaPrefixes) {
      const text = `${prefix}cmd|' /C calc'!A0`;
      const rows = csvRows(
        contactCsv({
          ...fixture,
          id: text,
          name: text,
          address: text,
          website: text,
          sourceId: text,
          sourceUrls: [text],
          license: text,
          licenseUrl: text,
          dataAsOf: text,
          phones: [
            { display: "03-3581-2331", e164: "+81335812331" },
            { display: "090-1234-5678", e164: "+819012345678" },
          ],
        }),
      );
      for (const column of [
        "id",
        "name",
        "address",
        "website",
        "source_id",
        "source_url",
        "license",
        "license_url",
        "data_as_of",
      ] as const)
        expect(rows[0]?.[csvColumn(column)], column).toBe(`'${text}`);
      expect(rows[0]?.[csvColumn("phone_numbers")]).toBe(
        "+81335812331;+819012345678",
      );
    }
  });
  it("matches the serializer's formula escaping for every free-text cell", () => {
    const options = {
      quoted: true,
      quoted_empty: true,
      record_delimiter: "\r\n",
    } as const;
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: "binary" }),
          fc
            .tuple(
              fc.constantFrom(...spreadsheetFormulaPrefixes, "'", "a", "あ"),
              fc.string({ unit: "binary" }),
            )
            .map(([prefix, rest]) => `${prefix}${rest}`),
        ),
        (text: string) => {
          expect(stringify([[guardSpreadsheetFormula(text)]], options)).toBe(
            stringify([[text]], { ...options, escape_formulas: true }),
          );
        },
      ),
      { seed: 29, numRuns: 2000 },
    );
  });
  it("admits only E.164 numbers into the verbatim telephone cell", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^\+81[1-9][0-9]{8,9}$/), {
          minLength: 1,
          maxLength: 4,
        }),
        (numbers: string[]) => {
          const cell = v.parse(FormulaInertTelephonesSchema, numbers);
          expect(cell).toMatch(/^[+0-9;]+$/u);
          expect(cell.split(";")).toEqual(numbers);
        },
      ),
      { seed: 29, numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "binary" }), { maxLength: 3 }),
        (values: string[]) => {
          const parsed = v.safeParse(FormulaInertTelephonesSchema, values);
          if (parsed.success) expect(parsed.output).toMatch(/^[+0-9;]+$/u);
        },
      ),
      { seed: 29, numRuns: 1000 },
    );
    for (const value of [
      [],
      ["=1+1"],
      ["+81335812331", '=HYPERLINK("https://example.org")'],
      ["+81 3 3581 2331"],
      ["+8133581233a"],
      ["+81335812331;+81335812331"],
      ["+1202555123"],
    ])
      expect(v.safeParse(FormulaInertTelephonesSchema, value).success).toBe(
        false,
      );
    expect(() =>
      contactCsv({
        ...fixture,
        phones: [{ display: "=cmd|' /C calc'!A0", e164: "=cmd|' /C calc'!A0" }],
      }),
    ).toThrow();
  });
  it("represents absent websites and multiple source pages explicitly", () => {
    const contact = importContact({
      id: "fixture:1",
      source_record_id: "1",
      prefecture_code: "13",
      prefecture: "東京都",
      municipality_code: "13101",
      category: "library",
      name: "施設",
      address: "東京都",
      phones: [{ original: "03-3581-2331", e164: "+81335812331" }],
      official_url: "",
      source_id: "fixture",
      source_url: "https://example.org/a, https://example.org/b",
      license: "CC0-1.0",
      license_url: "https://creativecommons.org/publicdomain/zero/1.0/",
      data_as_of: "2026-10-01",
      retrieved_at: "2026-10-29T00:00:00Z",
      official_phone_observed: false,
    });
    expect(contact.website).toBeNull();
    expect(contact.sourceUrls).toEqual([
      "https://example.org/a",
      "https://example.org/b",
    ]);
  });
});
