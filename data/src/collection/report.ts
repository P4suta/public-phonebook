import { createHash } from "node:crypto";
import { DigestSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";
import type { ExtractedSource } from "./extract.ts";

const jsonIndentation = 2;

export const collectionReportFile = "collection-report.json";
export const collectionFiles = [
  "contacts.jsonl",
  "sources.json",
  "artifacts.json",
] as const;
export type CollectionFile = (typeof collectionFiles)[number];

const ByteCountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const FileIdentitySchema = v.strictObject({
  sha256: DigestSchema,
  bytes: ByteCountSchema,
});
export type FileIdentity = v.InferOutput<typeof FileIdentitySchema>;

export const CompleteCollectionReportSchema = v.object({
  complete: v.literal(true),
  contacts: ByteCountSchema,
  failures: v.pipe(v.array(v.unknown()), v.length(0)),
  files: v.strictObject({
    "contacts.jsonl": FileIdentitySchema,
    "sources.json": FileIdentitySchema,
    "artifacts.json": FileIdentitySchema,
  }),
});

export type PlanReport = Omit<ExtractedSource, "contacts"> & {
  readonly plan: string;
  readonly source: string;
  readonly contacts: number;
};

export interface CollectionOutcome {
  readonly registrySchools: number;
  readonly contacts: number;
  readonly conflicts: readonly {
    readonly id: string;
    readonly sources: readonly string[];
  }[];
  readonly coverage: ReadonlyMap<string, number>;
  readonly plans: readonly PlanReport[];
  readonly failures: readonly { readonly id: string; readonly error: string }[];
}

function byCodeUnits(first: string, second: string): number {
  return first < second ? -1 : first === second ? 0 : 1;
}

export function fileIdentity(bytes: Uint8Array): FileIdentity {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

export function encodeCollectionReport(
  outcome: CollectionOutcome,
  files: Readonly<Record<CollectionFile, FileIdentity>>,
): Uint8Array {
  const report = {
    complete: outcome.failures.length === 0,
    registrySchools: outcome.registrySchools,
    contacts: outcome.contacts,
    conflicts: outcome.conflicts.toSorted((first, second) =>
      byCodeUnits(first.id, second.id),
    ),
    coverage: Object.fromEntries(
      [...outcome.coverage].sort(([first], [second]) =>
        byCodeUnits(first, second),
      ),
    ),
    plans: outcome.plans.toSorted(
      (first, second) =>
        byCodeUnits(first.source, second.source) ||
        byCodeUnits(first.plan, second.plan),
    ),
    failures: outcome.failures.toSorted(
      (first, second) =>
        byCodeUnits(first.id, second.id) ||
        byCodeUnits(first.error, second.error),
    ),
    files,
  };
  return new TextEncoder().encode(
    `${JSON.stringify(report, null, jsonIndentation)}\n`,
  );
}
