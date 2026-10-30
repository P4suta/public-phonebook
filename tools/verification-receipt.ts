import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import { command } from "./process.ts";

const receiptName = "test-receipt.json";
const receiptFormat = 1;
const treeSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u));

export async function cleanTree(): Promise<string | null> {
  const status = await command("git", ["status", "--porcelain"], true);
  if (status.code !== 0) throw new Error("Cannot inspect the source checkout");
  if (status.stdout.trim()) return null;
  const tree = await command("git", ["rev-parse", "HEAD^{tree}"], true);
  if (tree.code !== 0) throw new Error("Cannot identify the source tree");
  return v.parse(treeSchema, tree.stdout.trim());
}

export async function saveVerificationReceipt(
  sourceTree: string,
  manifestSha256: string,
  directory = resolve(".local"),
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, receiptName),
    JSON.stringify({
      formatVersion: receiptFormat,
      sourceTree: v.parse(treeSchema, sourceTree),
      manifestSha256: v.parse(DigestSchema, manifestSha256),
      result: "passed",
    }),
    { flush: true },
  );
}

export async function requireVerificationReceipt(
  sourceTree: string,
  manifestSha256?: string,
  directory = resolve(".local"),
): Promise<void> {
  v.parse(
    v.strictObject({
      formatVersion: v.literal(receiptFormat),
      sourceTree: v.literal(v.parse(treeSchema, sourceTree)),
      manifestSha256: manifestSha256
        ? v.literal(v.parse(DigestSchema, manifestSha256))
        : DigestSchema,
      result: v.literal("passed"),
    }),
    JSON.parse(await readFile(join(directory, receiptName), "utf8")),
  );
}
