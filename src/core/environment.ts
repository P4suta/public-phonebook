import * as v from "valibot";
import { DigestSchema } from "./models.ts";

const databaseDigestWidth = 32;

export const EnvironmentSchema = v.picklist([
  "development",
  "staging",
  "production",
]);
export type Environment = v.InferOutput<typeof EnvironmentSchema>;

export const environments = {
  development: {
    worker: "dial-development",
    origin: "http://localhost:8787",
    database: "dial-development-directory",
    bucket: "dial-development-datasets",
    domains: [],
  },
  staging: {
    worker: "dial-staging",
    origin: "https://staging.dial.page",
    database: "dial-staging-directory",
    bucket: "dial-staging-datasets",
    domains: ["staging.dial.page"],
  },
  production: {
    worker: "dial-production",
    origin: "https://www.dial.page",
    database: "dial-production-directory",
    bucket: "dial-production-datasets",
    domains: ["www.dial.page"],
  },
} satisfies Record<
  Environment,
  {
    worker: string;
    origin: string;
    database: string;
    bucket: string;
    domains: string[];
  }
>;

export function deploymentEnvironment(mode: string | undefined): Environment {
  return v.parse(EnvironmentSchema, mode ?? "development");
}

export function databaseResourceName(
  environment: Environment,
  databaseSha256?: string,
): string {
  const target = environments[environment];
  if (environment === "development") return target.database;
  const digest = v.parse(DigestSchema, databaseSha256);
  return `${target.database}-${digest.slice(0, databaseDigestWidth)}`;
}
