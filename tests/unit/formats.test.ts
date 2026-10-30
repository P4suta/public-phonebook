import { parse } from "csv-parse/sync";
import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  type Contact,
  ContactSchema,
  PublicUrlSchema,
} from "../../src/core/models.ts";
import { normalizePhone } from "../../src/core/phone.ts";
import { decodeCursor, encodeCursor } from "../../src/core/search.ts";
import {
  contactVCard,
  escapeVCard,
  foldVCardLine,
} from "../../src/core/vcard.ts";
import { importContact } from "../../tools/import-contact.ts";
import { contactCsv } from "../../tools/snapshot.ts";

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
    const decoded: unknown = parse(contactCsv(fixture));
    const rows = v.parse(v.array(v.array(v.string())), decoded);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[1]).toBe(fixture.name);
    expect(rows[0]?.[5]).toBe(fixture.address);
    expect(rows[0]?.[6]).toBe("'+81335812331");
    expect(
      contactCsv({ ...fixture, name: '=HYPERLINK("https://example.org")' }),
    ).toContain('"\'=HYPERLINK(""https://example.org"")"');
    expect(contactCsv(fixture)).toContain('"施設;名前,改行\n""例"""');
  });
  it("preserves empty fields and quotes every spreadsheet formula prefix through the CSV writer", () => {
    for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
      const name = `${prefix}式,"引用"\r\n次の行`;
      const decoded: unknown = parse(
        contactCsv({ ...fixture, name, website: null, municipalityCode: null }),
      );
      const rows = v.parse(v.array(v.array(v.string())), decoded);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.[1]).toBe(`'${name}`);
      expect(rows[0]?.[4]).toBe("");
      expect(rows[0]?.[7]).toBe("");
    }
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
