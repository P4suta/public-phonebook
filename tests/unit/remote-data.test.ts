import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseVerification } from "../../src/core/publication-policy.ts";
import {
  type ControlStore,
  controlKeys,
  fileControlStore,
  r2ControlStore,
} from "../../tools/control-store.ts";
import {
  importIdentity,
  importTransformation,
} from "../../tools/import-identity.ts";
import type { ReleaseJournal } from "../../tools/release-lifecycle.ts";
import { encodeRecord, saveRelease } from "../../tools/release-store.ts";
import {
  databaseFacts,
  fetchDataset,
  mayCreateBucket,
  parseRemoteDataArguments,
  readDatabaseEvidence,
  recordDatabaseVerification,
  storeDataset,
  writeArchives,
} from "../../tools/remote-data.ts";

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const snapshot = "1".repeat(64);
const deltaFile = `directory-delta-${"2".repeat(64)}.tsv.br`;
const files = {
  "contacts.csv.gz": "csv archive",
  "search-index.br": "index bytes",
  "search-ranking.br": "ranking bytes",
  "directory.sqlite": "database bytes",
  [deltaFile]: "delta bytes",
};
const rankingFile = {
  file: "search-ranking.br",
  sha256: digest(files["search-ranking.br"]),
  bytes: files["search-ranking.br"].length,
};
const manifestFields = {
  snapshot,
  databaseSha256: digest(files["directory.sqlite"]),
  files: [
    {
      file: "contacts.csv.gz",
      sha256: digest(files["contacts.csv.gz"]),
      bytes: files["contacts.csv.gz"].length,
    },
  ],
  searchIndex: {
    file: "search-index.br",
    sha256: digest(files["search-index.br"]),
    bytes: files["search-index.br"].length,
  },
  deltas: [
    {
      file: deltaFile,
      sha256: digest(files[deltaFile] ?? ""),
      bytes: files[deltaFile]?.length ?? 0,
    },
  ],
};
const manifest = JSON.stringify(manifestFields);
const manifestSha256 = digest(manifest);
const held = { assertHeld: (): void => undefined };

let root = "";
let bundle = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "phonebook-remote-"));
  bundle = join(root, "bundle");
  await mkdir(bundle);
  await writeFile(join(bundle, "manifest.ready.json"), manifest);
  await writeFile(join(bundle, "catalog.json"), '{"catalog":1}');
  for (const [name, text] of Object.entries(files))
    await writeFile(join(bundle, name), text);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("refuses ranking companions before storing dataset bytes", async () => {
  const store = fileControlStore(join(root, "store"));
  const bucket = fileControlStore(join(root, "bucket"), { layout: "dataset" });
  for (const invalid of [
    { ...manifestFields, searchRanking: rankingFile },
    { ...manifestFields, files: [...manifestFields.files, rankingFile] },
  ]) {
    await writeFile(
      join(bundle, "manifest.ready.json"),
      JSON.stringify(invalid),
    );
    await expect(storeDataset(store, bundle)).rejects.toThrow(
      "omit ranking companions",
    );
    await expect(writeArchives(bucket, bundle, held)).rejects.toThrow(
      "omit ranking companions",
    );
  }
});

describe("remote data arguments", () => {
  it("parses preparation, fetch, and store commands and refuses anything else", () => {
    expect(parseRemoteDataArguments(["production", "bundle"])).toEqual({
      kind: "prepare",
      environment: "production",
      bundle: resolve("bundle"),
    });
    expect(
      parseRemoteDataArguments(["--fetch", manifestSha256, "target"]),
    ).toEqual({
      kind: "fetch",
      manifestSha256,
      directory: resolve("target"),
    });
    expect(parseRemoteDataArguments(["--store", "bundle"])).toEqual({
      kind: "store",
      bundle: resolve("bundle"),
    });
    for (const args of [
      ["development", "bundle"],
      ["--fetch", "short", "target"],
      ["--fetch", manifestSha256],
      ["production"],
      ["staging", "bundle"],
      ["--store"],
    ])
      expect(() => parseRemoteDataArguments(args), args.join(" ")).toThrow();
  });

  it("creates buckets only outside CI", () => {
    expect(mayCreateBucket({ kind: "local" })).toBe(true);
    expect(
      mayCreateBucket({
        kind: "github-actions",
        repository: "P4suta/public-phonebook",
        workflow:
          "P4suta/public-phonebook/.github/workflows/release.yml@refs/heads/main",
        runId: "1",
        runAttempt: 1,
        commit: "a".repeat(40),
        actor: "P4suta",
      }),
    ).toBe(false);
  });
});

describe("control-store datasets", () => {
  it("stores a dataset by content and fetches every verified file back", async () => {
    const store = fileControlStore(join(root, "store"));
    expect(await storeDataset(store, bundle)).toBe(manifestSha256);
    expect(await storeDataset(store, bundle)).toBe(manifestSha256);
    for (const [, text] of Object.entries(files).filter(
      ([name]) => name !== "search-ranking.br",
    ))
      expect(await store.head(controlKeys.blob(digest(text)))).not.toBeNull();
    expect(
      await store.head(controlKeys.blob(digest(files["search-ranking.br"]))),
    ).toBeNull();
    const target = join(root, "fetched");
    await fetchDataset(store, manifestSha256, target);
    for (const [name, text] of Object.entries(files).filter(
      ([name]) => name !== "search-ranking.br",
    ))
      expect(await readFile(join(target, name), "utf8")).toBe(text);
    expect(await readFile(join(target, "manifest.ready.json"), "utf8")).toBe(
      manifest,
    );
  });

  it("refuses a dataset file that differs from its manifest and a corrupted blob", async () => {
    const store = fileControlStore(join(root, "store"));
    await writeFile(join(bundle, "contacts.csv.gz"), "changed");
    await expect(storeDataset(store, bundle)).rejects.toThrow(
      "differs from its manifest",
    );
    await writeFile(join(bundle, "contacts.csv.gz"), files["contacts.csv.gz"]);
    await storeDataset(store, bundle);
    await writeFile(
      join(root, "store", "blobs", "sha256", digest(files["directory.sqlite"])),
      "tampered",
    );
    await expect(
      fetchDataset(store, manifestSha256, join(root, "fetched")),
    ).rejects.toThrow("directory.sqlite");
    await expect(
      fetchDataset(store, "9".repeat(64), join(root, "missing")),
    ).rejects.toThrow("no such dataset");
  });
});

describe("dataset archive writer", () => {
  it("writes content-addressed archives and the manifest once, then skips them", async () => {
    const bucket = fileControlStore(join(root, "bucket"), {
      layout: "dataset",
    });
    expect(await writeArchives(bucket, bundle, held)).toEqual([
      `${snapshot}/${digest(files["contacts.csv.gz"])}/contacts.csv.gz`,
      `${snapshot}/${digest(files["search-index.br"])}/search-index.br`,
      `${snapshot}/${digest(files[deltaFile] ?? "")}/${deltaFile}`,
      `${snapshot}/${manifestSha256}/manifest.json`,
    ]);
    expect(await writeArchives(bucket, bundle, held)).toEqual([]);
    await expect(
      bucket.write(controlKeys.journalHead("production"), new Uint8Array(), {
        kind: "create",
      }),
    ).rejects.toThrow("dataset bucket accepts only new archive keys");
    await expect(
      writeArchives(bucket, bundle, {
        assertHeld: (): void => {
          throw new Error("lease lost");
        },
      }),
    ).rejects.toThrow("lease lost");
  });

  it("binds each bucket to its key layout and refuses unlisted buckets", async () => {
    const options = {
      endpoint: new URL("http://127.0.0.1:9"),
      accessKeyId: "a",
      secretAccessKey: "b",
    };
    const archive = `${snapshot}/${digest("x")}/contacts.csv.gz`;
    await expect(
      r2ControlStore({ ...options, bucket: "dial-production-datasets" }).write(
        controlKeys.lease("production"),
        new Uint8Array(),
        { kind: "create" },
      ),
    ).rejects.toThrow("dataset bucket");
    await expect(
      r2ControlStore({ ...options, bucket: "dial-control" }).write(
        archive,
        new Uint8Array(),
        { kind: "create" },
      ),
    ).rejects.toThrow("Unsupported control key");
    expect(() =>
      r2ControlStore({ ...options, bucket: "dial-development-datasets" }),
    ).toThrow("unlisted bucket");
  });
});

describe("database verification evidence", () => {
  const servedId = "22222222-2222-4222-8222-222222222222";
  const freshId = "33333333-3333-4333-8333-333333333333";
  const servedDigest = "2".repeat(64);
  const served = importIdentity(servedDigest);
  const fresh = importIdentity("6".repeat(64));
  const releaseId = "11111111-1111-4111-8111-111111111111";
  const published: ReleaseJournal = {
    phase: "verified",
    previous: null,
    candidate: {
      releaseId,
      versionId: releaseId,
      databaseId: servedId,
      sourceTree: "1".repeat(40),
      snapshot: "1".repeat(64),
      databaseSha256: servedDigest,
      manifestSha256: "3".repeat(64),
      artifactSha256: "4".repeat(64),
      manifestBinding: "digest",
    },
  };
  const counts = {
    contacts: 4,
    relations: 4,
    phones: 4,
    sources: 1,
    indexed: 4,
    categories: 2,
    prefectures: 3,
  };
  const local = { kind: "local" } as const;
  const lockedStore = (): ControlStore =>
    fileControlStore(join(root, "control"), { lockedPrefixes: ["evidence/"] });

  it("refuses to decide without the publication journal", async () => {
    await expect(
      databaseFacts(lockedStore(), "production", served, servedId),
    ).rejects.toThrow("publication journal");
  });

  it("reads the journal's binding and the evidence of exactly this import identity and resource", async () => {
    const store = lockedStore();
    await saveRelease(store, "production", published, local, null);
    expect(await databaseFacts(store, "production", served, servedId)).toEqual({
      verification: {
        importSha256: served.importSha256,
        resource: servedId,
        evidence: null,
        bound: true,
        publicationVerified: true,
      },
      journalSequence: 1,
      verifiedRelease: releaseId,
    });
    expect(await databaseFacts(store, "production", fresh, freshId)).toEqual({
      verification: {
        importSha256: fresh.importSha256,
        resource: freshId,
        evidence: null,
        bound: false,
        publicationVerified: false,
      },
      journalSequence: 1,
      verifiedRelease: null,
    });
  });

  it("leaves a fresh database of the served dataset unbound and without the served database's evidence", async () => {
    const store = lockedStore();
    await saveRelease(store, "production", published, local, null);
    await store.write(
      controlKeys.databaseEvidence(servedDigest, servedId),
      encodeRecord({
        formatVersion: 1,
        environment: "production",
        databaseSha256: servedDigest,
        database: servedId,
        verification: { source: "verification", counts },
        provenance: local,
      }),
      { kind: "create" },
    );
    const earlier = importIdentity(servedDigest, {
      ...importTransformation,
      derivationRevision: importTransformation.derivationRevision - 1,
    });
    await recordDatabaseVerification(
      store,
      "production",
      earlier,
      await databaseFacts(store, "production", earlier, servedId),
      { verification: "accept-publication" },
      local,
    );
    const facts = await databaseFacts(store, "production", served, freshId);
    expect(facts).toEqual({
      verification: {
        importSha256: served.importSha256,
        resource: freshId,
        evidence: null,
        bound: false,
        publicationVerified: false,
      },
      journalSequence: 1,
      verifiedRelease: null,
    });
    expect(
      (await databaseFacts(store, "production", served, servedId)).verification
        .evidence,
    ).toBeNull();
    expect(
      databaseVerification(
        false,
        "",
        served.importSha256,
        "",
        freshId,
        false,
        facts.verification.bound,
        facts.verification.publicationVerified,
      ),
    ).toBe("verify");
  });

  it("records a full verification and a verified publication once each, and nothing for accepted evidence", async () => {
    const store = lockedStore();
    await saveRelease(store, "production", published, local, null);
    const freshFacts = await databaseFacts(store, "production", fresh, freshId);
    const verified = await recordDatabaseVerification(
      store,
      "production",
      fresh,
      freshFacts,
      { verification: "verify", counts },
      local,
    );
    expect(verified?.verification).toEqual({ source: "verification", counts });
    expect(
      (await databaseFacts(store, "production", fresh, freshId)).verification
        .evidence,
    ).toEqual(verified);
    expect(
      await recordDatabaseVerification(
        store,
        "production",
        fresh,
        freshFacts,
        { verification: "verify", counts },
        local,
      ),
    ).toEqual(verified);
    await expect(
      recordDatabaseVerification(
        store,
        "production",
        fresh,
        freshFacts,
        { verification: "verify", counts: { ...counts, contacts: 5 } },
        local,
      ),
    ).rejects.toThrow("different bytes");

    const servedFacts = await databaseFacts(
      store,
      "production",
      served,
      servedId,
    );
    expect(
      (
        await recordDatabaseVerification(
          store,
          "production",
          served,
          servedFacts,
          { verification: "accept-publication" },
          local,
        )
      )?.verification,
    ).toEqual({ source: "publication", sequence: 1, releaseId });
    const accepted = await databaseFacts(store, "production", served, servedId);
    expect(accepted.verification.evidence).toMatchObject({
      ...served,
      database: servedId,
    });
    expect(
      await recordDatabaseVerification(
        store,
        "production",
        served,
        accepted,
        { verification: "accept-evidence" },
        local,
      ),
    ).toBeNull();
    await expect(
      recordDatabaseVerification(
        store,
        "production",
        fresh,
        servedFacts,
        { verification: "accept-publication" },
        local,
      ),
    ).rejects.toThrow("another import identity");
  });

  it("passes on evidence whose body names another database so that the decision refuses it", async () => {
    const store = lockedStore();
    await saveRelease(store, "production", published, local, null);
    const foreign = {
      formatVersion: 2,
      environment: "production",
      ...fresh,
      database: servedId,
      verification: { source: "verification", counts },
      provenance: local,
    };
    await store.write(
      controlKeys.databaseEvidence(served.importSha256, servedId),
      encodeRecord(foreign),
      { kind: "create" },
    );
    const facts = await databaseFacts(store, "production", served, servedId);
    expect(
      databaseVerification(
        facts.verification.evidence !== null,
        facts.verification.evidence?.importSha256 ?? "",
        served.importSha256,
        facts.verification.evidence?.database ?? "",
        servedId,
        true,
        facts.verification.bound,
        facts.verification.publicationVerified,
      ),
    ).toBe("foreign-evidence");
  });

  it("refuses stored evidence that is malformed, of the earlier format, or of another environment", async () => {
    const store = lockedStore();
    await store.write(
      controlKeys.databaseEvidence(served.importSha256, servedId),
      new TextEncoder().encode('{"formatVersion":2}'),
      { kind: "create" },
    );
    await expect(
      readDatabaseEvidence(store, "production", served.importSha256, servedId),
    ).rejects.toThrow();
    await store.write(
      controlKeys.databaseEvidence(served.importSha256, freshId),
      encodeRecord({
        formatVersion: 1,
        environment: "production",
        databaseSha256: served.importSha256,
        database: freshId,
        verification: { source: "verification", counts },
        provenance: local,
      }),
      { kind: "create" },
    );
    await expect(
      readDatabaseEvidence(store, "production", served.importSha256, freshId),
    ).rejects.toThrow();
    await store.write(
      controlKeys.databaseEvidence(fresh.importSha256, freshId),
      encodeRecord({
        formatVersion: 2,
        environment: "development",
        ...fresh,
        database: freshId,
        verification: { source: "verification", counts },
        provenance: local,
      }),
      { kind: "create" },
    );
    await expect(
      readDatabaseEvidence(store, "production", fresh.importSha256, freshId),
    ).rejects.toThrow();
  });
});
