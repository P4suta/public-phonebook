import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CheckedFile,
  checkDataBundle,
  checkedDataBundle,
  checkedFileNames,
  dataCheckKey,
  reusesDataCheck,
} from "@public-phonebook/data/check-data";
import { fileDigest } from "@public-phonebook/data/snapshot";
import type { ArchiveForms } from "@public-phonebook/data/telephone-parity";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCheckFixture } from "../../tools/check-fixture.ts";
import type { TrackedFile } from "../../tools/stage-inputs.ts";

const key = "a".repeat(64);
const catalogFile: CheckedFile = {
  file: "catalog.json",
  bytes: 10,
  sha256: "1".repeat(64),
};
const manifestFile: CheckedFile = {
  file: "manifest.ready.json",
  bytes: 20,
  sha256: "2".repeat(64),
};
const files = [catalogFile, manifestFile];

function receipt(fields: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    formatVersion: 1,
    key,
    files,
    result: "passed",
    ...fields,
  });
}

describe("data check reuse decision", () => {
  it.each<[string, string, string | null, readonly CheckedFile[], boolean]>([
    ["the same key and bytes", key, receipt(), files, true],
    ["no receipt", key, null, files, false],
    ["text that isn't JSON", key, "{", files, false],
    ["a receipt for another key", "b".repeat(64), receipt(), files, false],
    [
      "another receipt format",
      key,
      receipt({ formatVersion: 2 }),
      files,
      false,
    ],
    [
      "a result that didn't pass",
      key,
      receipt({ result: "failed" }),
      files,
      false,
    ],
    ["an unknown field", key, receipt({ bypass: true }), files, false],
    ["a receipt that covers no file", key, receipt({ files: [] }), [], false],
    [
      "a receipt for other bytes",
      key,
      receipt({
        files: [{ ...catalogFile, sha256: "3".repeat(64) }, manifestFile],
      }),
      files,
      false,
    ],
    [
      "a changed digest",
      key,
      receipt(),
      [catalogFile, { ...manifestFile, sha256: "3".repeat(64) }],
      false,
    ],
    [
      "a changed size",
      key,
      receipt(),
      [{ ...catalogFile, bytes: 11 }, manifestFile],
      false,
    ],
    [
      "a renamed file",
      key,
      receipt(),
      [{ ...catalogFile, file: "catalog.jsonl" }, manifestFile],
      false,
    ],
    ["a missing file", key, receipt(), [catalogFile], false],
    [
      "an extra file",
      key,
      receipt(),
      [...files, { file: "search-index.br", bytes: 1, sha256: "4".repeat(64) }],
      false,
    ],
    ["another order", key, receipt(), [manifestFile, catalogFile], false],
  ])("decides for %s", (_case, expectedKey, text, observed, reuse) => {
    expect(reusesDataCheck(expectedKey, text, observed)).toBe(reuse);
  });
});

const checker = "data/src/check-data.ts";
const nativeFile = "apps/ios/Sources/App.swift";

function tracked(changed?: string): readonly TrackedFile[] {
  return [checker, nativeFile].map((path) => ({
    mode: "100644",
    object: (path === changed ? "2" : "1").repeat(40),
    path,
  }));
}

describe("data check key", () => {
  it("changes with the checker, the manifest, and the admitted forms, and ignores files only the native app reads", () => {
    const manifest = "c".repeat(64);
    const base = dataCheckKey(tracked(), manifest, "canonical");
    expect(dataCheckKey(tracked(), manifest, "canonical")).toBe(base);
    expect(dataCheckKey(tracked(checker), manifest, "canonical")).not.toBe(
      base,
    );
    expect(dataCheckKey(tracked(), "d".repeat(64), "canonical")).not.toBe(base);
    expect(dataCheckKey(tracked(), manifest, "retained")).not.toBe(base);
    expect(dataCheckKey(tracked(nativeFile), manifest, "canonical")).toBe(base);
  });
});

const RecordedSchema = v.object({
  files: v.array(
    v.object({ file: v.string(), bytes: v.number(), sha256: v.string() }),
  ),
});

describe("checked data bundle", () => {
  let root = "";
  let bundle = "";
  let receipts = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "phonebook-data-check-"));
    bundle = join(root, "bundle");
    receipts = join(root, "receipts");
    await writeCheckFixture(bundle);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  /** Runs the reuse layer and counts the complete checks it started. */
  async function attempt(
    source: readonly TrackedFile[] | null = tracked(),
    forms: ArchiveForms = "canonical",
  ): Promise<{ readonly checks: number; readonly passed: boolean }> {
    const check = vi.fn(checkDataBundle);
    const passed = await checkedDataBundle(bundle, forms, {
      sourceFiles: () => Promise.resolve(source),
      receipts,
      check,
    }).then(
      () => true,
      () => false,
    );
    return { checks: check.mock.calls.length, passed };
  }

  async function receiptNames(): Promise<readonly string[]> {
    return readdir(receipts).catch(() => []);
  }

  it("checks once and then reuses the result for unchanged bytes on a clean tree", async () => {
    const ports = {
      sourceFiles: (): Promise<readonly TrackedFile[]> =>
        Promise.resolve(tracked()),
      receipts,
      check: vi.fn(checkDataBundle),
    };
    const checked = await checkedDataBundle(bundle, "canonical", ports);
    expect(ports.check).toHaveBeenCalledTimes(1);
    expect(await receiptNames()).toHaveLength(1);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const reused = await checkedDataBundle(bundle, "canonical", ports);
    expect(ports.check).toHaveBeenCalledTimes(1);
    expect(reused).toEqual(checked);
    expect(info).toHaveBeenCalledOnce();
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      operation: "data.check",
      result: "reused",
      key: dataCheckKey(
        tracked(),
        await fileDigest(join(bundle, "manifest.ready.json")),
        "canonical",
      ),
      snapshot: checked.snapshot,
      files: checkedFileNames(checked).length,
      forms: "canonical",
    });
  });

  it("runs the complete check after a one-byte change to any file in the bundle", async () => {
    const names = (await readdir(bundle)).sort();
    expect(names).toEqual(checkedFileNames(await checkDataBundle(bundle)));
    expect(await attempt()).toEqual({ checks: 1, passed: true });
    for (const name of names) {
      const path = join(bundle, name);
      const original = await readFile(path);
      const changed = new Uint8Array(original);
      const index = Math.floor(changed.byteLength / 2);
      changed[index] = 255 - (changed[index] ?? 0);
      await writeFile(path, changed);
      expect((await attempt()).checks, name).toBe(1);
      await writeFile(path, original);
      expect((await attempt()).checks, name).toBe(0);
    }
  });

  it("runs the complete check for another checker input digest", async () => {
    expect(await attempt()).toEqual({ checks: 1, passed: true });
    expect(await attempt(tracked(checker))).toEqual({
      checks: 1,
      passed: true,
    });
    expect(await attempt(tracked(nativeFile))).toEqual({
      checks: 0,
      passed: true,
    });
  });

  it("runs the complete check on a dirty tree and records no receipt", async () => {
    expect(await attempt(null)).toEqual({ checks: 1, passed: true });
    expect(await receiptNames()).toEqual([]);
    expect(await attempt()).toEqual({ checks: 1, passed: true });
    expect(await attempt(null)).toEqual({ checks: 1, passed: true });
    expect(await receiptNames()).toHaveLength(1);
  });

  it("runs the complete check for a malformed receipt or one planted for other bytes", async () => {
    expect(await attempt()).toEqual({ checks: 1, passed: true });
    const [name = ""] = await receiptNames();
    const path = join(receipts, name);
    const recorded = await readFile(path, "utf8");
    const decoded: unknown = JSON.parse(recorded);
    const other = {
      ...v.parse(v.record(v.string(), v.unknown()), decoded),
      files: v
        .parse(RecordedSchema, decoded)
        .files.map((file) =>
          file.file === "directory.sqlite"
            ? { ...file, sha256: "0".repeat(64) }
            : file,
        ),
    };
    for (const planted of [
      "{",
      recorded.replace('"passed"', '"skipped"'),
      JSON.stringify(other),
    ]) {
      await writeFile(path, planted);
      expect(await attempt()).toEqual({ checks: 1, passed: true });
      expect(await attempt()).toEqual({ checks: 0, passed: true });
    }
    const manifestSha256 = await fileDigest(
      join(bundle, "manifest.ready.json"),
    );
    await copyFile(
      path,
      join(
        receipts,
        `${dataCheckKey(tracked(), manifestSha256, "retained")}.json`,
      ),
    );
    expect(await attempt(tracked(), "retained")).toEqual({
      checks: 1,
      passed: true,
    });
  });

  it("records no receipt for a failed check", async () => {
    const path = join(bundle, "contacts.csv.gz");
    await writeFile(path, new Uint8Array([...(await readFile(path)), 0]));
    expect(await attempt()).toEqual({ checks: 1, passed: false });
    expect(await receiptNames()).toEqual([]);
  });

  it("records no receipt when the bundle changes during its check", async () => {
    const check = vi.fn(async (directory: string, forms?: ArchiveForms) => {
      const manifest = await checkDataBundle(directory, forms);
      await writeFile(join(directory, "catalog.json"), "{}");
      return manifest;
    });
    await expect(
      checkedDataBundle(bundle, "canonical", {
        sourceFiles: () => Promise.resolve(tracked()),
        receipts,
        check,
      }),
    ).rejects.toThrow("The dataset changed during its check");
    expect(check).toHaveBeenCalledOnce();
    expect(await receiptNames()).toEqual([]);
  });
});
