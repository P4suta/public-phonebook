import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Contact, ContactSchema } from "../../src/core/models.ts";
import { contactVCard } from "../../src/core/vcard.ts";
import { contactCsv, contactCsvHeader } from "../../tools/snapshot.ts";
import {
  checkTelephoneParity,
  utf8Lines,
} from "../../tools/telephone-parity.ts";

const foldedIdentifier = `fixture:${"a".repeat(120)}`;

function fixtureContact(
  id: string,
  phones: readonly [string, string][],
): Contact {
  return v.parse(ContactSchema, {
    id,
    name: "=国立国会図書館",
    category: "library",
    prefectureCode: "13",
    municipalityCode: "13101",
    address: "東京都千代田区永田町1-10-1",
    phones: phones.map(([display, e164]) => ({ display, e164 })),
    website: null,
    sourceId: "fixture",
    sourceRecordId: id,
    sourceUrls: ["https://example.org/dataset"],
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-29T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  });
}

const contacts = [
  fixtureContact("-fixture:0", [["03-3581-2331", "+81335812331"]]),
  fixtureContact("fixture:1", [
    ["03-3827-2053", "+81338272053"],
    ["090-1234-5678", "+819012345678"],
  ]),
  fixtureContact(foldedIdentifier, [["0774-98-1200", "+81774981200"]]),
];
const contactsJsonl = (list: readonly Contact[]): string =>
  list.map((contact) => `${JSON.stringify(contact)}\n`).join("");
const contactsCsv = (list: readonly Contact[]): string =>
  `${contactCsvHeader}${list.map(contactCsv).join("")}`;
const contactsVCard = (list: readonly Contact[]): string =>
  list.map(contactVCard).join("");
const jsonl = contactsJsonl(contacts);
const csv = contactsCsv(contacts);
const vcard = contactsVCard(contacts);

/** Enough contacts that the stream stages still hold unread records when the check stops. */
const streamedContactCount = 64;
const subscriberDigits = 4;
const truncatedArchiveFraction = 0.5;

function streamedContact(index: number, subscriber = index): Contact {
  const digits = String(subscriber).padStart(subscriberDigits, "0");
  return fixtureContact(`fixture:stream:${index}`, [
    [`03-3581-${digits}`, `+8133581${digits}`],
  ]);
}

const streamedContacts = Array.from(
  { length: streamedContactCount },
  (_, index) => streamedContact(index),
);

async function* chunked(
  bytes: Uint8Array,
  boundaries: readonly number[],
): AsyncGenerator<Uint8Array> {
  let start = 0;
  for (const end of [...boundaries, bytes.byteLength]) {
    yield bytes.subarray(start, end);
    start = end;
  }
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const collected: string[] = [];
  for await (const line of lines) collected.push(line);
  return collected;
}

describe("archive line decoding", () => {
  it("splits LF and CRLF lines at every chunk boundary, including inside a code point", async () => {
    const text = 'UID:図書館🏛\r\n FN:例\r\nTEL:+81335812331\n{"a":1}';
    const expected = ["UID:図書館🏛", " FN:例", "TEL:+81335812331", '{"a":1}'];
    const bytes = new TextEncoder().encode(text);
    for (let boundary = 0; boundary <= bytes.byteLength; boundary += 1)
      expect(await collect(utf8Lines(chunked(bytes, [boundary])))).toEqual(
        expected,
      );
    expect(
      await collect(
        utf8Lines(
          chunked(
            bytes,
            Array.from({ length: bytes.byteLength }, (_, index) => index),
          ),
        ),
      ),
    ).toEqual(expected);
    expect(
      await collect(
        utf8Lines(chunked(new TextEncoder().encode(`${text}\r\n`), [])),
      ),
    ).toEqual(expected);
  });
  it("rejects malformed UTF-8 and non-byte chunks", async () => {
    await expect(
      collect(utf8Lines(chunked(new Uint8Array([0x41, 0xe3, 0x81]), []))),
    ).rejects.toThrow();
    async function* text(): AsyncGenerator<string> {
      yield "text";
    }
    await expect(collect(utf8Lines(text()))).rejects.toThrow(
      "The archive did not yield bytes",
    );
  });
});

describe("telephone parity across the downloadable archives", () => {
  let directory = "";

  async function writeArchives(archives: {
    readonly jsonl?: string;
    readonly csv?: string;
    readonly vcard?: string;
  }): Promise<void> {
    await writeFile(
      join(directory, "contacts.jsonl.gz"),
      gzipSync(archives.jsonl ?? jsonl),
    );
    await writeFile(
      join(directory, "contacts.csv.gz"),
      gzipSync(archives.csv ?? csv),
    );
    await writeFile(
      join(directory, "contacts.vcf.gz"),
      gzipSync(archives.vcard ?? vcard),
    );
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "phonebook-telephones-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("accepts the archives the writers produce, including folded vCard identities", async () => {
    expect(vcard).toContain("\r\n ");
    expect(csv).toContain('"+81338272053;+819012345678"');
    await writeArchives({});
    await expect(checkTelephoneParity(directory, "canonical")).resolves.toBe(
      contacts.length,
    );
    await expect(checkTelephoneParity(directory, "retained")).resolves.toBe(
      contacts.length,
    );
  });

  it("rejects formula-guarded telephone cells unless the bundle retains an earlier publication", async () => {
    const guarded = csv.replaceAll('"+81', "\"'+81");
    expect(guarded).not.toBe(csv);
    await writeArchives({ csv: guarded });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "CSV telephone numbers differ from the JSONL archive: -fixture:0",
    );
    await expect(checkTelephoneParity(directory, "retained")).resolves.toBe(
      contacts.length,
    );
  });

  it("names the first contact whose CSV or vCard numbers differ", async () => {
    await writeArchives({
      csv: csv.replace("+819012345678", "+819012345679"),
    });
    await expect(checkTelephoneParity(directory, "retained")).rejects.toThrow(
      "CSV telephone numbers differ from the JSONL archive: fixture:1",
    );
    await writeArchives({
      vcard: vcard.replace("TEL;TYPE=WORK,VOICE:+819012345678\r\n", ""),
    });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "vCard telephone numbers differ from the JSONL archive: fixture:1",
    );
    await writeArchives({
      vcard: vcard.replace("UID:fixture:1", "UID:fixture:9"),
    });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "vCard telephone numbers differ from the JSONL archive: fixture:1",
    );
  });

  it("rejects archives that hold another contact sequence", async () => {
    const [first = "", second = "", third = ""] = contacts.map(contactCsv);
    await writeArchives({
      csv: `${contactCsvHeader}${second}${first}${third}`,
    });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "CSV telephone numbers differ from the JSONL archive: -fixture:0",
    );
    await writeArchives({ csv: `${csv}${third}` });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "The CSV archive holds contacts that the JSONL archive lacks",
    );
    await writeArchives({
      vcard: contacts.slice(0, -1).map(contactVCard).join(""),
    });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      `The vCard archive lacks a contact from the JSONL archive: ${foldedIdentifier}`,
    );
    await writeArchives({ csv: csv.replace("phone_numbers", "telephones") });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "The CSV archive has another header",
    );
    await writeArchives({ vcard: vcard.slice(0, vcard.lastIndexOf("END:")) });
    await expect(checkTelephoneParity(directory, "canonical")).rejects.toThrow(
      "The vCard archive ends inside a card",
    );
  });

  describe("when the check stops before the archives end", () => {
    const escaped: unknown[] = [];
    const recordEscape = (error: unknown): void => {
      escaped.push(error);
    };

    beforeEach(() => {
      escaped.length = 0;
      process.on("uncaughtException", recordEscape);
      process.on("unhandledRejection", recordEscape);
    });
    afterEach(() => {
      process.off("uncaughtException", recordEscape);
      process.off("unhandledRejection", recordEscape);
    });

    /** Every archive stage has closed once the check settles, so only Node's rejection tracking, which reports before the next macrotask, can still record an escape. */
    async function expectOnlyRejection(message: string): Promise<void> {
      await expect(
        checkTelephoneParity(directory, "canonical"),
      ).rejects.toThrow(message);
      await new Promise((resolve) => setImmediate(resolve));
      expect(escaped).toEqual([]);
    }

    it("reports a mismatch at any contact without a stream error escaping", async () => {
      for (let index = 0; index < streamedContactCount; index += 1) {
        const differing = streamedContacts.with(
          index,
          streamedContact(index, streamedContactCount + index),
        );
        await writeArchives({
          jsonl: contactsJsonl(streamedContacts),
          csv: contactsCsv(differing),
          vcard: contactsVCard(streamedContacts),
        });
        await expectOnlyRejection(
          `CSV telephone numbers differ from the JSONL archive: fixture:stream:${index}`,
        );
        await writeArchives({
          jsonl: contactsJsonl(streamedContacts),
          csv: contactsCsv(streamedContacts),
          vcard: contactsVCard(differing),
        });
        await expectOnlyRejection(
          `vCard telephone numbers differ from the JSONL archive: fixture:stream:${index}`,
        );
      }
    });

    it("reports a truncated archive without a stream error escaping", async () => {
      for (const [file, text] of [
        ["contacts.jsonl.gz", contactsJsonl(streamedContacts)],
        ["contacts.csv.gz", contactsCsv(streamedContacts)],
        ["contacts.vcf.gz", contactsVCard(streamedContacts)],
      ] as const) {
        await writeArchives({
          jsonl: contactsJsonl(streamedContacts),
          csv: contactsCsv(streamedContacts),
          vcard: contactsVCard(streamedContacts),
        });
        const archive = gzipSync(text);
        await writeFile(
          join(directory, file),
          archive.subarray(
            0,
            Math.floor(archive.byteLength * truncatedArchiveFraction),
          ),
        );
        await expectOnlyRejection("unexpected end of file");
      }
    });
  });
});
