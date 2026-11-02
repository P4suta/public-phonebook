import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DirectoryDiscovery,
  DirectoryDiscoverySchema,
} from "../../src/core/api-contract.ts";
import { DirectoryDeltaListingSchema } from "../../src/core/dataset-storage.ts";
import { decodeDirectoryArchive } from "../../src/core/directory-archive.ts";
import { applyDirectoryDelta } from "../../src/core/directory-delta.ts";
import {
  DigestSchema,
  GroupedSearchResponseSchema,
  SearchResponseSchema,
  VersionedDatasetManifestSchema,
} from "../../src/core/models.ts";
import { snapshotAdmission } from "../../src/core/snapshot-policy.ts";
import { sha256Digest } from "../../tools/directory-delta.ts";
import {
  contractOrigin,
  directoryFixture,
} from "../../tools/directory-fixture.ts";
import { contractResponses } from "../../tools/native-fixture.ts";

let fixture: Awaited<ReturnType<typeof directoryFixture>> | undefined;
beforeAll(async () => {
  fixture = await directoryFixture();
});
afterAll(async () => fixture?.dispose());

async function request(path: string): Promise<Response> {
  if (!fixture) throw new Error("Missing contract fixture");
  return fixture.fetch(new Request(new URL(path, "https://contract.example")));
}

describe("shared native API contract", () => {
  it("versions errors and preflight responses without redirects", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) {
      if (!fixture) throw new Error("Missing contract fixture");
      const response = await fixture.fetch(
        new Request("https://contract.example/api/v1/catalog?snapshot=bad", {
          method,
        }),
      );
      expect(response.headers.get("X-Directory-API-Version"), method).toBe("1");
      expect(response.headers.get("location"), method).toBeNull();
    }
  });
  it("pins every mutable discovery and direct-search continuation", async () => {
    const discovery = v.parse(
      DirectoryDiscoverySchema,
      await (await request("/api/v1")).json(),
    );
    for (const path of [
      discovery.contacts,
      discovery.contactGroups,
      discovery.catalog,
      discovery.sources,
      discovery.datasets,
      discovery.datasetDeltas,
    ])
      expect(
        new URL(path, "https://contract.example").searchParams.get("snapshot"),
      ).toBe(discovery.snapshot);
    const page = v.parse(
      SearchResponseSchema,
      await (await request("/api/v1/contacts?limit=1")).json(),
    );
    expect(new URL(page.links.next ?? "").searchParams.get("snapshot")).toBe(
      discovery.snapshot,
    );
  });
  it("keeps immutable archive URLs on the versioned API and checks the requested snapshot", async () => {
    const manifest = v.parse(
      VersionedDatasetManifestSchema,
      await (await request("/api/v1/datasets")).json(),
    );
    for (const file of manifest.files) {
      const response = await request(file.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Directory-API-Version")).toBe("1");
      expect(response.headers.get("X-Dataset-Snapshot")).toBe(
        manifest.snapshot,
      );
      expect(response.headers.get("Content-Type")).toBe(
        file.file === "directory.tsv.br"
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
          `/api/v1/datasets/${manifest.snapshot}/${"0".repeat(64)}/directory.tsv`,
        )
      ).status,
    ).toBe(404);
  });
  it("exports only the requested bounded region and category as vCards with pinned continuation", async () => {
    const response = await request(
      "/api/v1/contacts.vcf?prefecture=01&category=library&limit=2",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/vcard");
    const text = await response.text();
    expect(text.match(/BEGIN:VCARD/gu)).toHaveLength(2);
    expect(text).not.toContain("Test facility <script> medical");
    const continuation = response.headers.get("Link") ?? "";
    const next = new URL(continuation.slice(1, continuation.indexOf(">")));
    expect(next.pathname).toBe("/api/v1/contacts.vcf");
    expect(next.searchParams.get("snapshot")).toBe(
      response.headers.get("X-Dataset-Snapshot"),
    );
    expect((await request(next.pathname + next.search)).status).toBe(200);
  });
  it("documents snapshot pins only on versioned mutable resources", async () => {
    for (const base of ["/api", "/api/v1"]) {
      const body: unknown = await (
        await request(`${base}/openapi.json`)
      ).json();
      const specification = v.parse(
        v.object({
          paths: v.record(
            v.string(),
            v.object({
              get: v.object({
                parameters: v.optional(
                  v.array(v.object({ name: v.string(), in: v.string() })),
                ),
              }),
            }),
          ),
        }),
        body,
      );
      for (const [path, resource] of Object.entries(specification.paths)) {
        const pins =
          resource.get.parameters?.filter(
            (parameter) =>
              parameter.name === "snapshot" && parameter.in === "query",
          ) ?? [];
        expect(pins.length, path).toBe(
          base === "/api/v1" && !path.includes("/datasets/{") ? 1 : 0,
        );
      }
    }
  });
  it("rejects digests with trailing line terminators at the schema and HTTP boundaries", async () => {
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\0", "a"]) {
      const value = "a".repeat(64) + suffix;
      expect(
        v.safeParse(DigestSchema, value).success,
        JSON.stringify(suffix),
      ).toBe(false);
      expect(
        (await request(`/api/v1/catalog?snapshot=${encodeURIComponent(value)}`))
          .status,
      ).toBe(400);
    }
  });
  it("reproduces the exact provider corpus consumed by Swift", async () => {
    const expected: unknown = JSON.parse(
      await readFile(
        "ios/Tests/PhonebookKitTests/DirectoryContract.json",
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
      readonly discovery: DirectoryDiscovery;
      readonly file:
        | { readonly url: string; readonly sha256: string }
        | undefined;
      readonly archive: string;
    } => {
      const responses = actual.filter((response) => response.revision === name);
      const discovery = v.parse(
        DirectoryDiscoverySchema,
        JSON.parse(responses[0]?.body ?? ""),
      );
      const listing = responses.find(
        (response) => response.path === discovery.datasets,
      );
      const manifest = v.parse(
        VersionedDatasetManifestSchema,
        JSON.parse(listing?.body ?? ""),
      );
      const file = manifest.files.find(
        (item) => item.file === "directory.tsv.br",
      );
      const archive = responses.find((response) => response.path === file?.url);
      expect(archive?.encoding).toBe("base64");
      expect(archive?.headers["Content-Type"]).toBe("application/octet-stream");
      const data = bytes(archive?.body);
      expect(data.byteLength).toBe(file?.bytes);
      expect(sha256(data)).toBe(file?.sha256);
      const decoded = decodeDirectoryArchive(text(data));
      expect(decoded.header.snapshot).toBe(discovery.snapshot);
      expect(decoded.rows).toHaveLength(manifest.contacts);
      return { responses, discovery, file, archive: text(data) };
    };
    const baseline = revision("baseline");
    expect(baseline.responses.map((response) => response.path)).toEqual([
      "/api/v1",
      baseline.discovery.catalog,
      baseline.discovery.datasets,
      baseline.file?.url,
    ]);
    const updated = revision("updated");
    const listing = v.parse(
      DirectoryDeltaListingSchema,
      JSON.parse(updated.responses[2]?.body ?? ""),
    );
    const [delta] = listing.deltas;
    expect(listing.deltas).toHaveLength(1);
    expect(listing.archiveSha256).toBe(updated.file?.sha256);
    expect(delta?.base).toBe(baseline.discovery.snapshot);
    expect(delta?.baseArchiveSha256).toBe(baseline.file?.sha256);
    expect(updated.responses.map((response) => response.path)).toEqual([
      "/api/v1",
      updated.discovery.datasets,
      updated.discovery.datasetDeltas,
      delta?.url,
      updated.file?.url,
    ]);
    const deltaBytes = bytes(updated.responses[3]?.body);
    expect(updated.responses[3]?.headers["Content-Type"]).toBe(
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
          !/\.tsv\.br$/u.test(new URL(response.path, contractOrigin).pathname),
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

  it("keeps the legacy routes compatible with the versioned provider", async () => {
    const current = await request("/api/v1");
    expect(current.headers.get("X-Directory-API-Version")).toBe("1");
    const raw: unknown = await current.json();
    const discovery = v.parse(DirectoryDiscoverySchema, raw);
    expect(current.headers.get("X-Dataset-Snapshot")).toBe(discovery.snapshot);
    const legacy: unknown = await (
      await request("/api/contacts?limit=50")
    ).json();
    const versioned: unknown = await (
      await request(`${discovery.contacts}&limit=50`)
    ).json();
    const old = v.parse(SearchResponseSchema, legacy);
    const native = v.parse(SearchResponseSchema, versioned);
    expect(native.data).toEqual(old.data);
    expect(native.meta).toEqual(old.meta);
    expect(new URL(native.links.next ?? "").pathname).toBe("/api/v1/contacts");
  });

  it("rejects stale, malformed, and ambiguous identities before returning mutable resources", async () => {
    for (const path of [
      "catalog",
      "contacts",
      "sources/test",
      "contacts/13%3Adental",
      "contacts/13%3Adental/contact.vcf",
      "datasets",
      "dataset-deltas",
    ]) {
      expect(
        (await request(`/api/v1/${path}?snapshot=${"0".repeat(64)}`)).status,
        path,
      ).toBe(409);
      for (const query of [
        "snapshot=x",
        `snapshot=${"0".repeat(64)}&snapshot=${"1".repeat(64)}`,
      ])
        expect((await request(`/api/v1/${path}?${query}`)).status, path).toBe(
          400,
        );
    }
  });

  it("preserves the version and snapshot across category continuations", async () => {
    const raw: unknown = await (await request("/api/v1")).json();
    const discovery = v.parse(DirectoryDiscoverySchema, raw);
    const body: unknown = await (
      await request(`/api/v1/contact-groups?snapshot=${discovery.snapshot}`)
    ).json();
    const grouped = v.parse(GroupedSearchResponseSchema, body);
    for (const group of grouped.groups) {
      const next = new URL(group.results.links.next ?? "");
      expect(next.pathname).toBe("/api/v1/contacts");
      expect(next.searchParams.get("snapshot")).toBe(discovery.snapshot);
      expect((await request(next.pathname + next.search)).status).toBe(200);
    }
  });
});
