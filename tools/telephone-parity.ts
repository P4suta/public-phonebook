import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import * as v from "valibot";
import { escapeVCard } from "../src/core/vcard.ts";
import { contactCsvColumns, guardSpreadsheetFormula } from "./snapshot.ts";

/** `retained` also admits an earlier publication, whose CSV writer guarded the telephone cell as a formula. */
export type ArchiveForms = "canonical" | "retained";

interface ArchiveTelephones {
  readonly id: string;
  readonly telephones: readonly string[];
}

interface CsvTelephones {
  readonly id: string;
  readonly cell: string;
}

const JsonlTelephonesSchema = v.object({
  id: v.string(),
  phones: v.array(v.object({ e164: v.string() })),
});
const CsvRecordSchema = v.array(v.string());
const csvIdColumn = contactCsvColumns.indexOf("id");
const csvTelephoneColumn = contactCsvColumns.indexOf("phone_numbers");
const csvTelephoneSeparator = ";";
const lineBreak = /\r?\n/u;
const vcardContinuation = " ";
const vcardIdentity = "UID:";
const vcardTelephone = /^TEL[;:]/u;
const vcardValueSeparator = ":";

/** Splits UTF-8 at LF or CRLF only, since the JSONL and vCard writers escape line breaks inside a value. */
export async function* utf8Lines(
  chunks: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array))
      throw new Error("The archive did not yield bytes");
    const lines = `${pending}${decoder.decode(chunk, { stream: true })}`.split(
      lineBreak,
    );
    pending = lines.pop() ?? "";
    yield* lines;
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

function gunzippedLines(path: string): AsyncGenerator<string> {
  return utf8Lines(createReadStream(path).compose(createGunzip()));
}

async function* jsonlTelephones(
  path: string,
): AsyncGenerator<ArchiveTelephones> {
  for await (const line of gunzippedLines(path)) {
    const value: unknown = JSON.parse(line);
    const contact = v.parse(JsonlTelephonesSchema, value);
    yield {
      id: contact.id,
      telephones: contact.phones.map((phone) => phone.e164),
    };
  }
}

async function* csvTelephones(path: string): AsyncGenerator<CsvTelephones> {
  let header = true;
  for await (const record of createReadStream(path)
    .compose(createGunzip())
    .compose(parse())) {
    const cells = v.parse(CsvRecordSchema, record);
    if (header) {
      if (
        cells.length !== contactCsvColumns.length ||
        cells.some((cell, index) => cell !== contactCsvColumns[index])
      )
        throw new Error("The CSV archive has another header");
      header = false;
      continue;
    }
    const id = cells[csvIdColumn];
    const cell = cells[csvTelephoneColumn];
    if (id === undefined || cell === undefined)
      throw new Error("The CSV archive has a short record");
    yield { id, cell };
  }
  if (header) throw new Error("The CSV archive has no header");
}

async function* unfoldedLines(path: string): AsyncGenerator<string> {
  let current: string | null = null;
  for await (const line of gunzippedLines(path)) {
    if (current !== null && line.startsWith(vcardContinuation)) {
      current += line.slice(vcardContinuation.length);
      continue;
    }
    if (current !== null) yield current;
    current = line;
  }
  if (current !== null) yield current;
}

async function* vcardTelephones(
  path: string,
): AsyncGenerator<ArchiveTelephones> {
  let card: { id: string; telephones: string[] } | null = null;
  for await (const line of unfoldedLines(path)) {
    if (line === "BEGIN:VCARD") {
      if (card) throw new Error("The vCard archive nests a card");
      card = { id: "", telephones: [] };
    } else if (line === "END:VCARD") {
      if (!card)
        throw new Error("The vCard archive ends a card it never began");
      yield card;
      card = null;
    } else if (card && line.startsWith(vcardIdentity))
      card.id = line.slice(vcardIdentity.length);
    else if (card && vcardTelephone.test(line))
      card.telephones.push(
        line.slice(
          line.indexOf(vcardValueSeparator) + vcardValueSeparator.length,
        ),
      );
  }
  if (card) throw new Error("The vCard archive ends inside a card");
}

function csvMatches(
  row: CsvTelephones,
  contact: ArchiveTelephones,
  forms: ArchiveForms,
): boolean {
  const cell = contact.telephones.join(csvTelephoneSeparator);
  return (
    row.id === guardSpreadsheetFormula(contact.id) &&
    (row.cell === cell ||
      (forms === "retained" && row.cell === guardSpreadsheetFormula(cell)))
  );
}

function vcardMatches(
  card: ArchiveTelephones,
  contact: ArchiveTelephones,
): boolean {
  return (
    card.id === escapeVCard(contact.id) &&
    card.telephones.length === contact.telephones.length &&
    card.telephones.every(
      (telephone, index) => telephone === contact.telephones[index],
    )
  );
}

/** Requires the CSV and vCard archives to carry the telephone numbers of every JSONL contact, in the same order. */
export async function checkTelephoneParity(
  directory: string,
  forms: ArchiveForms,
): Promise<number> {
  const csv = csvTelephones(join(directory, "contacts.csv.gz"));
  const vcard = vcardTelephones(join(directory, "contacts.vcf.gz"));
  let contacts = 0;
  try {
    for await (const contact of jsonlTelephones(
      join(directory, "contacts.jsonl.gz"),
    )) {
      const row = await csv.next();
      if (row.done)
        throw new Error(
          `The CSV archive lacks a contact from the JSONL archive: ${contact.id}`,
        );
      if (!csvMatches(row.value, contact, forms))
        throw new Error(
          `CSV telephone numbers differ from the JSONL archive: ${contact.id}`,
        );
      const card = await vcard.next();
      if (card.done)
        throw new Error(
          `The vCard archive lacks a contact from the JSONL archive: ${contact.id}`,
        );
      if (!vcardMatches(card.value, contact))
        throw new Error(
          `vCard telephone numbers differ from the JSONL archive: ${contact.id}`,
        );
      contacts += 1;
    }
    if (!(await csv.next()).done)
      throw new Error(
        "The CSV archive holds contacts that the JSONL archive lacks",
      );
    if (!(await vcard.next()).done)
      throw new Error(
        "The vCard archive holds contacts that the JSONL archive lacks",
      );
    return contacts;
  } finally {
    await csv.return(undefined);
    await vcard.return(undefined);
  }
}
