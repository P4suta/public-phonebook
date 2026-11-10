import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileDigest } from "@public-phonebook/data/snapshot";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  differentProofTool,
  observeProof,
  type ProofInventory,
  type ProofPorts,
  type ProofTools,
  proofReceiptFormat,
  provedOrReused,
  readProofReceipt,
  staleProof,
} from "../../tools/proof-receipt.ts";

const digestLength = 64;
const verifiedUnits = 2;
const postconditions = 3;
const inputRoot = "proof/input";
const modelPath = `${inputRoot}/proof/generated/packages/directory/src/policy.dfy`;
const inventory: ProofInventory = {
  boundFiles: ["packages/directory/src/policy.ts", "package-lock.json"],
  inputRoot,
  modelPaths: [modelPath],
  contracts: ["decision"],
  verifiedUnits,
  postconditions,
};

function digest(character: string): string {
  return character.repeat(digestLength);
}

const tools: ProofTools = {
  image: `sha256:${digest("a")}`,
  node: "v24.0.0",
  packages: digest("b"),
};

let root: string;

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}

/** Writes a receipt for the files as they are now, as a passing run does. */
async function passingReceipt(
  fields: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  return {
    formatVersion: proofReceiptFormat,
    bindings: await Promise.all(
      inventory.boundFiles.map(async (file) => ({
        file,
        input: `${inputRoot}/${file}`,
        sha256: await fileDigest(join(root, inputRoot, file)),
      })),
    ),
    image: tools.image,
    models: [
      { path: modelPath, sha256: await fileDigest(join(root, modelPath)) },
    ],
    contracts: inventory.contracts,
    verifiedUnits: inventory.verifiedUnits,
    postconditions: inventory.postconditions,
    tools: { node: tools.node, packages: tools.packages },
    semantics: "described elsewhere",
    result: "verified",
    ...fields,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "phonebook-proof-receipt-"));
  for (const [file, text] of [
    ["packages/directory/src/policy.ts", "export const limit = 100;\n"],
    ["package-lock.json", '{"lockfileVersion":3}\n'],
  ] as const) {
    await write(file, text);
    await write(`${inputRoot}/${file}`, text);
  }
  await write(modelPath, "function decision(): int { 1 }\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("proof receipt staleness", () => {
  it("accepts a receipt that binds every current file", async () => {
    expect(
      staleProof(
        await passingReceipt(),
        inventory,
        await observeProof(inventory, root),
      ),
    ).toBeNull();
  });

  it.each<[string, string, string]>([
    [
      "a bound source",
      "packages/directory/src/policy.ts",
      "Stale proof: packages/directory/src/policy.ts",
    ],
    [
      "an input copy",
      `${inputRoot}/package-lock.json`,
      "Stale proof input: package-lock.json",
    ],
    ["a generated model", modelPath, `Stale proof model: ${modelPath}`],
  ])("names %s that changed after the run", async (_, path, message) => {
    const receipt = await passingReceipt();
    await appendFile(join(root, path), "\n");
    expect(
      staleProof(receipt, inventory, await observeProof(inventory, root)),
    ).toBe(message);
  });

  it("rejects a missing model, a changed inventory, and an earlier receipt format", async () => {
    const receipt = await passingReceipt();
    const observed = await observeProof(inventory, root);
    expect(
      staleProof(
        receipt,
        { ...inventory, verifiedUnits: verifiedUnits - 1 },
        observed,
      ),
    ).toBe("Incomplete proof inventory");
    expect(
      staleProof(
        receipt,
        { ...inventory, boundFiles: [...inventory.boundFiles, "justfile"] },
        observed,
      ),
    ).toBe("Incomplete proof source binding");
    expect(
      staleProof(receipt, { ...inventory, contracts: ["other"] }, observed),
    ).toBe("Incomplete proof model inventory");
    expect(
      staleProof(
        await passingReceipt({ formatVersion: undefined }),
        inventory,
        observed,
      ),
    ).toBe("Unreadable proof receipt");
    expect(
      staleProof(
        await passingReceipt({ result: "failed" }),
        inventory,
        observed,
      ),
    ).toBe("Unreadable proof receipt");
    await rm(join(root, modelPath));
    expect(
      staleProof(receipt, inventory, await observeProof(inventory, root)),
    ).toBe(`Stale proof model: ${modelPath}`);
  });
});

describe("proof tool identity", () => {
  it.each<[string, Partial<ProofTools>, string | null]>([
    ["the same tools", {}, null],
    [
      "another verifier image",
      { image: `sha256:${digest("c")}` },
      "Different proof tool: verifier image",
    ],
    [
      "another Node.js runtime",
      { node: "v24.0.1" },
      "Different proof tool: Node.js runtime",
    ],
    [
      "another package tree",
      { packages: digest("d") },
      "Different proof tool: installed packages",
    ],
    [
      "no recorded package tree",
      { packages: null },
      "Different proof tool: installed packages",
    ],
  ])("compares %s", async (_, change, reason) => {
    expect(
      differentProofTool(await passingReceipt(), { ...tools, ...change }),
    ).toBe(reason);
  });

  it("checks the inputs of an unfinished run's receipt but never reuses it", async () => {
    const unfinished = await passingReceipt({ tools: undefined });
    expect(
      staleProof(unfinished, inventory, await observeProof(inventory, root)),
    ).toBeNull();
    expect(differentProofTool(unfinished, tools)).toBe("Incomplete proof run");
  });
});

interface FakeRun {
  readonly prove: Mock<() => Promise<void>>;
  readonly observedTools: Mock<() => Promise<ProofTools>>;
  readonly ports: ProofPorts;
}

describe("proof reuse", () => {
  function ports(receipt: () => Promise<unknown>): FakeRun {
    const prove = vi.fn(async (): Promise<void> => undefined);
    const observedTools = vi.fn(async (): Promise<ProofTools> => tools);
    return {
      prove,
      observedTools,
      ports: {
        receipt,
        observe: () => observeProof(inventory, root),
        tools: observedTools,
        prove,
      },
    };
  }

  it("reuses an unchanged passing proof without running it", async () => {
    const receipt = await passingReceipt();
    const run = ports(async () => receipt);
    expect(await provedOrReused(inventory, run.ports)).toEqual({
      result: "reused",
    });
    expect(run.prove).not.toHaveBeenCalled();
  });

  it("runs the complete proof after one bound input changes", async () => {
    const receipt = await passingReceipt();
    await appendFile(
      join(root, "packages/directory/src/policy.ts"),
      "// changed\n",
    );
    const run = ports(async () => receipt);
    expect(await provedOrReused(inventory, run.ports)).toEqual({
      result: "verified",
      reason: "Stale proof: packages/directory/src/policy.ts",
    });
    expect(run.prove).toHaveBeenCalledOnce();
    expect(run.observedTools).not.toHaveBeenCalled();
  });

  it("runs the complete proof without a receipt or with other tools", async () => {
    const missing = ports(async () => null);
    expect(await provedOrReused(inventory, missing.ports)).toEqual({
      result: "verified",
      reason: "No proof receipt",
    });
    expect(missing.prove).toHaveBeenCalledOnce();
    const receipt = await passingReceipt({ image: `sha256:${digest("e")}` });
    const retooled = ports(async () => receipt);
    expect(await provedOrReused(inventory, retooled.ports)).toEqual({
      result: "verified",
      reason: "Different proof tool: verifier image",
    });
    expect(retooled.prove).toHaveBeenCalledOnce();
  });

  it("propagates a failed run instead of reporting a result", async () => {
    const run = ports(async () => null);
    run.prove.mockRejectedValueOnce(new Error("negative control passed"));
    await expect(provedOrReused(inventory, run.ports)).rejects.toThrow(
      "negative control passed",
    );
  });

  it("reads a missing or malformed receipt as no receipt", async () => {
    const path = join(root, "proof-receipt.json");
    expect(await readProofReceipt(path)).toBeNull();
    await writeFile(path, "{");
    expect(await readProofReceipt(path)).toBeNull();
    await writeFile(path, '{"result":"verified"}');
    expect(await readProofReceipt(path)).toEqual({ result: "verified" });
  });
});
