import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import { sha256Digest } from "@public-phonebook/data/directory-delta";
import {
  type DatasetFileListing,
  DatasetFileListingSchema,
  DirectoryDeltaListingSchema,
  datasetFileFormats,
  SearchIndexLocationSchema,
  SearchRankingLocationSchema,
} from "@public-phonebook/directory/dataset-storage";
import { decodeDirectoryArchive } from "@public-phonebook/directory/directory-archive";
import { applyDirectoryDelta } from "@public-phonebook/directory/directory-delta";
import { DigestSchema } from "@public-phonebook/directory/models";
import { snapshotAdmission } from "@public-phonebook/directory/snapshot-policy";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contractOrigin,
  directoryFixture,
} from "../../tools/directory-fixture.ts";
import { contractResponses } from "../../tools/native-fixture.ts";

// The published identifiers stay literal here, so a changed signature fails as a contract change.
const archiveFormat = "public-phonebook-directory/1";
const deltaFormat = "public-phonebook-directory-delta/1";

let fixture: Awaited<ReturnType<typeof directoryFixture>> | undefined;
beforeAll(async () => {
  fixture = await directoryFixture();
});
afterAll(async () => fixture?.dispose());

async function request(path: string, init?: RequestInit): Promise<Response> {
  if (!fixture) throw new Error("Missing contract fixture");
  return fixture.fetch(
    new Request(new URL(path, "https://contract.example"), init),
  );
}

async function listing(): Promise<DatasetFileListing> {
  return v.parse(
    DatasetFileListingSchema,
    await (await request("/api/datasets")).json(),
  );
}

describe("shared native API contract", () => {
  it("answers errors and preflight responses without redirects or an API version", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
      const response = await request("/api/datasets?snapshot=bad", { method });
      expect(
        response.headers.get("X-Directory-API-Version"),
        method,
      ).toBeNull();
      expect(response.headers.get("location"), method).toBeNull();
    }
  });
  it("pins the delta link to the listed snapshot", async () => {
    const current = await listing();
    expect(
      new URL(
        current.datasetDeltas,
        "https://contract.example",
      ).searchParams.getAll("snapshot"),
    ).toEqual([current.snapshot]);
  });
  it("serves no versioned route", async () => {
    const { files } = await listing();
    for (const path of [
      "/api/v1",
      "/api/v1/datasets",
      "/api/v1/dataset-deltas",
      ...files.map((file) => file.url.replace("/api/", "/api/v1/")),
      "/api/v1/catalog",
      "/api/v1/contacts",
      "/api/v1/contact-groups",
      "/api/v1/contacts.vcf",
      "/api/v1/contacts/13%3Adental",
      "/api/v1/contacts/13%3Adental/contact.vcf",
      "/api/v1/sources",
      "/api/v1/sources/test",
      "/api/v1/openapi.json",
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("X-Directory-API-Version"), path).toBeNull();
    }
  });
  it("declares each file's format and serves it at its immutable URL", async () => {
    const manifest = await listing();
    expect(
      Object.fromEntries(
        manifest.files.map((file) => [file.file, file.format]),
      ),
    ).toEqual({
      "contacts.jsonl.gz": "public-phonebook-contacts-jsonl/1",
      "contacts.csv.gz": "public-phonebook-contacts-csv/1",
      "contacts.vcf.gz": "public-phonebook-contacts-vcard/1",
      "directory.tsv.br": archiveFormat,
    });
    expect(datasetFileFormats["directory.tsv.br"]).toBe(archiveFormat);
    for (const file of manifest.files) {
      const response = await request(file.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Dataset-Snapshot")).toBe(
        manifest.snapshot,
      );
      expect(response.headers.get("Content-Type")).toBe(
        file.format === archiveFormat
          ? "application/octet-stream"
          : "application/gzip",
      );
      expect(response.headers.get("Content-Disposition")).toBe(
        `attachment; filename="${file.file}"`,
      );
      expect(response.headers.get("Content-Encoding")).toBeNull();
      expect((await response.arrayBuffer()).byteLength).toBe(file.bytes);
    }
    expect(
      (
        await request(
          `/api/datasets/${manifest.snapshot}/${"0".repeat(64)}/directory.tsv`,
        )
      ).status,
    ).toBe(404);
  });
  it("rejects digests with trailing line terminators at the schema and HTTP boundaries", async () => {
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\0", "a"]) {
      const value = "a".repeat(64) + suffix;
      expect(
        v.safeParse(DigestSchema, value).success,
        JSON.stringify(suffix),
      ).toBe(false);
      expect(
        (await request(`/api/datasets?snapshot=${encodeURIComponent(value)}`))
          .status,
      ).toBe(400);
    }
  });
  it("reproduces the exact provider corpus consumed by Swift", async () => {
    const expected: unknown = JSON.parse(
      await readFile(
        "apps/ios/Tests/PhonebookKitTests/DirectoryContract.json",
        "utf8",
      ),
    );
    const actual = await contractResponses();
    const bytes = (body = ""): Uint8Array =>
      Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
    const text = (data: Uint8Array): string =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        brotliDecompressSync(data),
      );
    const sha256 = (data: Uint8Array): string =>
      createHash("sha256").update(data).digest("hex");
    const revision = (
      name: "baseline" | "updated",
    ): {
      readonly responses: typeof actual;
      readonly listing: DatasetFileListing;
      readonly file:
        | { readonly url: string; readonly sha256: string }
        | undefined;
      readonly archive: string;
    } => {
      const responses = actual.filter((response) => response.revision === name);
      expect(responses[0]?.path).toBe("/api/datasets");
      const manifest = v.parse(
        DatasetFileListingSchema,
        JSON.parse(responses[0]?.body ?? ""),
      );
      const file = manifest.files.find((item) => item.format === archiveFormat);
      const archive = responses.find((response) => response.path === file?.url);
      expect(archive?.encoding).toBe("base64");
      expect(archive?.headers["Content-Type"]).toBe("application/octet-stream");
      const data = bytes(archive?.body);
      expect(data.byteLength).toBe(file?.bytes);
      expect(sha256(data)).toBe(file?.sha256);
      const decoded = decodeDirectoryArchive(text(data));
      expect(decoded.header.snapshot).toBe(manifest.snapshot);
      expect(decoded.rows).toHaveLength(manifest.contacts);
      for (const [kind, schema] of [
        ["search-index", SearchIndexLocationSchema],
        ["search-ranking", SearchRankingLocationSchema],
      ] as const) {
        const discovery = responses.find(
          (response) => response.path === `/api/${kind}`,
        );
        const artifact = v.parse(schema, JSON.parse(discovery?.body ?? ""));
        expect(artifact.snapshot).toBe(manifest.snapshot);
        const download = responses.find(
          (response) => response.path === `${artifact.url}/download`,
        );
        expect(download?.encoding).toBe("base64");
        expect(download?.headers["Content-Type"]).toBe(
          "application/octet-stream",
        );
        const compressed = bytes(download?.body);
        expect(compressed.byteLength).toBe(artifact.bytes);
        expect(sha256(compressed)).toBe(artifact.sha256);
        const decoded = brotliDecompressSync(compressed);
        expect(decoded.byteLength).toBe(artifact.uncompressedBytes);
        expect(sha256(decoded)).toBe(artifact.uncompressedSha256);
      }
      return { responses, listing: manifest, file, archive: text(data) };
    };
    const baseline = revision("baseline");
    const searchPaths = (responses: typeof actual): string[] => {
      const locations = ["/api/search-index", "/api/search-ranking"];
      return [
        ...locations,
        ...locations.map((path) => {
          const discovery = responses.find(
            (response) => response.path === path,
          );
          const artifact = v.parse(
            path === "/api/search-ranking"
              ? SearchRankingLocationSchema
              : SearchIndexLocationSchema,
            JSON.parse(discovery?.body ?? ""),
          );
          return `${artifact.url}/download`;
        }),
      ];
    };
    expect(baseline.responses.map((response) => response.path)).toEqual([
      "/api/datasets",
      baseline.file?.url,
      ...searchPaths(baseline.responses),
    ]);
    const updated = revision("updated");
    const deltas = v.parse(
      DirectoryDeltaListingSchema,
      JSON.parse(updated.responses[1]?.body ?? ""),
    );
    const [delta] = deltas.deltas;
    expect(deltas.deltas).toHaveLength(1);
    expect(delta?.format).toBe(deltaFormat);
    expect(deltas.archiveSha256).toBe(updated.file?.sha256);
    expect(delta?.base).toBe(baseline.listing.snapshot);
    expect(delta?.baseArchiveSha256).toBe(baseline.file?.sha256);
    expect(updated.responses.map((response) => response.path)).toEqual([
      "/api/datasets",
      updated.listing.datasetDeltas,
      delta?.url,
      updated.file?.url,
      ...searchPaths(updated.responses),
    ]);
    const deltaBytes = bytes(updated.responses[2]?.body);
    expect(updated.responses[2]?.headers["Content-Type"]).toBe(
      "application/octet-stream",
    );
    expect(deltaBytes.byteLength).toBe(delta?.bytes);
    expect(sha256(deltaBytes)).toBe(delta?.sha256);
    const applied = applyDirectoryDelta(
      baseline.archive,
      text(deltaBytes),
      sha256Digest,
    );
    expect(applied.admission).toBe("apply");
    expect(applied.text).toBe(updated.archive);
    expect(
      actual.every(
        (response) =>
          !response.encoding ===
          !/(?:\.tsv\.br|\/download)$/u.test(
            new URL(response.path, contractOrigin).pathname,
          ),
      ),
    ).toBe(true);
    expect(actual).toEqual(expected);
  });

  it("exhausts the snapshot admission decision domain", () => {
    for (const supplied of [false, true])
      for (const unambiguous of [false, true])
        for (const wellFormed of [false, true])
          for (const matches of [false, true]) {
            const result = snapshotAdmission(
              supplied,
              unambiguous,
              wellFormed,
              matches,
            );
            expect(result === "accepted").toBe(
              unambiguous && wellFormed && (!supplied || matches),
            );
            expect(result === "invalid_query").toBe(
              !unambiguous || !wellFormed,
            );
            expect(result === "snapshot_changed").toBe(
              unambiguous && wellFormed && supplied && !matches,
            );
          }
  });

  it("serves both listings to every origin with the current snapshot, pinned or not", async () => {
    const { snapshot, datasetDeltas } = await listing();
    for (const path of [
      "/api/datasets",
      `/api/datasets?snapshot=${snapshot}`,
      "/api/dataset-deltas",
      datasetDeltas,
    ]) {
      const response = await request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin"), path).toBe(
        "*",
      );
      expect(response.headers.get("X-Dataset-Snapshot"), path).toBe(snapshot);
    }
  });

  it("rejects stale, malformed, and ambiguous identities before returning mutable resources", async () => {
    for (const path of ["/api/datasets", "/api/dataset-deltas"]) {
      expect(
        (await request(`${path}?snapshot=${"0".repeat(64)}`)).status,
        path,
      ).toBe(409);
      for (const query of [
        "snapshot=x",
        `snapshot=${"0".repeat(64)}&snapshot=${"1".repeat(64)}`,
      ])
        expect((await request(`${path}?${query}`)).status, path).toBe(400);
    }
  });
});
