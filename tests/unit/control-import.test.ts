import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyControlImport,
  planControlImport,
} from "../../tools/control-import.ts";
import {
  controlKeys,
  fileControlStore,
  readObject,
} from "../../tools/control-store.ts";
import { loadRelease, releaseHistory } from "../../tools/release-store.ts";

const digest = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const manifestText = (database: string, archive: string): string =>
  JSON.stringify({
    snapshot: "1".repeat(64),
    databaseSha256: digest(database),
    files: [
      {
        file: "contacts.csv.gz",
        sha256: digest(archive),
        bytes: archive.length,
      },
    ],
  });
const databaseText = "sqlite bytes";
const archiveText = "archive bytes";
const manifest = manifestText(databaseText, archiveText);
const manifestSha256 = digest(manifest);

function target(releaseId: string, versionId: string, bundle: string): object {
  return {
    releaseId,
    versionId,
    sourceTree: "a".repeat(40),
    snapshot: "1".repeat(64),
    databaseSha256: digest(databaseText),
    databaseId: "22222222-2222-4222-8222-222222222222",
    manifestSha256,
    artifactSha256: "4".repeat(64),
    bundle,
    manifestBinding: "digest",
  };
}

const first = "11111111-1111-4111-8111-111111111111";
const second = "33333333-3333-4333-8333-333333333333";
const failed = "55555555-5555-4555-8555-555555555555";
const version = (id: string): string => id.replace(/^./u, "9");

let root = "";
let bundle = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "phonebook-import-"));
  bundle = `/elsewhere/owner/.local/releases/bundles/${manifestSha256}`;
  await mkdir(join(root, "releases/bundles", manifestSha256), {
    recursive: true,
  });
  await writeFile(
    join(root, "releases/bundles", manifestSha256, "manifest.ready.json"),
    manifest,
  );
  await writeFile(
    join(root, "releases/bundles", manifestSha256, "catalog.json"),
    '{"catalog":true}',
  );
  await mkdir(join(root, "phonebook"));
  await writeFile(join(root, "phonebook/manifest.ready.json"), manifest);
  await writeFile(join(root, "phonebook/directory.sqlite"), databaseText);
  await writeFile(join(root, "phonebook/contacts.csv.gz"), archiveText);
  await writeFile(
    join(root, "test-receipt.json"),
    JSON.stringify({ formatVersion: 1, result: "passed" }),
  );
  await writeFile(join(root, "releases/production.json"), "{}");
  const journals = [
    {
      name: `production-${failed}.json`,
      at: 1,
      value: {
        formatVersion: 1,
        phase: "recovering",
        candidate: target(failed, version(failed), bundle),
        previous: null,
      },
    },
    {
      name: `production-${first}.json`,
      at: 2,
      value: {
        formatVersion: 1,
        phase: "verified",
        candidate: target(first, version(first), bundle),
        previous: null,
      },
    },
    {
      name: `production-${second}.json`,
      at: 3,
      value: {
        formatVersion: 1,
        phase: "verified",
        candidate: target(second, version(second), bundle),
        previous: target(first, version(first), bundle),
      },
    },
  ];
  for (const journal of journals) {
    const path = join(root, "releases", journal.name);
    await writeFile(path, JSON.stringify(journal.value));
    await utimes(path, journal.at, journal.at);
  }
  await writeFile(
    join(root, "releases/production-journal.json"),
    JSON.stringify(journals[2]?.value),
  );
  await writeFile(
    join(root, "releases/staging-journal.json"),
    JSON.stringify(journals[2]?.value),
  );
  await mkdir(join(root, "remote-data"));
  await writeFile(
    join(root, "remote-data/staging.json"),
    JSON.stringify({ environment: "staging", result: "verified" }),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("control import", () => {
  it("plans format 2 history, datasets, verified blobs, and receipts without absolute paths", async () => {
    const plan = await planControlImport(root);
    expect(
      plan.journals.map((journal) => [
        journal.sequence,
        journal.releaseId,
        journal.phase,
      ]),
    ).toEqual([
      [1, failed, "recovering"],
      [2, first, "verified"],
      [3, second, "verified"],
    ]);
    expect(plan.objects.map((object) => object.key).sort()).toEqual(
      [
        controlKeys.journalHistory("production", 1),
        controlKeys.journalHistory("production", 2),
        controlKeys.journalHistory("production", 3),
        controlKeys.dataset(manifestSha256, "manifest.ready.json"),
        controlKeys.dataset(manifestSha256, "catalog.json"),
        controlKeys.blob(digest(archiveText)),
        controlKeys.blob(digest(databaseText)),
        controlKeys.evidence(
          "imported/test-receipt",
          digest(JSON.stringify({ formatVersion: 1, result: "passed" })),
        ),
      ].sort(),
    );
    expect(plan.heads.map((head) => head.key)).toEqual([
      controlKeys.journalHead("production"),
    ]);
    expect(plan.skipped).toEqual([
      {
        source: "releases/production.json",
        reason: "not a format 1 publication journal",
      },
      {
        source: "releases/staging-journal.json",
        reason: "a journal of the retired staging environment",
      },
    ]);
    const serialized = JSON.stringify(
      [...plan.objects, ...plan.heads].map((object) => ({
        key: object.key,
        source: object.source,
        body:
          object.body instanceof Uint8Array
            ? new TextDecoder().decode(object.body)
            : "",
      })),
    );
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("/elsewhere/");
  });

  it("writes the plan to a store once, repeats without change, and refuses a different head", async () => {
    const store = fileControlStore(join(root, "store"), {
      lockedPrefixes: ["journals/production/history/", "evidence/"],
    });
    const plan = await planControlImport(root);
    expect(await applyControlImport(store, plan)).toEqual({
      created: 9,
      unchanged: 0,
    });
    expect(await applyControlImport(store, plan)).toEqual({
      created: 0,
      unchanged: 9,
    });
    const head = await loadRelease(store, "production");
    expect(head?.record.sequence).toBe(3);
    expect(head?.record.provenance).toEqual({ kind: "local" });
    expect(
      (await releaseHistory(store, "production")).map(
        (journal) => journal.candidate.releaseId,
      ),
    ).toEqual([failed, first, second]);
    const blob = await readObject(
      store,
      controlKeys.blob(digest(databaseText)),
    );
    expect(new TextDecoder().decode(blob?.body)).toBe(databaseText);
    const other = fileControlStore(join(root, "other"));
    await other.write(
      controlKeys.journalHead("production"),
      new TextEncoder().encode("{}"),
      { kind: "create" },
    );
    await expect(applyControlImport(other, plan)).rejects.toThrow(
      "different journal",
    );
    expect(await other.head(controlKeys.blob(digest(databaseText)))).toBeNull();
  });

  it("rejects a bundle whose manifest differs from the journal", async () => {
    await writeFile(
      join(root, "releases/bundles", manifestSha256, "manifest.ready.json"),
      "{}",
    );
    await expect(planControlImport(root)).rejects.toThrow("manifest differs");
  });

  it("rejects a retained dataset file that differs from its manifest", async () => {
    await writeFile(join(root, "phonebook/directory.sqlite"), "changed");
    await expect(planControlImport(root)).rejects.toThrow(
      "differs from its manifest",
    );
  });

  it("rejects a head that isn't the latest record and a predecessor without an earlier record", async () => {
    await utimes(join(root, `releases/production-${first}.json`), 4, 4);
    await expect(planControlImport(root)).rejects.toThrow("predecessor");
  });
});
