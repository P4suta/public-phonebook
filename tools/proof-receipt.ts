import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as v from "valibot";
import { DigestSchema } from "../src/core/models.ts";
import { fileDigest } from "./snapshot.ts";

export const proofReceiptFormat = 1;

const ImageSchema = v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/u));

const ProofReceiptSchema = v.object({
  formatVersion: v.literal(proofReceiptFormat),
  bindings: v.array(
    v.strictObject({
      file: v.string(),
      input: v.string(),
      sha256: DigestSchema,
    }),
  ),
  image: ImageSchema,
  models: v.array(v.strictObject({ path: v.string(), sha256: DigestSchema })),
  contracts: v.array(v.string()),
  verifiedUnits: v.number(),
  postconditions: v.number(),
  /** A run adds its tools only after every negative and receipt control passes. */
  tools: v.optional(
    v.strictObject({
      node: v.string(),
      packages: v.nullable(DigestSchema),
    }),
  ),
  result: v.literal("verified"),
});

/** The files and counts that a complete proof run binds. */
export interface ProofInventory {
  readonly boundFiles: readonly string[];
  readonly inputRoot: string;
  readonly modelPaths: readonly string[];
  readonly contracts: readonly string[];
  readonly verifiedUnits: number;
  readonly postconditions: number;
}

/** The current SHA-256 of every bound source, input copy, and model, or `null` for a missing file. */
export interface ProofObservation {
  readonly sources: ReadonlyMap<string, string | null>;
  readonly inputs: ReadonlyMap<string, string | null>;
  readonly models: ReadonlyMap<string, string | null>;
}

/** The verifier image and the runtime that generated the models. */
export interface ProofTools {
  readonly image: string;
  readonly node: string;
  /** The SHA-256 of the installed package tree, or `null` when npm recorded none. */
  readonly packages: string | null;
}

export async function digestOrNull(path: string): Promise<string | null> {
  try {
    return await fileDigest(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

/** Hashes every file that the receipt binds, relative to `root`, one file at a time. */
export async function observeProof(
  inventory: ProofInventory,
  root = process.cwd(),
): Promise<ProofObservation> {
  const digests = async (
    paths: readonly string[],
  ): Promise<ReadonlyMap<string, string | null>> => {
    const observed = new Map<string, string | null>();
    for (const path of paths)
      observed.set(path, await digestOrNull(resolve(root, path)));
    return observed;
  };
  return {
    sources: await digests(inventory.boundFiles),
    inputs: await digests(
      inventory.boundFiles.map((file) => `${inventory.inputRoot}/${file}`),
    ),
    models: await digests(inventory.modelPaths),
  };
}

/** Names the first difference between a receipt and the current files, or returns `null` when the receipt still describes every one of them. */
export function staleProof(
  receipt: unknown,
  inventory: ProofInventory,
  observed: ProofObservation,
): string | null {
  const parsed = v.safeParse(ProofReceiptSchema, receipt);
  if (!parsed.success) return "Unreadable proof receipt";
  const { bindings, models, contracts } = parsed.output;
  if (
    parsed.output.verifiedUnits !== inventory.verifiedUnits ||
    parsed.output.postconditions !== inventory.postconditions
  )
    return "Incomplete proof inventory";
  if (bindings.length !== inventory.boundFiles.length)
    return "Incomplete proof source binding";
  for (const file of inventory.boundFiles) {
    const current = observed.sources.get(file);
    if (
      !current ||
      bindings.find((binding) => binding.file === file)?.sha256 !== current
    )
      return `Stale proof: ${file}`;
  }
  for (const file of inventory.boundFiles) {
    const binding = bindings.find((item) => item.file === file);
    const input = `${inventory.inputRoot}/${file}`;
    const current = observed.inputs.get(input);
    if (
      !binding ||
      !current ||
      binding.input !== input ||
      binding.sha256 !== current
    )
      return `Stale proof input: ${file}`;
  }
  if (
    models.length !== inventory.modelPaths.length ||
    JSON.stringify(contracts) !== JSON.stringify(inventory.contracts)
  )
    return "Incomplete proof model inventory";
  for (const path of inventory.modelPaths) {
    const current = observed.models.get(path);
    if (
      !current ||
      models.find((model) => model.path === path)?.sha256 !== current
    )
      return `Stale proof model: ${path}`;
  }
  return null;
}

/** Names the first tool that differs from the receipt's, or returns `null` when the receipt records the same tools. */
export function differentProofTool(
  receipt: unknown,
  tools: ProofTools,
): string | null {
  const parsed = v.safeParse(ProofReceiptSchema, receipt);
  if (!parsed.success) return "Unreadable proof receipt";
  const recorded = parsed.output.tools;
  if (!recorded) return "Incomplete proof run";
  if (parsed.output.image !== tools.image)
    return "Different proof tool: verifier image";
  if (recorded.node !== tools.node)
    return "Different proof tool: Node.js runtime";
  if (tools.packages === null || recorded.packages !== tools.packages)
    return "Different proof tool: installed packages";
  return null;
}

export type ProofOutcome =
  | { readonly result: "reused" }
  | { readonly result: "verified"; readonly reason: string };

export interface ProofPorts {
  /** Reads the receipt, or returns `null` when no readable receipt exists. */
  readonly receipt: () => Promise<unknown>;
  readonly observe: () => Promise<ProofObservation>;
  /** Builds or finds the verifier image and reads the runtime versions. */
  readonly tools: () => Promise<ProofTools>;
  /** Runs the complete proof with its negative and receipt controls. */
  readonly prove: () => Promise<void>;
}

/** Reuses a passing proof only while its receipt binds the same sources, input copies, models, and tools, and otherwise runs the complete proof. */
export async function provedOrReused(
  inventory: ProofInventory,
  ports: ProofPorts,
): Promise<ProofOutcome> {
  const receipt = await ports.receipt();
  const reason =
    receipt === null
      ? "No proof receipt"
      : (staleProof(receipt, inventory, await ports.observe()) ??
        differentProofTool(receipt, await ports.tools()));
  if (reason === null) return { result: "reused" };
  await ports.prove();
  return { result: "verified", reason };
}

/** Reads a JSON receipt, or returns `null` when the file is missing or isn't JSON. */
export async function readProofReceipt(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
