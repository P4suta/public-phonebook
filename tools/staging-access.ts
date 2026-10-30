import { spawn } from "node:child_process";
import { resolve } from "node:path";
import * as v from "valibot";
import { environments } from "../src/core/environment.ts";
import { cloudflare } from "./cloudflare.ts";
import { command } from "./process.ts";

const staging = environments.staging;
const applicationName = "Public Phonebook staging";
const tokenName = "Public Phonebook staging verification";
const uploadInput = "/dev/stdin";
const policyCount = 2;
const automationPrecedence = 2;
const commandArgumentOffset = 2;
const requiredArgumentCount = 3;
const emailSchema = v.pipe(v.string(), v.email());
const nonempty = v.pipe(v.string(), v.minLength(1));
const tokenSchema = v.object({
  id: nonempty,
  client_id: nonempty,
  expires_at: nonempty,
});

async function storeSecrets(
  values: Readonly<Record<string, string>>,
): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      "doppler",
      [
        "secrets",
        "upload",
        uploadInput,
        "--silent",
        "--project",
        "public-phonebook",
        "--config",
        "stg",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    child.stderr?.resume();
    child.once("error", (): void =>
      reject(new Error("Doppler staging settings could not be stored")),
    );
    child.once("close", (code): void =>
      code === 0
        ? accept()
        : reject(new Error("Doppler staging settings could not be stored")),
    );
    child.stdin.end(JSON.stringify(values));
  });
}

export async function validateStagingStorage(): Promise<void> {
  v.parse(
    v.object({ enabled: v.literal(false) }),
    await cloudflare([
      "r2",
      "buckets",
      "domains",
      "managed",
      "list",
      "--bucket-name",
      staging.bucket,
    ]),
  );
  v.parse(
    v.object({ domains: v.array(v.never()) }),
    await cloudflare([
      "r2",
      "buckets",
      "domains",
      "custom",
      "list",
      "--bucket-name",
      staging.bucket,
    ]),
  );
}

export async function validateStagingApplication(): Promise<void> {
  const id = v.parse(nonempty, process.env.ACCESS_APPLICATION_ID);
  const tokenId = v.parse(nonempty, process.env.ACCESS_SERVICE_TOKEN_ID);
  const reviewers = v.parse(
    v.array(emailSchema),
    JSON.parse(process.env.ACCESS_REVIEWERS ?? "null"),
  );
  const application = v.parse(
    v.object({
      id: v.literal(id),
      domain: v.literal(new URL(staging.origin).hostname),
      type: v.literal("self_hosted"),
      aud: v.literal(v.parse(nonempty, process.env.ACCESS_AUDIENCE)),
      options_preflight_bypass: v.optional(v.literal(false)),
      policies: v.array(
        v.object({
          decision: v.picklist(["allow", "non_identity"]),
          include: v.array(v.unknown()),
          exclude: v.optional(v.array(v.never())),
          require: v.optional(v.array(v.never())),
        }),
      ),
    }),
    await cloudflare(["zero-trust", "access", "applications", "get", id]),
  );
  if (application.policies.length !== policyCount)
    throw new Error(
      "Staging must have exactly its reviewer and automation policies",
    );
  const human = application.policies.find(
    (policy) => policy.decision === "allow",
  );
  const automation = application.policies.find(
    (policy) => policy.decision === "non_identity",
  );
  const emails = v
    .parse(
      v.array(v.object({ email: v.object({ email: emailSchema }) })),
      human?.include,
    )
    .map((rule) => rule.email.email)
    .sort();
  if (JSON.stringify(emails) !== JSON.stringify([...reviewers].sort()))
    throw new Error("Staging reviewers differ from the configured allowlist");
  v.parse(
    v.tuple([
      v.object({ service_token: v.object({ token_id: v.literal(tokenId) }) }),
    ]),
    automation?.include,
  );
  const token = v.parse(
    tokenSchema,
    await cloudflare([
      "zero-trust",
      "access",
      "service-tokens",
      "get",
      tokenId,
    ]),
  );
  if (
    token.client_id !== process.env.ACCESS_SERVICE_CLIENT_ID ||
    Date.parse(token.expires_at) <= Date.now()
  )
    throw new Error("The staging service identity is mismatched or expired");
  await validateStagingStorage();
  v.parse(
    v.object({
      subdomain: v.object({
        enabled: v.literal(false),
        previews_enabled: v.literal(false),
      }),
    }),
    await cloudflare(["workers", "get", staging.worker]),
  );
}

async function configure(): Promise<void> {
  const organization = v.parse(
    v.object({ auth_domain: nonempty }),
    await cloudflare(["zero-trust", "organization", "get"]),
  );
  const owner = v.parse(
    v.object({ email: emailSchema }),
    await cloudflare(["user", "get"]),
  );
  const identityProviders = v.parse(
    v.array(v.object({ id: nonempty, type: nonempty })),
    await cloudflare(["zero-trust", "identity-providers", "list"]),
  );
  const otp = identityProviders.find(
    (provider) => provider.type === "onetimepin",
  );
  if (!otp)
    throw new Error("An existing one-time PIN identity provider is required");
  await validateStagingStorage();
  let tokenId = process.env.ACCESS_SERVICE_TOKEN_ID;
  let clientId = process.env.ACCESS_SERVICE_CLIENT_ID;
  if (!tokenId || !clientId || !process.env.ACCESS_SERVICE_CLIENT_SECRET) {
    if (tokenId || clientId || process.env.ACCESS_SERVICE_CLIENT_SECRET)
      throw new Error("Incomplete staging credentials require explicit repair");
    const result = await command(
      resolve("node_modules/.bin/cf"),
      [
        "zero-trust",
        "access",
        "service-tokens",
        "create",
        "--name",
        tokenName,
        "--duration",
        "2160h",
      ],
      true,
    );
    if (result.code !== 0)
      throw new Error("The staging service identity could not be created");
    const token = v.parse(
      v.object({ ...tokenSchema.entries, client_secret: nonempty }),
      JSON.parse(result.stdout),
    );
    tokenId = token.id;
    clientId = token.client_id;
    await storeSecrets({
      ACCESS_SERVICE_TOKEN_ID: token.id,
      ACCESS_SERVICE_CLIENT_ID: token.client_id,
      ACCESS_SERVICE_CLIENT_SECRET: token.client_secret,
    });
  }
  const applications = v.parse(
    v.array(v.object({ id: nonempty, domain: v.optional(v.string()) })),
    await cloudflare(["zero-trust", "access", "applications", "list"]),
  );
  const matching = applications.filter(
    (application) => application.domain === new URL(staging.origin).hostname,
  );
  if (matching.length > 1)
    throw new Error("Ambiguous staging Access applications");
  const existing = matching[0];
  const app = v.parse(
    v.object({ id: nonempty, aud: nonempty }),
    existing
      ? await cloudflare([
          "zero-trust",
          "access",
          "applications",
          "get",
          existing.id,
        ])
      : await cloudflare([
          "zero-trust",
          "access",
          "applications",
          "create",
          "--body",
          JSON.stringify({
            name: applicationName,
            domain: new URL(staging.origin).hostname,
            type: "self_hosted",
            session_duration: "4h",
            allowed_idps: [otp.id],
            auto_redirect_to_identity: true,
            options_preflight_bypass: false,
            http_only_cookie_attribute: true,
            same_site_cookie_attribute: "lax",
            policies: [
              {
                name: "Staging owner",
                decision: "allow",
                precedence: 1,
                include: [{ email: { email: owner.email } }],
              },
              {
                name: "Staging verification",
                decision: "non_identity",
                precedence: automationPrecedence,
                include: [{ service_token: { token_id: tokenId } }],
              },
            ],
          }),
        ]),
  );
  await storeSecrets({
    ACCESS_APPLICATION_ID: app.id,
    ACCESS_AUDIENCE: app.aud,
    ACCESS_ISSUER: `https://${organization.auth_domain}`,
    ACCESS_REVIEWERS: JSON.stringify([owner.email.toLowerCase()]),
    CLOUDFLARE_ACCOUNT_ID: v.parse(nonempty, process.env.CLOUDFLARE_ACCOUNT_ID),
  });
  console.info(
    JSON.stringify({
      operation: "staging.access.configure",
      origin: staging.origin,
      result: "configured",
    }),
  );
}

if (process.argv[1] === resolve("tools/staging-access.ts")) {
  const action = process.argv[commandArgumentOffset];
  if (
    process.argv.length !== requiredArgumentCount ||
    (action !== "configure" && action !== "check")
  )
    throw new Error("Usage: staging-access configure|check");
  if (action === "configure") await configure();
  else {
    await validateStagingApplication();
    console.info(
      JSON.stringify({ operation: "staging.access.check", result: "verified" }),
    );
  }
}
