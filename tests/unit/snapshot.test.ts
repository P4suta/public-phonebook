import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";
import { expect, it } from "vitest";
import {
  CatalogSchema,
  ContactSchema,
  SourceSchema,
} from "../../src/core/models.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
import { prepareSnapshot } from "../../tools/snapshot.ts";

it("prepares canonical native data with normalized addresses and complete archive accounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-snapshot-"));
  const path = join(root, "input.sqlite");
  const db = new DatabaseSync(path);
  const contact = v.parse(ContactSchema, {
    id: "school:example",
    name: "例小学校",
    category: "elementary_school",
    prefectureCode: "13",
    municipalityCode: "13101",
    address: "〒１００－０００１ 東京都千代田区一丁目２番３号（案内図）",
    phones: [{ display: "03-3581-2331", e164: "+81335812331" }],
    website: null,
    sourceId: "source",
    sourceRecordId: "1",
    sourceUrls: ["https://example.go.jp/"],
    license: "CC0",
    licenseUrl: "https://example.go.jp/terms",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-30T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  });
  const source = v.parse(SourceSchema, {
    id: "source",
    url: "https://example.go.jp/data.csv",
    sha256: "a".repeat(64),
    dataAsOf: "2026-10-01",
    retrievedAt: contact.retrievedAt,
    indexUrl: null,
    indexSha256: null,
    licenseUrl: null,
    licenseSha256: null,
    artifacts: [],
    rows: 1,
    accepted: 1,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
  });
  const catalog = v.parse(CatalogSchema, {
    snapshot: "b".repeat(64),
    generatedAt: contact.retrievedAt,
    contacts: 1,
    phones: 1,
    sourceCount: 1,
    categories: [
      {
        id: "elementary_school",
        label: "小学校",
        contacts: 1,
        publisher: "例市",
        license: "CC0",
        licenseUrl: contact.licenseUrl,
      },
    ],
    prefectures: [{ code: "13", name: "東京都", contacts: 1 }],
    municipalities: [{ code: "13101", prefectureCode: "13", name: "千代田区" }],
  });
  try {
    db.exec(databaseSchema);
    db.prepare("INSERT INTO contacts VALUES (1,?,?,?,?,?,?,?,?)").run(
      contact.id,
      contact.name,
      contact.name,
      contact.prefectureCode,
      contact.municipalityCode,
      contact.category,
      contact.sourceId,
      JSON.stringify(contact),
    );
    db.prepare("INSERT INTO sources VALUES (?,?)").run(
      source.id,
      JSON.stringify(source),
    );
    db.prepare("INSERT INTO metadata VALUES ('catalog',?)").run(
      JSON.stringify(catalog),
    );
    db.close();
    const output = join(root, "bundle");
    await prepareSnapshot(path, output);
    const prepared: unknown = JSON.parse(
      await readFile(join(output, "catalog.json"), "utf8"),
    );
    const checked = v.parse(CatalogSchema, prepared);
    expect(checked.contacts).toBe(1);
    expect(checked.phones).toBe(1);
    expect(checked.categories.map((category) => category.id)).toEqual([
      "elementary_school",
    ]);
    expect(checked.municipalities).toEqual(catalog.municipalities);
    const jsonl = gunzipSync(
      await readFile(join(output, "contacts.jsonl.gz")),
    ).toString("utf8");
    expect(JSON.parse(jsonl)).toMatchObject({
      id: contact.id,
      address: "東京都千代田区1-2-3",
    });
    expect(
      gunzipSync(await readFile(join(output, "contacts.csv.gz"))).toString(
        "utf8",
      ),
    ).toContain("東京都千代田区1-2-3");
    expect(
      gunzipSync(await readFile(join(output, "contacts.vcf.gz"))).toString(
        "utf8",
      ),
    ).toContain("東京都千代田区1-2-3");
  } finally {
    if (db.isOpen) db.close();
    await rm(root, { recursive: true, force: true });
  }
});
