import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { afterEach, expect, it } from "vitest";
import { ContactSchema } from "../../src/core/models.ts";
import {
  mergeContacts,
  readCollectionOverlay,
} from "../../tools/collection/overlay.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function contact(id: string): v.InferOutput<typeof ContactSchema> {
  return v.parse(ContactSchema, {
    id,
    name: "例小学校",
    category: "elementary_school",
    prefectureCode: "13",
    municipalityCode: null,
    address: "東京都千代田区一丁目２番３号",
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
}

it("merges disjoint sorted streams without replacing published identities", () => {
  expect(
    [
      ...mergeContacts(
        [contact("b"), contact("d")],
        [contact("a"), contact("c"), contact("e")],
      ),
    ].map((item) => item.id),
  ).toEqual(["a", "b", "c", "d", "e"]);
  expect(() => [...mergeContacts([contact("a")], [contact("a")])]).toThrow(
    "overwrites",
  );
});

it("refuses incomplete or inconsistent collection artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "phonebook-overlay-"));
  roots.push(root);
  await writeFile(
    join(root, "collection-report.json"),
    JSON.stringify({ complete: false, contacts: 1, failures: [] }),
  );
  await expect(readCollectionOverlay(root)).rejects.toThrow();
  await writeFile(
    join(root, "collection-report.json"),
    JSON.stringify({ complete: true, contacts: 1, failures: [] }),
  );
  await writeFile(join(root, "sources.json"), "[]");
  await writeFile(
    join(root, "contacts.jsonl"),
    JSON.stringify(contact("a")) + "\n",
  );
  await expect(readCollectionOverlay(root)).rejects.toThrow(
    "Missing collection source",
  );
});
