import fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  type CollectionOutcome,
  CompleteCollectionReportSchema,
  encodeCollectionReport,
  fileIdentity,
  type PlanReport,
} from "../../tools/collection/report.ts";

const encoder = new TextEncoder();
const files = {
  "contacts.jsonl": fileIdentity(encoder.encode("contacts\n")),
  "sources.json": fileIdentity(encoder.encode("[]\n")),
  "artifacts.json": fileIdentity(encoder.encode("[]\n")),
};

function plan(source: string): PlanReport {
  return {
    plan: source.split(":")[0] ?? source,
    source,
    contacts: source.length,
    rows: source.length,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
    unmatched: [],
  };
}

function outcome(sources: readonly string[]): CollectionOutcome {
  return {
    registrySchools: 3,
    contacts: sources.length,
    conflicts: sources.map((id) => ({ id, sources: [id] })),
    coverage: new Map(sources.map((id) => [`13:${id}`, id.length])),
    plans: sources.map(plan),
    failures: [],
  };
}

function reversed(input: CollectionOutcome): CollectionOutcome {
  return {
    ...input,
    conflicts: input.conflicts.toReversed(),
    coverage: new Map([...input.coverage].toReversed()),
    plans: input.plans.toReversed(),
    failures: input.failures.toReversed(),
  };
}

describe("collection report", () => {
  it("writes the same bytes whichever order the sources finish in", () => {
    const sourceIds = fc.uniqueArray(
      fc.stringMatching(/^[a-z]{1,3}:[0-9a-f]{1,4}$/u),
      { minLength: 1, maxLength: 12 },
    );
    fc.assert(
      fc.property(
        sourceIds.chain((ids) =>
          fc.tuple(
            fc.constant(ids),
            fc.shuffledSubarray(ids, {
              minLength: ids.length,
              maxLength: ids.length,
            }),
          ),
        ),
        ([ids, shuffled]) => {
          expect(encodeCollectionReport(outcome(shuffled), files)).toEqual(
            encodeCollectionReport(outcome(ids), files),
          );
        },
      ),
      { seed: 20261102, numRuns: 300 },
    );
    const failing = {
      ...outcome(["b:1", "a:2"]),
      failures: [
        { id: "b", error: "HTTP 503" },
        { id: "a", error: "HTTP 404" },
      ],
    };
    expect(encodeCollectionReport(reversed(failing), files)).toEqual(
      encodeCollectionReport(failing, files),
    );
  });

  it("records each output digest and admits only a complete report", () => {
    const complete: unknown = JSON.parse(
      new TextDecoder().decode(encodeCollectionReport(outcome(["a:1"]), files)),
    );
    expect(v.parse(CompleteCollectionReportSchema, complete).files).toEqual(
      files,
    );
    const incomplete: unknown = JSON.parse(
      new TextDecoder().decode(
        encodeCollectionReport(
          { ...outcome(["a:1"]), failures: [{ id: "a", error: "timeout" }] },
          files,
        ),
      ),
    );
    expect(v.is(CompleteCollectionReportSchema, incomplete)).toBe(false);
    expect(
      v.is(CompleteCollectionReportSchema, {
        complete: true,
        contacts: 0,
        failures: [],
      }),
    ).toBe(false);
  });
});
