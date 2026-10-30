import { describe, expect, it } from "vitest";
import type {
  ReleaseJournal,
  ReleaseTarget,
} from "../../tools/release-lifecycle.ts";
import { databaseRetention } from "../../tools/release-retention.ts";

function target(version: string): ReleaseTarget {
  return {
    releaseId: version,
    versionId: version,
    sourceTree: "source",
    snapshot: version,
    databaseSha256: version,
    databaseId: version,
    manifestSha256: version,
    artifactSha256: version,
    bundle: version,
    manifestBinding: "digest",
  };
}
describe("publication retention", () => {
  it("protects active, preceding and interrupted data while identifying unused owned databases", () => {
    const old: ReleaseJournal = {
      phase: "verified",
      candidate: target("a"),
      previous: target("unused"),
    };
    const latest: ReleaseJournal = {
      phase: "verified",
      candidate: target("b"),
      previous: target("a"),
    };
    const pending: ReleaseJournal = {
      phase: "activating",
      candidate: target("pending"),
      previous: target("a"),
    };
    const plan = databaseRetention([old, latest, pending], latest, "b");
    expect(
      plan
        .filter((resource) => resource.retireable)
        .map((resource) => resource.databaseId),
    ).toEqual(["unused"]);
    expect(plan.find((resource) => resource.databaseId === "b")?.active).toBe(
      true,
    );
    expect(plan.find((resource) => resource.databaseId === "a")?.rollback).toBe(
      true,
    );
    expect(
      plan.find((resource) => resource.databaseId === "pending")?.pending,
    ).toBe(true);
  });
  it("retains the predecessor of a restored release and refuses unknown deployments", () => {
    const verified: ReleaseJournal = {
      phase: "verified",
      candidate: target("a"),
      previous: target("prior"),
    };
    const recovered: ReleaseJournal = {
      phase: "recovered",
      candidate: target("failed"),
      previous: target("a"),
    };
    const plan = databaseRetention([verified, recovered], recovered, "a");
    expect(
      plan.find((resource) => resource.databaseId === "prior")?.retireable,
    ).toBe(false);
    expect(() => databaseRetention([verified], verified, "foreign")).toThrow();
  });
  it("refuses conflicting ownership and never retires an adopted baseline", () => {
    const latest: ReleaseJournal = {
      phase: "verified",
      candidate: target("a"),
      previous: null,
    };
    const conflict: ReleaseJournal = {
      phase: "verified",
      candidate: { ...target("a"), databaseSha256: "different" },
      previous: null,
    };
    expect(() => databaseRetention([latest, conflict], latest, "a")).toThrow();
    const unowned: ReleaseJournal = {
      phase: "verified",
      candidate: { ...target("baseline"), manifestBinding: "snapshot" },
      previous: null,
    };
    expect(
      databaseRetention([latest, unowned], latest, "a").find(
        (resource) => resource.databaseId === "baseline",
      )?.retireable,
    ).toBe(false);
  });
});
