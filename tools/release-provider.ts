import * as v from "valibot";
import { environments } from "../src/core/environment.ts";
import { cloudflare } from "./cloudflare.ts";
import type { ActiveVersion, ReleaseTarget } from "./release-lifecycle.ts";
import type { RemoteEnvironment } from "./release-store.ts";

const fullTraffic = 100;
const noTraffic = 0;
export type CloudflareRunner = (args: readonly string[]) => Promise<unknown>;

const versionSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  annotations: v.optional(v.record(v.string(), v.string()), {}),
  bindings: v.array(
    v.object({
      name: v.string(),
      type: v.string(),
      text: v.optional(v.string()),
      database_id: v.optional(v.string()),
      id: v.optional(v.string()),
      bucket_name: v.optional(v.string()),
    }),
  ),
});
const TrafficSchema = v.array(
  v.object({
    version_id: v.pipe(v.string(), v.uuid()),
    percentage: v.number(),
  }),
);
const DeploymentListSchema = v.object({
  deployments: v.array(v.object({ id: v.string(), versions: TrafficSchema })),
});

export interface DeploymentTraffic {
  readonly current: string;
  readonly candidate: string | null;
}

export function deploymentTraffic(versions: unknown): DeploymentTraffic {
  const traffic = v.parse(TrafficSchema, versions);
  const current = traffic.filter((entry) => entry.percentage === fullTraffic);
  const candidates = traffic.filter((entry) => entry.percentage === noTraffic);
  const [serving] = current;
  const [candidate] = candidates;
  if (
    !serving ||
    current.length !== 1 ||
    candidates.length > 1 ||
    current.length + candidates.length !== traffic.length ||
    candidate?.version_id === serving.version_id
  )
    throw new Error(
      "The deployment must route 100% to one version and 0% to at most one other candidate",
    );
  return {
    current: serving.version_id,
    candidate: candidate?.version_id ?? null,
  };
}

export interface DeployedVersions {
  readonly current: ActiveVersion;
  readonly candidate: ActiveVersion | null;
}

async function workerVersion(
  environment: RemoteEnvironment,
  versionId: string,
  run: CloudflareRunner,
): Promise<v.InferOutput<typeof versionSchema>> {
  return v.parse(
    versionSchema,
    await run([
      "workers",
      "versions",
      "get",
      versionId,
      "--worker-id",
      environments[environment].worker,
    ]),
  );
}

function identity(version: v.InferOutput<typeof versionSchema>): ActiveVersion {
  return {
    versionId: version.id,
    releaseId: version.annotations["workers/tag"] ?? version.id,
  };
}

export async function deployedVersions(
  environment: RemoteEnvironment,
  run: CloudflareRunner = cloudflare,
): Promise<DeployedVersions> {
  const result = v.parse(
    DeploymentListSchema,
    await run([
      "workers",
      "deployments",
      "list",
      "--worker",
      environments[environment].worker,
      "--per-page",
      "1",
    ]),
  );
  const deployment = result.deployments[0];
  if (!deployment) throw new Error("The Worker has no active deployment");
  const traffic = deploymentTraffic(deployment.versions);
  return {
    current: identity(await workerVersion(environment, traffic.current, run)),
    candidate: traffic.candidate
      ? identity(await workerVersion(environment, traffic.candidate, run))
      : null,
  };
}

export async function activeVersion(
  environment: RemoteEnvironment,
  run: CloudflareRunner = cloudflare,
): Promise<ActiveVersion> {
  return (await deployedVersions(environment, run)).current;
}

export async function verifyVersionBindings(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
  run: CloudflareRunner = cloudflare,
): Promise<void> {
  const version = await workerVersion(environment, target.versionId, run);
  const database = version.bindings.find((binding) => binding.name === "DB");
  const bucket = version.bindings.find(
    (binding) => binding.name === "DATASETS",
  );
  const variables = new Map(
    version.bindings
      .filter((binding) => binding.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
  if (
    (database?.database_id ?? database?.id) !== target.databaseId ||
    bucket?.bucket_name !== environments[environment].bucket ||
    variables.get("APP_ENV") !== environment ||
    variables.get("PUBLIC_ORIGIN") !== environments[environment].origin ||
    (target.manifestBinding === "digest" &&
      variables.get("DATASET_MANIFEST_SHA256") !== target.manifestSha256)
  )
    throw new Error(
      "The Worker version has mismatched data or environment bindings",
    );
}

export async function restoreVersion(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
  run: CloudflareRunner = cloudflare,
): Promise<void> {
  await verifyVersionBindings(environment, target, run);
  await run([
    "workers",
    "deployments",
    "create",
    "--worker",
    environments[environment].worker,
    "--strategy",
    "percentage",
    "--versions",
    JSON.stringify([{ version_id: target.versionId, percentage: fullTraffic }]),
  ]);
}

export async function activeDatabaseId(
  environment: RemoteEnvironment,
  versionId: string,
  run: CloudflareRunner = cloudflare,
): Promise<string> {
  const version = await workerVersion(environment, versionId, run);
  const database = version.bindings.find((binding) => binding.name === "DB");
  return v.parse(
    v.pipe(v.string(), v.uuid()),
    database?.database_id ?? database?.id,
  );
}
