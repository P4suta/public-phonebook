import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import type { ReleaseJournal } from "./release-lifecycle.ts";

const sourceTree = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u));
const nonempty = v.pipe(v.string(), v.minLength(1));
const jsonIndentation = 2;
const privateMode = 0o600;
const leaseStaleMs = 60000;
const leaseUpdateMs = 10000;
const journalFormat = 1;
export const ReleaseTargetSchema = v.pipe(
  v.object({
    releaseId: v.pipe(v.string(), v.uuid()),
    versionId: v.union([v.literal(""), v.pipe(v.string(), v.uuid())]),
    sourceTree: v.nullable(sourceTree),
    snapshot: DigestSchema,
    databaseSha256: DigestSchema,
    databaseId: v.pipe(v.string(), v.uuid()),
    manifestSha256: DigestSchema,
    artifactSha256: v.nullable(DigestSchema),
    bundle: nonempty,
    manifestBinding: v.picklist(["snapshot", "digest"]),
  }),
  v.check(
    (target) =>
      target.manifestBinding === "snapshot" ||
      (target.sourceTree !== null && target.artifactSha256 !== null),
  ),
);
export const ReleaseJournalSchema = v.pipe(
  v.object({
    formatVersion: v.literal(journalFormat),
    phase: v.picklist([
      "preparing",
      "activating",
      "checking",
      "recovering",
      "verified",
      "recovered",
    ]),
    candidate: ReleaseTargetSchema,
    previous: v.nullable(ReleaseTargetSchema),
  }),
  v.check(
    (journal) =>
      (journal.phase !== "verified" || journal.candidate.versionId !== "") &&
      (journal.phase !== "recovered" || journal.previous !== null) &&
      (!journal.previous || journal.previous.versionId !== ""),
  ),
);
export type RemoteEnvironment = "staging" | "production";

export async function saveRelease(
  environment: RemoteEnvironment,
  journal: ReleaseJournal,
  directory = resolve(".local/releases"),
): Promise<void> {
  const value = v.parse(ReleaseJournalSchema, {
    formatVersion: journalFormat,
    ...journal,
  });
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${randomUUID()}.partial`);
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(value, null, jsonIndentation)}\n`,
      { flag: "wx", mode: privateMode, flush: true },
    );
    await rename(temporary, join(directory, `${environment}-journal.json`));
    await writeFile(
      join(directory, `${environment}-${journal.candidate.releaseId}.json`),
      `${JSON.stringify(value, null, jsonIndentation)}\n`,
      { mode: privateMode, flush: true },
    );
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function loadRelease(
  environment: RemoteEnvironment,
  directory = resolve(".local/releases"),
): Promise<ReleaseJournal | null> {
  try {
    return v.parse(
      ReleaseJournalSchema,
      JSON.parse(
        await readFile(join(directory, `${environment}-journal.json`), "utf8"),
      ),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
export async function releaseLock(
  environment: RemoteEnvironment | "build",
  directory = join(homedir(), ".local/state/public-phonebook/locks"),
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  return lock(join(directory, environment), {
    realpath: false,
    stale: leaseStaleMs,
    update: leaseUpdateMs,
    retries: 0,
  });
}
