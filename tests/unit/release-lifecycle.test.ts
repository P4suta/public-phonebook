import { describe, expect, it } from "vitest";
import {
  CandidateWithdrawn,
  type DeployedVersions,
  drillWithdrawal,
  PromotionRefused,
  promoteCandidate,
  type ReleaseJournal,
  type ReleasePorts,
  type ReleaseTarget,
  recoverPublication,
  recoverRelease,
  stageCandidate,
  verifiedPredecessor,
  verifyStagedCandidate,
  withdrawCandidate,
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
  manifestBinding: "digest",
};
const candidate: ReleaseTarget = {
  ...previous,
  releaseId: "candidate",
  versionId: "",
  sourceTree: "tree-b",
  snapshot: "snapshot-b",
  databaseSha256: "database-b",
  databaseId: "database-id-b",
  manifestSha256: "manifest-b",
  artifactSha256: "artifact-b",
};
const stagedVersion = "version-b";
type Fault =
  | "none"
  | "prepare"
  | "stage-before"
  | "stage-after"
  | "candidate-check"
  | "withdrawal"
  | "activation-before"
  | "activation-after"
  | "verification"
  | "recovery"
  | "foreign";

function fixture(initial: Fault): {
  ports: ReleasePorts;
  deployment: () => DeployedVersions;
  replace: (deployment: DeployedVersions) => void;
  saved: ReleaseJournal[];
  checks: string[];
  clearFault: () => void;
} {
  let fault = initial;
  let deployment: DeployedVersions = {
    current: { versionId: previous.versionId, releaseId: previous.releaseId },
    candidate: null,
  };
  const saved: ReleaseJournal[] = [];
  const checks: string[] = [];
  const ports: ReleasePorts = {
    async save(journal): Promise<void> {
      saved.push(structuredClone(journal));
    },
    async deployed() {
      return structuredClone(deployment);
    },
    async prepare(): Promise<void> {
      if (fault === "prepare") throw new Error("preparation failed");
    },
    async stage(target, current): Promise<void> {
      if (fault === "stage-before") throw new Error("upload failed");
      deployment = {
        current: { versionId: current.versionId, releaseId: current.releaseId },
        candidate: { versionId: stagedVersion, releaseId: target.releaseId },
      };
      if (fault === "stage-after") throw new Error("deployment response lost");
    },
    async withdraw(current): Promise<void> {
      if (fault === "withdrawal") throw new Error("withdrawal forbidden");
      deployment = {
        current: { versionId: current.versionId, releaseId: current.releaseId },
        candidate: null,
      };
    },
    async activate(target): Promise<void> {
      if (fault === "activation-before")
        throw new Error("activation failed before commit");
      deployment = {
        current: { versionId: target.versionId, releaseId: target.releaseId },
        candidate: null,
      };
      if (fault === "activation-after")
        throw new Error("activation response lost");
    },
    async restore(target): Promise<void> {
      if (fault === "recovery") throw new Error("recovery unavailable");
      deployment = {
        current: { versionId: target.versionId, releaseId: target.releaseId },
        candidate: null,
      };
    },
    async verifyCandidate(target): Promise<void> {
      if (fault === "candidate-check")
        throw new Error("candidate probe failed");
      checks.push(`override:${target.versionId}`);
    },
    async verify(target, evidence): Promise<void> {
      if (target.releaseId === candidate.releaseId) {
        if (fault === "foreign")
          deployment = {
            current: { versionId: "foreign-version", releaseId: "foreign" },
            candidate: null,
          };
        if (fault === "verification" || fault === "recovery")
          throw new Error("verification failed");
      }
      checks.push(`${evidence}:${target.versionId}`);
    },
  };
  return {
    ports,
    deployment: () => deployment,
    replace: (next): void => {
      deployment = next;
    },
    saved,
    checks,
    clearFault: (): void => {
      fault = "none";
    },
  };
}

async function awaitingApproval(
  f: ReturnType<typeof fixture>,
): Promise<ReleaseJournal> {
  return verifyStagedCandidate(
    await stageCandidate(candidate, previous, f.ports),
    f.ports,
  );
}

describe("candidate staging", () => {
  it("deploys the candidate at 0% beside the verified predecessor and records its version", async () => {
    const f = fixture("none");
    const staged = await stageCandidate(candidate, previous, f.ports);
    expect(staged.phase).toBe("staged");
    expect(staged.candidate.versionId).toBe(stagedVersion);
    expect(f.saved.map((journal) => journal.phase)).toEqual([
      "preparing",
      "staged",
    ]);
    expect(f.deployment()).toEqual({
      current: { versionId: previous.versionId, releaseId: previous.releaseId },
      candidate: { versionId: stagedVersion, releaseId: candidate.releaseId },
    });
  });

  it("checks the candidate through the override and leaves it awaiting approval", async () => {
    const f = fixture("none");
    const verified = await awaitingApproval(f);
    expect(verified.phase).toBe("candidate-verified");
    expect(f.checks).toEqual([`override:${stagedVersion}`]);
    expect(f.deployment().current.versionId).toBe(previous.versionId);
    expect(() => verifiedPredecessor(verified)).toThrow("awaits approval");
  });

  for (const fault of [
    "prepare",
    "stage-before",
    "stage-after",
    "candidate-check",
  ] as const)
    it(`withdraws the candidate after a ${fault} failure without moving traffic`, async () => {
      const f = fixture(fault);
      const error = await awaitingApproval(f).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CandidateWithdrawn);
      expect(f.deployment()).toEqual({
        current: {
          versionId: previous.versionId,
          releaseId: previous.releaseId,
        },
        candidate: null,
      });
      const last = f.saved.at(-1);
      expect(last?.phase).toBe("withdrawn");
      expect(verifiedPredecessor(last ?? null)).toEqual(previous);
      expect(f.saved.some((journal) => journal.phase === "verified")).toBe(
        false,
      );
    });

  it("keeps a forbidden withdrawal pending, and a later withdrawal completes it", async () => {
    const f = fixture("candidate-check");
    const staged = await stageCandidate(candidate, previous, f.ports);
    const error = await verifyStagedCandidate(staged, {
      ...f.ports,
      withdraw: async (): Promise<void> => {
        throw new Error("the read-only token can't deploy");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    const pending = f.saved.at(-1);
    if (!pending) throw new Error("Missing pending withdrawal");
    expect(pending.phase).toBe("withdrawing");
    expect(f.deployment().candidate?.versionId).toBe(stagedVersion);
    expect(() => verifiedPredecessor(pending)).toThrow("requires recovery");
    const withdrawn = await withdrawCandidate(pending, f.ports);
    expect(withdrawn.phase).toBe("withdrawn");
    expect(f.deployment().candidate).toBeNull();
    const repeated = await withdrawCandidate(withdrawn, f.ports);
    expect(repeated).toEqual(withdrawn);
  });

  it("refuses a new candidate while another one is deployed at 0% or the predecessor isn't serving", async () => {
    const f = fixture("none");
    f.replace({
      current: { versionId: previous.versionId, releaseId: previous.releaseId },
      candidate: { versionId: "waiting", releaseId: "earlier-candidate" },
    });
    await expect(stageCandidate(candidate, previous, f.ports)).rejects.toThrow(
      "already deployed at 0%",
    );
    f.replace({
      current: { versionId: "foreign-version", releaseId: "foreign" },
      candidate: null,
    });
    await expect(stageCandidate(candidate, previous, f.ports)).rejects.toThrow(
      "verified predecessor",
    );
    expect(f.saved).toEqual([]);
  });

  it("refuses to withdraw a foreign candidate or a release that took traffic", async () => {
    const f = fixture("none");
    const staged = await stageCandidate(candidate, previous, f.ports);
    f.replace({
      current: { versionId: previous.versionId, releaseId: previous.releaseId },
      candidate: { versionId: "foreign-version", releaseId: "foreign" },
    });
    const before = f.saved.length;
    await expect(withdrawCandidate(staged, f.ports)).rejects.toThrow(
      "Withdrawal requires",
    );
    await expect(
      withdrawCandidate({ ...staged, phase: "checking" }, f.ports),
    ).rejects.toThrow("Withdrawal requires");
    expect(f.saved).toHaveLength(before);
  });
});

describe("approved promotion", () => {
  it("moves the approved candidate from 0% to 100% in one step and checks it without the override", async () => {
    const f = fixture("none");
    const verified = await awaitingApproval(f);
    const result = await promoteCandidate(
      verified,
      candidate.releaseId,
      f.ports,
    );
    expect(result.phase).toBe("verified");
    expect(f.deployment()).toEqual({
      current: { versionId: stagedVersion, releaseId: candidate.releaseId },
      candidate: null,
    });
    expect(f.checks).toEqual([
      `override:${stagedVersion}`,
      `required:${stagedVersion}`,
    ]);
    expect(verifiedPredecessor(result)?.versionId).toBe(stagedVersion);
  });

  it("refuses an unverified, displaced, removed, or different candidate and another release", async () => {
    const f = fixture("none");
    const verified = await awaitingApproval(f);
    const before = f.saved.length;
    const staged = f.deployment();
    const cases: readonly [ReleaseJournal, DeployedVersions, string][] = [
      [{ ...verified, phase: "staged" }, staged, "unverified"],
      [
        verified,
        { ...staged, current: { versionId: "other", releaseId: "other" } },
        "current-changed",
      ],
      [verified, { ...staged, candidate: null }, "candidate-missing"],
      [
        verified,
        {
          ...staged,
          candidate: { versionId: "replaced", releaseId: candidate.releaseId },
        },
        "different-version",
      ],
    ];
    for (const [journal, deployment, admission] of cases) {
      f.replace(deployment);
      const error = await promoteCandidate(
        journal,
        candidate.releaseId,
        f.ports,
      ).catch((caught: unknown) => caught);
      expect(error, admission).toBeInstanceOf(PromotionRefused);
      if (error instanceof PromotionRefused)
        expect(error.admission).toBe(admission);
    }
    f.replace(staged);
    await expect(
      promoteCandidate(verified, "another", f.ports),
    ).rejects.toThrow("release other than the candidate");
    expect(f.saved).toHaveLength(before);
    expect(f.deployment()).toEqual(staged);
  });

  for (const fault of [
    "activation-before",
    "activation-after",
    "verification",
  ] as const)
    it(`restores and rechecks the verified predecessor after ${fault}`, async () => {
      const f = fixture("none");
      const verified = await awaitingApproval(f);
      const failing = fixture(fault);
      failing.replace(f.deployment());
      await expect(
        promoteCandidate(verified, candidate.releaseId, failing.ports),
      ).rejects.toThrow("verified predecessor was restored");
      expect(failing.deployment()).toEqual({
        current: {
          versionId: previous.versionId,
          releaseId: previous.releaseId,
        },
        candidate: null,
      });
      expect(failing.saved.at(-1)?.phase).toBe("recovered");
      expect(failing.checks).toContain(`optional:${previous.versionId}`);
    });

  it("keeps failed recovery pending and can resume it", async () => {
    const f = fixture("none");
    const verified = await awaitingApproval(f);
    const failing = fixture("recovery");
    failing.replace(f.deployment());
    await expect(
      promoteCandidate(verified, candidate.releaseId, failing.ports),
    ).rejects.toThrow("recovery remains pending");
    const pending = failing.saved.at(-1);
    if (!pending) throw new Error("Missing pending journal");
    expect(pending.phase).toBe("recovering");
    expect(failing.deployment().current.versionId).toBe(stagedVersion);
    failing.clearFault();
    const recovered = await recoverPublication(pending, failing.ports);
    expect(recovered.phase).toBe("recovered");
    expect((await recoverRelease(recovered, failing.ports)).phase).toBe(
      "recovered",
    );
  });

  it("refuses to overwrite an unrelated concurrent deployment", async () => {
    const f = fixture("none");
    const verified = await awaitingApproval(f);
    const foreign = fixture("foreign");
    foreign.replace(f.deployment());
    await expect(
      promoteCandidate(verified, candidate.releaseId, foreign.ports),
    ).rejects.toThrow("recovery remains pending");
    expect(foreign.deployment().current.versionId).toBe("foreign-version");
    expect(foreign.saved.at(-1)?.phase).toBe("recovering");
  });
});

describe("interrupted publications", () => {
  it("withdraws an interrupted candidate, leaves an awaiting candidate to the owner, and never recovers a 0% candidate by restoring", async () => {
    const f = fixture("none");
    const staged = await stageCandidate(candidate, previous, f.ports);
    await expect(recoverRelease(staged, f.ports)).rejects.toThrow("withdrawn");
    const verified = await verifyStagedCandidate(staged, f.ports);
    await expect(recoverPublication(verified, f.ports)).rejects.toThrow(
      "withdraw it explicitly",
    );
    expect((await recoverPublication(staged, f.ports)).phase).toBe("withdrawn");
    expect(f.deployment().candidate).toBeNull();
  });

  it("names the verified predecessor after every terminal phase and refuses it otherwise", () => {
    const journal: ReleaseJournal = {
      candidate: { ...candidate, versionId: stagedVersion },
      previous,
      phase: "verified",
    };
    expect(verifiedPredecessor(null)).toBeNull();
    expect(verifiedPredecessor(journal)?.versionId).toBe(stagedVersion);
    expect(verifiedPredecessor({ ...journal, phase: "recovered" })).toEqual(
      previous,
    );
    expect(verifiedPredecessor({ ...journal, phase: "withdrawn" })).toEqual(
      previous,
    );
    for (const phase of [
      "preparing",
      "staged",
      "withdrawing",
      "activating",
      "checking",
      "recovering",
    ] as const)
      expect(() => verifiedPredecessor({ ...journal, phase }), phase).toThrow(
        "requires recovery",
      );
  });
});

describe("withdrawal drill", () => {
  it("stages the next candidate, injects a probe failure, and leaves the serving version and predecessor unchanged", async () => {
    const f = fixture("none");
    const withdrawn = await drillWithdrawal(candidate, previous, f.ports);
    expect(withdrawn.phase).toBe("withdrawn");
    expect(withdrawn.candidate.versionId).toBe(stagedVersion);
    expect(f.checks).toEqual([`override:${stagedVersion}`]);
    expect(f.deployment()).toEqual({
      current: { versionId: previous.versionId, releaseId: previous.releaseId },
      candidate: null,
    });
    expect(verifiedPredecessor(withdrawn)).toEqual(previous);
    expect(f.saved.map((journal) => journal.phase)).toEqual([
      "preparing",
      "staged",
      "withdrawing",
      "withdrawn",
    ]);
  });

  it("reports a real candidate failure instead of the drill result", async () => {
    const f = fixture("candidate-check");
    const error = await drillWithdrawal(candidate, previous, f.ports).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CandidateWithdrawn);
    if (error instanceof CandidateWithdrawn)
      expect(error.cause).toBeInstanceOf(Error);
    expect(f.deployment().candidate).toBeNull();
  });
});
