import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  controlKeys,
  fileControlStore,
  r2ControlStore,
} from "../../tools/control-store.ts";
import {
  fetchDataset,
  mayCreateBucket,
  parseRemoteDataArguments,
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
  "directory.sqlite": "database bytes",
  [deltaFile]: "delta bytes",
};
const manifest = JSON.stringify({
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
});
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
    for (const text of Object.values(files))
      expect(await store.head(controlKeys.blob(digest(text)))).not.toBeNull();
    const target = join(root, "fetched");
    await fetchDataset(store, manifestSha256, target);
    for (const [name, text] of Object.entries(files))
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
