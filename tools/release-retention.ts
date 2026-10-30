import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";
import { canRetireResource } from "../src/core/publication-policy.ts";
import type { ReleaseJournal, ReleaseTarget } from "./release-lifecycle.ts";
import { activeVersion } from "./release-provider.ts";
import { ReleaseJournalSchema } from "./release-store.ts";

const commandArgumentOffset = 2;

export interface RetainedDatabase {
  readonly databaseId: string;
  readonly databaseSha256: string;
  readonly retireable: boolean;
  readonly active: boolean;
  readonly rollback: boolean;
  readonly pending: boolean;
}
export function databaseRetention(
  journals: readonly ReleaseJournal[],
  latest: ReleaseJournal,
  activeVersionId: string,
): readonly RetainedDatabase[] {
  const active = [latest.candidate, latest.previous].find(
    (target) => target?.versionId === activeVersionId,
  );
  if (!active)
    throw new Error(
      "Retention requires an active version bound to the current journal",
    );
  const rollback =
    latest.phase === "verified"
      ? latest.previous
      : (journals.find(
          (journal) =>
            journal.phase === "verified" &&
            journal.candidate.versionId === activeVersionId,
        )?.previous ?? null);
  const pending = journals
    .filter((journal) => !["verified", "recovered"].includes(journal.phase))
    .flatMap((journal) => [
      journal.candidate,
      ...(journal.previous ? [journal.previous] : []),
    ]);
  const targets = new Map<string, ReleaseTarget>();
  for (const journal of journals)
    for (const target of [
      journal.candidate,
      ...(journal.previous ? [journal.previous] : []),
    ]) {
      const found = targets.get(target.databaseId);
      if (found && found.databaseSha256 !== target.databaseSha256)
        throw new Error("Conflicting retained database identities");
      targets.set(target.databaseId, target);
    }
  return [...targets.values()].map((target) => {
    const isActive = target.databaseId === active.databaseId;
    const isRollback = target.databaseId === rollback?.databaseId;
    const isPending = pending.some(
      (pending) => pending.databaseId === target.databaseId,
    );
    return {
      databaseId: target.databaseId,
      databaseSha256: target.databaseSha256,
      active: isActive,
      rollback: isRollback,
      pending: isPending,
      retireable: canRetireResource(
        target.manifestBinding === "digest",
        isActive,
        isRollback,
        isPending,
      ),
    };
  });
}

async function main(args: readonly string[]): Promise<void> {
  const environment = v.parse(v.picklist(["staging", "production"]), args[0]);
  if (args.length !== 1)
    throw new Error("Usage: release-retention ENVIRONMENT");
  const directory = resolve(".local/releases");
  const latest = v.parse(
    ReleaseJournalSchema,
    JSON.parse(
      await readFile(resolve(directory, `${environment}-journal.json`), "utf8"),
    ),
  );
  const journals: ReleaseJournal[] = [];
  for (const name of await readdir(directory))
    if (
      name.startsWith(`${environment}-`) &&
      /^[a-z]+-[0-9a-f-]{36,40}\.json$/u.test(name)
    )
      journals.push(
        v.parse(
          ReleaseJournalSchema,
          JSON.parse(await readFile(resolve(directory, name), "utf8")),
        ),
      );
  journals.push(latest);
  console.info(
    JSON.stringify({
      operation: "publication.retention",
      environment,
      databases: databaseRetention(
        journals,
        latest,
        (await activeVersion(environment)).versionId,
      ),
      archives: "retained",
      mutation: false,
    }),
  );
}
if (process.argv[1] === resolve("tools/release-retention.ts"))
  await main(process.argv.slice(commandArgumentOffset));
