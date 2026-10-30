import { describe, expect, it } from "vitest";
import {
  ownsUnverifiedBootstrap,
  type ReleaseJournal,
  type ReleasePorts,
  type ReleaseTarget,
  recoverRelease,
  resumeBootstrap,
  runRelease,
} from "../../tools/release-lifecycle.ts";

const previous: ReleaseTarget = {
  releaseId: "prior",
  versionId: "version-a",
  sourceTree: "tree-a",
  snapshot: "snapshot-a",
  databaseSha256: "database-a",
  databaseId: "database-id-a",
  manifestSha256: "manifest-a",
  artifactSha256: "artifact-a",
  bundle: "bundle-a",
  manifestBinding: "digest",
};
const candidate = {
  ...previous,
  releaseId: "candidate",
  versionId: "",
  sourceTree: "tree-b",
  snapshot: "snapshot-b",
  databaseSha256: "database-b",
  databaseId: "database-id-b",
  manifestSha256: "manifest-b",
  artifactSha256: "artifact-b",
  bundle: "bundle-b",
};
type Fault =
  | "none"
  | "prepare"
  | "activation-before"
  | "activation-after"
  | "verification"
  | "recovery"
  | "foreign";
function fixture(fault: Fault): {
  ports: ReleasePorts;
  active: () => string;
  journal: () => ReleaseJournal | undefined;
  verified: string[];
  clearFault: () => void;
} {
  let current = {
    versionId: previous.versionId,
    releaseId: previous.releaseId,
  };
  let saved: ReleaseJournal | undefined;
  const verified: string[] = [];
  const ports: ReleasePorts = {
    async save(journal): Promise<void> {
      saved = structuredClone(journal);
    },
    async prepare(): Promise<void> {
      if (fault === "prepare") throw new Error("preparation failed");
    },
    async active() {
      return current;
    },
    async activate(): Promise<void> {
      if (fault === "activation-before")
        throw new Error("activation failed before commit");
      current = { versionId: "version-b", releaseId: candidate.releaseId };
      if (fault === "activation-after")
        throw new Error("activation response lost");
    },
    async restore(target): Promise<void> {
      if (fault === "recovery") throw new Error("recovery unavailable");
      current = { versionId: target.versionId, releaseId: target.releaseId };
    },
    async verify(target): Promise<void> {
      if (target.releaseId === candidate.releaseId) {
        if (fault === "foreign")
          current = { versionId: "foreign-version", releaseId: "foreign" };
        if (["verification", "recovery"].includes(fault))
          throw new Error("verification failed");
      }
      verified.push(target.versionId);
    },
  };
  return {
    clearFault: (): void => {
      fault = "none";
    },
    ports,
    active: () => current.versionId,
    journal: () => saved,
    verified,
  };
}

describe("recoverable publication", () => {
  it("marks only a verified active candidate as complete", async () => {
    const f = fixture("none");
    const result = await runRelease(candidate, previous, f.ports);
    expect(result.phase).toBe("verified");
    expect(result.candidate.versionId).toBe("version-b");
    expect(f.active()).toBe("version-b");
    expect(f.verified).toEqual(["version-b"]);
  });
  for (const fault of [
    "prepare",
    "activation-before",
    "activation-after",
    "verification",
  ] as const)
    it(`preserves or restores the verified app and data after ${fault}`, async () => {
      const f = fixture(fault);
      await expect(runRelease(candidate, previous, f.ports)).rejects.toThrow();
      expect(f.active()).toBe(previous.versionId);
      expect(f.journal()?.phase).toBe("recovered");
      expect(f.verified).toContain(previous.versionId);
      expect(f.journal()?.previous).toEqual(previous);
    });
  it("keeps failed recovery pending and can safely resume it", async () => {
    const f = fixture("recovery");
    await expect(runRelease(candidate, previous, f.ports)).rejects.toThrow();
    const pending = f.journal();
    if (!pending) throw new Error("Missing pending journal");
    expect(pending.phase).toBe("recovering");
    expect(f.active()).toBe("version-b");
    f.clearFault();
    const recovered = await recoverRelease(pending, f.ports);
    expect(recovered.phase).toBe("recovered");
    const repeated = await recoverRelease(recovered, f.ports);
    expect(repeated.phase).toBe("recovered");
  });
  it("refuses to overwrite an unrelated concurrent deployment", async () => {
    const f = fixture("foreign");
    await expect(runRelease(candidate, previous, f.ports)).rejects.toThrow();
    expect(f.active()).toBe("foreign-version");
    expect(f.journal()?.phase).not.toBe("verified");
    expect(f.journal()?.phase).not.toBe("recovered");
  });
  it("requires a verified predecessor for ordinary publication", async () => {
    const f = fixture("none");
    await expect(runRelease(candidate, null, f.ports)).rejects.toThrow(
      "verified predecessor",
    );
    expect(f.active()).toBe(previous.versionId);
  });
  it("can finish verification of an owned initial deployment after a lost activation response", async () => {
    const f = fixture("activation-after");
    await expect(runRelease(candidate, null, f.ports, true)).rejects.toThrow(
      "recovery remains pending",
    );
    const pending = f.journal();
    if (!pending) throw new Error("Missing bootstrap journal");
    f.clearFault();
    const verified = await resumeBootstrap(pending, f.ports);
    expect(verified.phase).toBe("verified");
    expect(verified.candidate.versionId).toBe("version-b");
    await expect(resumeBootstrap(verified, f.ports)).rejects.toThrow();
  });
  it("lets corrected source supersede only an owned initial candidate that failed verification", async () => {
    const f = fixture("verification");
    await expect(runRelease(candidate, null, f.ports, true)).rejects.toThrow(
      "recovery remains pending",
    );
    const failed = f.journal();
    if (!failed) throw new Error("Missing failed bootstrap journal");
    const active = await f.ports.active();
    expect(ownsUnverifiedBootstrap(failed, active)).toBe(true);
    expect(
      ownsUnverifiedBootstrap({ ...failed, phase: "verified" }, active),
    ).toBe(false);
    expect(ownsUnverifiedBootstrap({ ...failed, previous }, active)).toBe(
      false,
    );
    expect(
      ownsUnverifiedBootstrap(failed, { ...active, releaseId: "foreign" }),
    ).toBe(false);
    expect(
      ownsUnverifiedBootstrap(failed, { ...active, versionId: "foreign" }),
    ).toBe(false);
  });
  it("never adopts a foreign version or an ordinary publication as an initial candidate", async () => {
    const f = fixture("none");
    const pending: ReleaseJournal = {
      candidate,
      previous: null,
      phase: "activating",
    };
    await expect(resumeBootstrap(pending, f.ports)).rejects.toThrow();
    expect(f.journal()).toBeUndefined();
    await f.ports.activate(candidate);
    await expect(
      resumeBootstrap({ ...pending, previous }, f.ports),
    ).rejects.toThrow();
    await expect(
      resumeBootstrap(
        { ...pending, candidate: { ...candidate, versionId: "another" } },
        f.ports,
      ),
    ).rejects.toThrow();
  });
});
