import * as v from "valibot";
import { environments } from "../src/core/environment.ts";
import { cloudflare } from "./cloudflare.ts";
import type { ActiveVersion, ReleaseTarget } from "./release-lifecycle.ts";
import type { RemoteEnvironment } from "./release-store.ts";

const fullTraffic = 100;
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
export async function activeVersion(
  environment: RemoteEnvironment,
): Promise<ActiveVersion> {
  const result = v.parse(
    v.object({
      deployments: v.array(
        v.object({
          id: v.string(),
          versions: v.tuple([
            v.object({
              version_id: v.pipe(v.string(), v.uuid()),
              percentage: v.literal(fullTraffic),
            }),
          ]),
        }),
      ),
    }),
    await cloudflare([
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
  const version = v.parse(
    versionSchema,
    await cloudflare([
      "workers",
      "versions",
      "get",
      deployment.versions[0].version_id,
      "--worker-id",
      environments[environment].worker,
    ]),
  );
  return {
    versionId: version.id,
    releaseId: version.annotations["workers/tag"] ?? version.id,
  };
}
export async function verifyVersionBindings(
  environment: RemoteEnvironment,
  target: ReleaseTarget,
): Promise<void> {
  const version = v.parse(
    versionSchema,
    await cloudflare([
      "workers",
      "versions",
      "get",
      target.versionId,
      "--worker-id",
      environments[environment].worker,
    ]),
  );
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
): Promise<void> {
  await verifyVersionBindings(environment, target);
  await cloudflare([
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
): Promise<string> {
  const version = v.parse(
    versionSchema,
    await cloudflare([
      "workers",
      "versions",
      "get",
      versionId,
      "--worker-id",
      environments[environment].worker,
    ]),
  );
  const database = version.bindings.find((binding) => binding.name === "DB");
  return v.parse(
    v.pipe(v.string(), v.uuid()),
    database?.database_id ?? database?.id,
  );
}
