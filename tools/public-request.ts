import * as v from "valibot";
import { environments } from "../src/core/environment.ts";
import { versionHeader } from "../src/server/version-header.ts";

import {
  ledgerBudget,
  memoryBudget,
  type ProbeBudget,
  type ProbeClock,
  systemClock,
} from "./probe-budget.ts";

const requestTimeoutMs = 60000;
const versionWarmupPath = "/api/catalog";
const versionWarmupAttempts = 30;
const versionWarmupPauseMs = 1000;
export const consecutiveVersionAnswers = 3;
export const versionOverrideHeader = "Cloudflare-Workers-Version-Overrides";
const publicTarget = environments.production;

export const VersionModeSchema = v.picklist([
  "override",
  "required",
  "optional",
]);
export type VersionMode = v.InferOutput<typeof VersionModeSchema>;
export interface ExpectedVersion {
  readonly id: string;
  readonly mode: VersionMode;
}
export interface PublicAccess {
  readonly origin: string;
  readonly version: ExpectedVersion | null;
  readonly budget: ProbeBudget;
}

export class VersionMismatch extends Error {
  constructor() {
    super(
      "A public response came from a Worker version other than the one under verification",
    );
    this.name = "VersionMismatch";
  }
}

const budgets = new Map<string, ProbeBudget>();

function sharedBudget(ledger: string): ProbeBudget {
  const known = budgets.get(ledger);
  if (known) return known;
  const budget = ledger ? ledgerBudget(ledger) : memoryBudget();
  budgets.set(ledger, budget);
  return budget;
}

export function publicAccess(
  variables: NodeJS.ProcessEnv = process.env,
): PublicAccess {
  const id = variables.DIAL_PUBLIC_VERSION;
  const processBudget = sharedBudget(variables.DIAL_PROBE_LEDGER ?? "");
  return {
    origin: variables.DIAL_PUBLIC_ORIGIN ?? "",
    version: id
      ? {
          id: v.parse(v.pipe(v.string(), v.uuid()), id),
          mode: v.parse(VersionModeSchema, variables.DIAL_PUBLIC_VERSION_MODE),
        }
      : null,
    budget: processBudget,
  };
}

export function versionOverride(versionId: string): string {
  return `${publicTarget.worker}="${v.parse(v.pipe(v.string(), v.uuid()), versionId)}"`;
}

export function answersExpectedVersion(
  expected: ExpectedVersion | null,
  answered: string | null,
): boolean {
  if (!expected) return true;
  if (answered === null) return expected.mode === "optional";
  return answered === expected.id;
}

export async function checkedFetch(
  path: string | URL,
  init: RequestInit = {},
  access: PublicAccess = publicAccess(),
  transport: typeof fetch = fetch,
): Promise<Response> {
  if (access.origin !== publicTarget.origin)
    throw new Error("An exact configured public origin is required");
  const url = new URL(path, access.origin);
  if (url.origin !== access.origin || url.username || url.password)
    throw new Error(
      "Verification cannot forward requests outside its configured origin",
    );
  await access.budget.take();
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    for (const name of ["cookie", "authorization", versionOverrideHeader])
      headers.delete(name);
    if (access.version?.mode === "override")
      headers.set(versionOverrideHeader, versionOverride(access.version.id));
    headers.set("Accept-Encoding", "identity");
    response = await transport(url, {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new Error("Public verification request failed");
  }
  if (
    !answersExpectedVersion(access.version, response.headers.get(versionHeader))
  ) {
    await response.body?.cancel();
    throw new VersionMismatch();
  }
  return response;
}

export async function awaitExpectedVersion(
  access: PublicAccess = publicAccess(),
  transport: typeof fetch = fetch,
  clock: ProbeClock = systemClock,
): Promise<number> {
  let answers = 0;
  for (let attempt = 1; attempt <= versionWarmupAttempts; attempt += 1) {
    try {
      const response = await checkedFetch(
        versionWarmupPath,
        {},
        access,
        transport,
      );
      await response.body?.cancel();
      answers += 1;
      if (answers === consecutiveVersionAnswers) return attempt;
    } catch (error) {
      if (!(error instanceof VersionMismatch)) throw error;
      answers = 0;
      await clock.sleep(versionWarmupPauseMs);
    }
  }
  throw new Error(
    "The Worker version under verification didn't answer consecutive requests",
  );
}
