import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { auditVerificationArtifacts } from "../../tools/verification-artifacts.ts";

it("rejects credential material in reports and compressed browser traces without disclosing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phonebook-artifacts-"));
  const secret = "fixture-sensitive-staging-credential";
  try {
    await writeFile(
      join(directory, "report.json"),
      JSON.stringify({ result: "passed" }),
    );
    expect(await auditVerificationArtifacts([directory], [secret])).toBe(1);
    await writeFile(
      join(directory, "trace.zip"),
      zipSync({ "trace.network": strToU8(JSON.stringify({ header: secret })) }),
    );
    await expect(
      auditVerificationArtifacts([directory], [secret]),
    ).rejects.toThrow("Verification artifacts contain credential material");
    await rm(join(directory, "trace.zip"));
    await writeFile(join(directory, "report.json"), btoa(secret));
    await expect(
      auditVerificationArtifacts([directory], [secret]),
    ).rejects.toThrow("Verification artifacts contain credential material");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
