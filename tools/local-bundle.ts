import { resolve } from "node:path";

/** The prepared bundle that local checks read when no other is named. */
export const defaultBundle = ".local/phonebook";

/** Names the bundle that the local state serves, so browser checks compare the server with the same files. */
export const localBundleVariable = "DIAL_LOCAL_BUNDLE";

export function localBundle(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(environment[localBundleVariable] ?? defaultBundle);
}
