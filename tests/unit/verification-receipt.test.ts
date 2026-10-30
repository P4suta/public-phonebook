import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  requireVerificationReceipt,
  saveVerificationReceipt,
} from "../../tools/verification-receipt.ts";

it("accepts only completed checks for the exact source and production dataset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phonebook-check-receipt-"));
  const tree = "a".repeat(40);
  const manifest = "b".repeat(64);
  try {
    await expect(
      requireVerificationReceipt(tree, manifest, directory),
    ).rejects.toThrow();
    await saveVerificationReceipt(tree, manifest, directory);
    await requireVerificationReceipt(tree, manifest, directory);
    await requireVerificationReceipt(tree, undefined, directory);
    await expect(
      requireVerificationReceipt("c".repeat(40), manifest, directory),
    ).rejects.toThrow();
    await expect(
      requireVerificationReceipt(tree, "c".repeat(64), directory),
    ).rejects.toThrow();
    for (const input of [
      {
        formatVersion: 1,
        sourceTree: tree,
        manifestSha256: manifest,
        result: "pending",
      },
      {
        formatVersion: 2,
        sourceTree: tree,
        manifestSha256: manifest,
        result: "passed",
      },
      {
        formatVersion: 1,
        sourceTree: tree,
        manifestSha256: manifest,
        result: "passed",
        bypass: true,
      },
    ]) {
      await writeFile(
        join(directory, "test-receipt.json"),
        JSON.stringify(input),
      );
      await expect(
        requireVerificationReceipt(tree, manifest, directory),
      ).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
