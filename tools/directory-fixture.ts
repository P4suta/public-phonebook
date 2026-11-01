import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import * as v from "valibot";
import { DirectoryDiscoverySchema } from "../src/core/api-contract.ts";
import { categoryDefinitions, prefectureNames } from "../src/core/catalog.ts";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import {
  type DirectoryArchiveSource,
  directoryArchiveEncoder,
  directoryArchiveFile,
  encodeDirectoryArchive,
} from "../src/core/directory-archive.ts";
import {
  type Catalog,
  CatalogSchema,
  ContactSchema,
  SourceSchema,
} from "../src/core/models.ts";
import { nameTokens, normalizeName } from "../src/core/search.ts";
import {
  encodeSearchIndex,
  searchIndexFile,
  searchIndexRow,
} from "../src/core/search-index.ts";
import { contactVCard } from "../src/core/vcard.ts";
import { api, type DirectoryApiBindings } from "../src/server/api.ts";
import { databaseSchema } from "./database-schema.ts";
import { compressSearchIndex } from "./search-index.ts";
import { compressDirectoryArchive, contactRowNumbers } from "./snapshot.ts";

export const contractOrigin = "https://contract.example";
export const fixturePort = 3100;
// RFC 1952 stores the compressing operating system in byte 9 of the gzip header.
const gzipOperatingSystemOffset = 9;
const gzipUnknownOperatingSystem = 0xff;

/** Compresses with gzip and clears the host-dependent header byte so every platform writes the same corpus. */
function portableGzip(data: string): Uint8Array {
  const bytes = gzipSync(data);
  bytes[gzipOperatingSystemOffset] = gzipUnknownOperatingSystem;
  return bytes;
}
const fixtureOrigin = `http://localhost:${fixturePort}`;
const fixtureCategories = ["medical", "dental", "library"] as const;
const prefectureCodeDigits = 2;
const indexedLibraryCount = 100;
const indexedLibraryDigits = 3;
const fixturePhoneCount = 2;
const sha256HexLength = 64;
const officialSiteUrl = "https://example.com/official";
const contactSourceUrls = [
  "https://example.com/source",
  "https://example.com/second-source",
];
const contactLicenseUrl = "https://creativecommons.org/publicdomain/zero/1.0/";
const categoryLicenseUrl = "https://example.com/license";
const sourceArtifactUrl = "https://example.com/providers.xlsx";
const sourceIndexUrl = "https://example.com/provider-list";

function prefectureCode(index: number): string {
  return String(index + 1).padStart(prefectureCodeDigits, "0");
}

interface RealDirectory {
  readonly catalog: Catalog;
  readonly archive: Uint8Array;
}

async function readRealDirectory(
  snapshot: string,
): Promise<RealDirectory | null> {
  const contactsPath = process.env.PHONEBOOK_FIXTURE_CONTACTS;
  const catalogPath = process.env.PHONEBOOK_FIXTURE_CATALOG;
  if (!contactsPath && !catalogPath) return null;
  if (!contactsPath || !catalogPath)
    throw new Error(
      "Set both PHONEBOOK_FIXTURE_CONTACTS and PHONEBOOK_FIXTURE_CATALOG",
    );
  const decoded: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
  const catalog = { ...v.parse(CatalogSchema, decoded), snapshot };
  const file = createReadStream(contactsPath);
  const lines = createInterface({
    input: contactsPath.endsWith(".gz") ? file.compose(createGunzip()) : file,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const encoder = directoryArchiveEncoder();
  const sources = new Map<string, DirectoryArchiveSource>();
  let contacts = 0;
  for await (const line of lines) {
    if (!line) continue;
    const value: unknown = JSON.parse(line);
    const contact = v.parse(ContactSchema, value);
    const [url] = contact.sourceUrls;
    if (url && !sources.has(contact.sourceId))
      sources.set(contact.sourceId, { id: contact.sourceId, url });
    encoder.add(contact);
    contacts += 1;
  }
  if (contacts !== catalog.contacts)
    throw new Error("The real fixture contacts differ from their catalog");
  return {
    catalog,
    archive: compressDirectoryArchive(
      encoder.finish({ snapshot, catalog, sources: [...sources.values()] }),
    ),
  };
}

export async function directoryFixture(
  options: { readonly revision: "baseline" | "updated" } = {
    revision: "baseline",
  },
): Promise<{
  readonly fetch: (request: Request) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}> {
  const runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    unsafeEnableSharedStorage: false,
    workers: [
      {
        config: {
          name: "native-contract",
          compatibilityDate: "2026-10-23",
          manifest: {
            mainModule: "fixture.js",
            modules: {
              "fixture.js": {
                type: "esm",
                contents:
                  "export default { fetch() { return new Response('fixture'); } }",
              },
            },
          },
          env: {
            DB: { type: "d1", id: "native-contract" },
            DATASETS: { type: "r2", name: "native-contract" },
          },
        },
      },
    ],
  });
  try {
    const DB = await runtime.getD1Database("DB");
    const bucket = await runtime.getR2Bucket("DATASETS");
    const contacts = prefectureNames.flatMap((_name, index) =>
      fixtureCategories.map((category) => {
        const code = prefectureCode(index);
        const special = code === "13" && category === "dental";
        return v.parse(ContactSchema, {
          id: `${code}:${category}`,
          sourceRecordId: code,
          prefectureCode: code,
          municipalityCode: `${code}001`,
          category,
          name:
            code === "13" && category === "library"
              ? "公開図書館"
              : special
                ? "試験歯科 <script> & Test, clinic"
                : `Test facility <script> ${category}`,
          address: special
            ? "Test, address; Suite 2\\東"
            : "Test address; floor 1",
          phones: [
            { display: "03-0000-0000", e164: "+81300000000" },
            ...(special
              ? [{ display: "090-1234-5678", e164: "+819012345678" }]
              : []),
          ],
          website:
            code === "13" && category === "medical" ? officialSiteUrl : null,
          sourceId: "test",
          sourceUrls: contactSourceUrls,
          license: "CC0-1.0",
          licenseUrl: contactLicenseUrl,
          dataAsOf: "2026-10-01",
          retrievedAt: "2026-10-29T00:00:00Z",
          phoneConfirmed: false,
          phoneConfirmationUrl: null,
        });
      }),
    );
    const library = contacts.find((contact) => contact.id === "01:library");
    if (!library) throw new Error("Missing regional fixture");
    contacts.push(
      ...Array.from({ length: indexedLibraryCount }, (_, index) => ({
        ...library,
        id: `01:library:${String(index).padStart(indexedLibraryDigits, "0")}`,
        sourceRecordId: `branch:${index}`,
        name: `Index facility ${String(index).padStart(indexedLibraryDigits, "0")}`,
      })),
    );
    if (options.revision === "updated") {
      const first = contacts[0];
      if (!first) throw new Error("Missing baseline fixture");
      contacts[0] = { ...first, name: "Updated public directory record" };
    }
    const jsonl = contacts
      .map((contact) => `${JSON.stringify(contact)}\n`)
      .join("");
    const snapshot = createHash("sha256").update(jsonl).digest("hex");
    await DB.batch(
      databaseSchema
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => DB.prepare(sql)),
    );
    const rowNumbers = contactRowNumbers(contacts);
    for (const contact of contacts) {
      const rowid = rowNumbers.get(contact.id);
      if (rowid === undefined) throw new Error("Missing fixture row number");
      await DB.batch([
        DB.prepare(
          "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          rowid,
          contact.id,
          contact.name,
          normalizeName(contact.name),
          contact.prefectureCode,
          contact.municipalityCode,
          contact.category,
          contact.sourceId,
          JSON.stringify(contact),
        ),
        ...contact.phones.map((phone) =>
          DB.prepare("INSERT INTO phones VALUES (?, ?)").bind(
            phone.e164,
            rowid,
          ),
        ),
        DB.prepare(
          "INSERT INTO contact_search(rowid,terms) VALUES (?, ?)",
        ).bind(rowid, nameTokens(normalizeName(contact.name)).join(" ")),
      ]);
    }
    const catalog = v.parse(CatalogSchema, {
      snapshot,
      generatedAt: "2026-10-29T00:00:00Z",
      contacts: contacts.length,
      phones: fixturePhoneCount,
      sourceCount: 1,
      categories: categoryDefinitions.map((category) => ({
        id: category.id,
        label: category.label,
        contacts: contacts.filter((contact) => contact.category === category.id)
          .length,
        publisher: "Test publisher",
        license: "CC0-1.0",
        licenseUrl: categoryLicenseUrl,
      })),
      prefectures: prefectureNames.map((_name, index) => ({
        code: prefectureCode(index),
        name: `Test prefecture ${index + 1}`,
        contacts:
          fixtureCategories.length + (index === 0 ? indexedLibraryCount : 0),
      })),
      municipalities: prefectureNames.map((_name, index) => ({
        code: `${prefectureCode(index)}001`,
        name: `Test city ${index + 1}`,
        prefectureCode: prefectureCode(index),
      })),
    });
    const source = v.parse(SourceSchema, {
      id: "test",
      url: sourceArtifactUrl,
      sha256: "a".repeat(sha256HexLength),
      indexUrl: sourceIndexUrl,
      indexSha256: "b".repeat(sha256HexLength),
      licenseUrl: null,
      licenseSha256: null,
      dataAsOf: "2026-10-01",
      retrievedAt: catalog.generatedAt,
      artifacts: [
        {
          url: sourceArtifactUrl,
          sha256: "a".repeat(sha256HexLength),
          retrievedAt: catalog.generatedAt,
        },
      ],
      rows: contacts.length,
      accepted: contacts.length,
      missingPhone: 0,
      invalid: 0,
      duplicate: 0,
      issues: {},
    });
    const real = await readRealDirectory(snapshot);
    const published = real?.catalog ?? catalog;
    await DB.batch([
      DB.prepare("INSERT INTO metadata VALUES ('catalog', ?)").bind(
        JSON.stringify(published),
      ),
      DB.prepare("INSERT INTO sources VALUES (?, ?)").bind(
        source.id,
        JSON.stringify(source),
      ),
    ]);
    const files = [];
    for (const [file, bytes] of [
      ["contacts.jsonl.gz", portableGzip(jsonl)],
      ["contacts.csv.gz", portableGzip("fixture\n")],
      ["contacts.vcf.gz", portableGzip(contacts.map(contactVCard).join(""))],
      [
        directoryArchiveFile,
        real?.archive ??
          compressDirectoryArchive(
            encodeDirectoryArchive(contacts, {
              snapshot,
              catalog,
              sources: [source],
            }),
          ),
      ],
    ] as const) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await bucket.put(`${snapshot}/${sha256}/${file}`, bytes);
      files.push({
        file,
        sha256,
        bytes: bytes.length,
        url: `/api/datasets/${snapshot}/${sha256}/${file}`,
      });
    }
    const searchIndex = encodeSearchIndex(
      contacts
        .toSorted(
          (left, right) =>
            (rowNumbers.get(left.id) ?? 0) - (rowNumbers.get(right.id) ?? 0),
        )
        .map((contact) => searchIndexRow(contact)),
      { snapshot, catalog },
    );
    const compressedIndex = compressSearchIndex(searchIndex);
    const searchIndexSha256 = createHash("sha256")
      .update(compressedIndex)
      .digest("hex");
    await bucket.put(
      `${snapshot}/${searchIndexSha256}/${searchIndexFile}`,
      compressedIndex,
    );
    const manifest = v.parse(PreparedDatasetManifestSchema, {
      snapshot,
      generatedAt: published.generatedAt,
      contacts: published.contacts,
      phones: published.phones,
      sourceCount: published.sourceCount,
      sourceDatabaseSha256: "c".repeat(sha256HexLength),
      databaseSha256: "d".repeat(sha256HexLength),
      files,
      searchIndex: {
        file: searchIndexFile,
        sha256: searchIndexSha256,
        bytes: compressedIndex.byteLength,
        uncompressedSha256: createHash("sha256")
          .update(searchIndex)
          .digest("hex"),
        uncompressedBytes: searchIndex.byteLength,
      },
    });
    await bucket.put(`${snapshot}/manifest.json`, JSON.stringify(manifest));
    const bindings: DirectoryApiBindings = {
      DB,
      APP_ENV: "development",
      PUBLIC_ORIGIN: fixtureOrigin,
      DATASETS: {
        get: async (key) => {
          const object = await bucket.get(key);
          if (!object) return null;
          const bytes = new Uint8Array(await object.arrayBuffer());
          const body = new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(bytes);
              controller.close();
            },
          });
          return { body, size: object.size, httpEtag: object.httpEtag };
        },
      },
    };
    const fetch = async (request: Request): Promise<Response> =>
      api.fetch(request, bindings);
    const discovery: unknown = await (
      await fetch(new Request(new URL("/api/v1", contractOrigin)))
    ).json();
    v.parse(DirectoryDiscoverySchema, discovery);
    return { fetch, dispose: async () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
