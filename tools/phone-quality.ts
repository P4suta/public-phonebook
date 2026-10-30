import { readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import * as v from "valibot";
import { DatasetManifestSchema } from "../src/core/models.ts";
import { formatPhone, normalizePhone } from "../src/core/phone.ts";
import { fileDigest } from "./snapshot.ts";

const commandArgumentOffset = 2;
const exampleLimit = 3;
const hexadecimalRadix = 16;
const jsonIndentation = 2;

type Example = {
  readonly id: string;
  readonly sourceId: string;
  readonly display: string;
  readonly e164: string;
};

const QualityContactSchema = v.object({
  id: v.string(),
  sourceId: v.string(),
  phones: v.array(v.object({ display: v.string(), e164: v.string() })),
});

async function main(): Promise<void> {
  const [directory, output, ...extra] = process.argv.slice(
    commandArgumentOffset,
  );
  if (!directory || !output || extra.length)
    throw new Error(
      "Usage: node tools/phone-quality.ts BUNDLE_DIRECTORY REPORT_FILE",
    );
  const manifest: unknown = JSON.parse(
    await readFile(`${directory}/manifest.ready.json`, "utf8"),
  );
  const bundle = v.parse(DatasetManifestSchema, manifest);
  const snapshot = bundle.snapshot;
  const databaseSha256 = await fileDigest(`${directory}/directory.sqlite`);
  if (databaseSha256 !== bundle.databaseSha256)
    throw new Error("Phone audit database checksum mismatch");
  const db = new DatabaseSync(`${directory}/directory.sqlite`, {
    readOnly: true,
  });
  const metrics = new Map<string, { count: number; examples: Example[] }>();
  for (const key of [
    "unparseableDisplay",
    "canonicalMismatch",
    "formattedRoundtripMismatch",
    "duplicatesWithinContact",
  ])
    metrics.set(key, { count: 0, examples: [] });
  const distinct = new Set<string>();
  const review: Example[] = [];
  const nonAsciiCharacters = new Map<string, number>();
  let contacts = 0;
  let relations = 0;
  function count(key: string, example: Example): void {
    const metric = metrics.get(key) ?? { count: 0, examples: [] };
    metric.count += 1;
    if (metric.examples.length < exampleLimit) metric.examples.push(example);
    metrics.set(key, metric);
  }
  try {
    for (const row of db
      .prepare("SELECT payload FROM contacts ORDER BY id")
      .iterate()) {
      const value: unknown = JSON.parse(v.parse(v.string(), row.payload));
      const contact = v.parse(QualityContactSchema, value);
      contacts += 1;
      const seen = new Set<string>();
      for (const phone of contact.phones) {
        relations += 1;
        distinct.add(phone.e164);
        for (const character of phone.display) {
          if (/[^\x20-\x7e]/u.test(character)) {
            const key = `U+${character.codePointAt(0)?.toString(hexadecimalRadix).toUpperCase()} ${character}`;
            nonAsciiCharacters.set(key, (nonAsciiCharacters.get(key) ?? 0) + 1);
          }
        }
        const example: Example = {
          id: contact.id,
          sourceId: contact.sourceId,
          ...phone,
        };
        const normalized = normalizePhone(phone.display);
        const display = formatPhone(phone.e164);
        const roundtrip = normalizePhone(display);
        const metadata = parsePhoneNumberFromString(phone.e164, {
          extract: false,
        });
        if (display !== phone.display) count("displayNeedsFormatting", example);
        if (!roundtrip.ok || roundtrip.value !== phone.e164)
          count("formattedRoundtripMismatch", example);
        if (!metadata?.isValid()) {
          count("notRecognizedByMetadata", example);
          review.push(example);
        }
        if (phone.display.normalize("NFKC") !== phone.display)
          count("compatibilityCharacters", example);
        if (/[^\x20-\x7e]/u.test(phone.display)) count("nonAscii", example);
        if (/^0[0-9]+$/u.test(phone.display)) count("unseparated", example);
        if (/^\+/u.test(phone.display.trim())) count("international", example);
        if (/FAX|内線|ext|[,;\n\r/]/iu.test(phone.display))
          count("labelsOrMultipleNumbers", example);
        if (!normalized.ok) count("unparseableDisplay", example);
        else if (normalized.value !== phone.e164)
          count("canonicalMismatch", example);
        if (seen.has(phone.e164)) count("duplicatesWithinContact", example);
        seen.add(phone.e164);
      }
    }
  } finally {
    db.close();
  }
  const report = {
    snapshot,
    databaseSha256,
    contacts,
    relations,
    distinctNumbers: distinct.size,
    nonAsciiCharacters: Object.fromEntries(nonAsciiCharacters),
    metrics: Object.fromEntries(metrics),
    metadataReview: review,
  };
  if (contacts !== bundle.contacts || distinct.size !== bundle.phones)
    throw new Error("Phone audit accounting mismatch");
  await writeFile(output, `${JSON.stringify(report, null, jsonIndentation)}\n`);
  console.info(
    JSON.stringify({
      operation: "data.phones",
      snapshot,
      contacts,
      relations,
      distinctNumbers: distinct.size,
      metrics: Object.fromEntries(
        Array.from(metrics, ([key, metric]) => [key, metric.count]),
      ),
    }),
  );
  if (
    [
      "unparseableDisplay",
      "canonicalMismatch",
      "formattedRoundtripMismatch",
      "duplicatesWithinContact",
    ].some((key) => (metrics.get(key)?.count ?? 0) > 0)
  )
    throw new Error("The phone audit found inconsistent telephone identities");
}

await main();
