import { resolve } from "node:path";
import { cloudflare } from "@public-phonebook/cloudflare/cloudflare";
import type {
  ActiveVersion,
  DeployedVersions,
  ReleaseTarget,
} from "@public-phonebook/cloudflare/release-lifecycle";
import type { RemoteEnvironment } from "@public-phonebook/cloudflare/release-store";
import { environments } from "@public-phonebook/directory/environment";
import * as v from "valibot";
import { command } from "../../../tools/process.ts";
import {
  runsWorkerFirst,
  type WorkerFirst,
  type WorkerSettings,
} from "../../../tools/worker-settings.ts";

const fullTraffic = 100;
const noTraffic = 0;
export type CloudflareRunner = (args: readonly string[]) => Promise<unknown>;
export type CloudflareUploader = (args: readonly string[]) => Promise<void>;
export type { DeployedVersions } from "@public-phonebook/cloudflare/release-lifecycle";

const versionSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  annotations: v.optional(v.record(v.string(), v.string()), {}),
  assets: v.optional(
    v.object({
      config: v.optional(
        v.object({
          run_worker_first: v.optional(
            v.union([v.boolean(), v.array(v.string())]),
          ),
        }),
      ),
    }),
  ),
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
const WorkerSchema = v.object({
  references: v.object({
    domains: v.array(v.object({ hostname: v.string() })),
  }),
  subdomain: v.object({
    enabled: v.optional(v.boolean(), false),
    previews_enabled: v.optional(v.boolean(), false),
  }),
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

function workerFirst(
  version: v.InferOutput<typeof versionSchema>,
): WorkerFirst {
  const value = version.assets?.config?.run_worker_first;
  if (value === undefined)
    throw new Error(
      "The Worker version reports no Worker-first routing; check the provider's version response",
    );
  return value;
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

export async function liveWorkerSettings(
  environment: RemoteEnvironment,
  currentVersionId: string,
  run: CloudflareRunner = cloudflare,
): Promise<WorkerSettings> {
  const worker = v.parse(
    WorkerSchema,
    await run(["workers", "get", environments[environment].worker]),
  );
  const current = await workerVersion(environment, currentVersionId, run);
  return {
    domains: worker.references.domains.map((domain) => domain.hostname),
    runWorkerFirst: workerFirst(current),
    workersDev: worker.subdomain.enabled,
    previewUrls: worker.subdomain.previews_enabled,
  };
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

async function uploadWithCli(args: readonly string[]): Promise<void> {
  const result = await command(resolve("node_modules/.bin/cf"), args, true);
  if (result.code !== 0)
    throw new Error("Cloudflare didn't accept the candidate version upload");
}

export async function uploadVersion(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
  run: CloudflareRunner = cloudflare,
  upload: CloudflareUploader = uploadWithCli,
): Promise<string> {
  await upload([
    "workers",
    "versions",
    "create",
    "--prebuilt",
    "--mode",
    environment,
    "--tag",
    target.releaseId,
    "--message",
    target.sourceTree ?? "",
  ]);
  const version = await workerVersion(environment, "latest", run);
  if (version.annotations["workers/tag"] !== target.releaseId)
    throw new Error("The latest Worker version isn't this candidate's upload");
  if (!runsWorkerFirst(workerFirst(version)))
    throw new Error("The candidate version doesn't run the Worker first");
  return version.id;
}

async function deploy(
  environment: RemoteEnvironment,
  versions: readonly { readonly versionId: string; readonly share: number }[],
  run: CloudflareRunner,
): Promise<void> {
  await run([
    "workers",
    "deployments",
    "create",
    "--worker",
    environments[environment].worker,
    "--strategy",
    "percentage",
    "--versions",
    JSON.stringify(
      versions.map((version) => ({
        version_id: version.versionId,
        percentage: version.share,
      })),
    ),
  ]);
}

export async function deployCandidate(
  environment: RemoteEnvironment,
  currentVersionId: string,
  candidateVersionId: string,
  run: CloudflareRunner = cloudflare,
): Promise<void> {
  await deploy(
    environment,
    [
      { versionId: currentVersionId, share: fullTraffic },
      { versionId: candidateVersionId, share: noTraffic },
    ],
    run,
  );
}

export async function deployAlone(
  environment: RemoteEnvironment,
  versionId: string,
  run: CloudflareRunner = cloudflare,
): Promise<void> {
  await deploy(environment, [{ versionId, share: fullTraffic }], run);
}

export async function restoreVersion(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
  run: CloudflareRunner = cloudflare,
): Promise<void> {
  await verifyVersionBindings(environment, target, run);
  await deployAlone(environment, target.versionId, run);
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
