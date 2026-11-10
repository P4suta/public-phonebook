import { readFile } from "node:fs/promises";
import * as v from "valibot";

export const builtWorkerConfig =
  "apps/web/.cloudflare/output/v0/workers/default/worker.config.json";
const everyPath = "/*";

export type WorkerFirst = boolean | readonly string[];
export interface WorkerSettings {
  readonly domains: readonly string[];
  readonly runWorkerFirst: WorkerFirst;
  readonly workersDev: boolean;
  readonly previewUrls: boolean;
}
export interface CandidateWorkerSettings extends WorkerSettings {
  readonly unappliedTriggers: readonly string[];
}

const WorkerFirstSchema = v.union([v.boolean(), v.array(v.string())]);
const BuiltConfigSchema = v.looseObject({
  domains: v.optional(v.array(v.string()), []),
  routes: v.optional(v.array(v.unknown()), []),
  route: v.optional(v.unknown()),
  crons: v.optional(v.array(v.unknown()), []),
  triggers: v.optional(
    v.looseObject({ crons: v.optional(v.array(v.unknown()), []) }),
    {},
  ),
  assets: v.optional(
    v.looseObject({ runWorkerFirst: v.optional(WorkerFirstSchema, false) }),
    {},
  ),
  workersDev: v.optional(v.boolean(), false),
  previewUrls: v.optional(v.boolean(), false),
});

export function candidateWorkerSettings(
  config: unknown,
): CandidateWorkerSettings {
  const built = v.parse(BuiltConfigSchema, config);
  const unappliedTriggers = [
    ...(built.routes.length || built.route !== undefined ? ["routes"] : []),
    ...(built.crons.length || built.triggers.crons.length ? ["crons"] : []),
  ];
  return {
    domains: built.domains,
    runWorkerFirst: built.assets.runWorkerFirst,
    workersDev: built.workersDev,
    previewUrls: built.previewUrls,
    unappliedTriggers,
  };
}

export async function readCandidateWorkerSettings(
  path = builtWorkerConfig,
): Promise<CandidateWorkerSettings> {
  return candidateWorkerSettings(JSON.parse(await readFile(path, "utf8")));
}

export function runsWorkerFirst(value: WorkerFirst): boolean {
  return (
    value === true ||
    (Array.isArray(value) && value.length === 1 && value[0] === everyPath)
  );
}

function sameDomains(
  first: readonly string[],
  second: readonly string[],
): boolean {
  const normalize = (domains: readonly string[]): string =>
    JSON.stringify(
      [...new Set(domains.map((domain) => domain.toLowerCase()))].sort(),
    );
  return normalize(first) === normalize(second);
}

export function workerSettingChanges(
  candidate: CandidateWorkerSettings,
  live: WorkerSettings,
): readonly string[] {
  return [
    ...candidate.unappliedTriggers,
    ...(sameDomains(candidate.domains, live.domains) ? [] : ["domains"]),
    ...(runsWorkerFirst(candidate.runWorkerFirst) &&
    runsWorkerFirst(live.runWorkerFirst)
      ? []
      : ["runWorkerFirst"]),
    ...(candidate.workersDev === live.workersDev ? [] : ["workersDev"]),
    ...(candidate.previewUrls === live.previewUrls ? [] : ["previewUrls"]),
  ];
}

export function requireUnchangedWorkerSettings(
  candidate: CandidateWorkerSettings,
  live: WorkerSettings,
): void {
  const changes = workerSettingChanges(candidate, live);
  if (changes.length)
    throw new Error(
      `The candidate changes Worker-wide settings that a 0% version can't apply or check: ${changes.join(", ")}; the owner applies them separately`,
    );
}
