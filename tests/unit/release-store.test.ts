import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ReleaseJournal } from "../../tools/release-lifecycle.ts";
import {
  loadRelease,
  releaseLock,
  saveRelease,
} from "../../tools/release-store.ts";

const journal: ReleaseJournal = {
  phase: "verified",
  previous: null,
  candidate: {
    releaseId: "11111111-1111-4111-8111-111111111111",
    versionId: "11111111-1111-4111-8111-111111111111",
    databaseId: "22222222-2222-4222-8222-222222222222",
    sourceTree: "1".repeat(40),
    snapshot: "1".repeat(64),
    databaseSha256: "2".repeat(64),
    manifestSha256: "3".repeat(64),
    artifactSha256: "4".repeat(64),
    bundle: "fixture",
    manifestBinding: "digest",
  },
};
it("persists a complete journal atomically and rejects corrupt, unsupported and success-shaped incomplete records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phonebook-journal-"));
  try {
    expect(await loadRelease("staging", directory)).toBeNull();
    await saveRelease("staging", journal, directory);
    expect(await loadRelease("staging", directory)).toMatchObject(journal);
    for (const value of [
      { formatVersion: 2, ...journal },
      {
        formatVersion: 1,
        ...journal,
        candidate: { ...journal.candidate, versionId: "" },
      },
      { formatVersion: 1, ...journal, phase: "recovered" },
      {
        formatVersion: 1,
        ...journal,
        candidate: { ...journal.candidate, releaseId: "../../outside" },
      },
    ]) {
      await writeFile(
        join(directory, "staging-journal.json"),
        JSON.stringify(value),
      );
      await expect(loadRelease("staging", directory)).rejects.toThrow();
    }
    await saveRelease("staging", journal, directory);
    expect(
      JSON.parse(
        await readFile(join(directory, "staging-journal.json"), "utf8"),
      ),
    ).toMatchObject({ formatVersion: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("serializes publishers and releases its native lease for a later command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phonebook-lock-"));
  try {
    const release = await releaseLock("staging", directory);
    await expect(releaseLock("staging", directory)).rejects.toThrow();
    await release();
    const again = await releaseLock("staging", directory);
    await again();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
