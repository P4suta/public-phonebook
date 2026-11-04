import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as v from "valibot";
import type { Result } from "../src/core/result.ts";
import {
  type CommandResult,
  command,
  mapConcurrently,
  requireCommand,
} from "./process.ts";
import {
  digestOrNull,
  observeProof,
  type ProofInventory,
  proofReceiptFormat,
  provedOrReused,
  readProofReceipt,
  staleProof,
} from "./proof-receipt.ts";
import { fileDigest } from "./snapshot.ts";
import { StepTimer } from "./step-timing.ts";

const immutableFileMode = 0o444;
const writableFileMode = 0o644;
const lineFeedByte = 10;
const verifiedUnitCount = 47;
const declaredPostconditionCount = 85;
const commandArgumentOffset = 2;
const jsonIndentation = 2;
const verifierExecutable = "/opt/dafny/dafny";
const verifierCpus = 2;
const safetyStopSeconds = 900;
const generatorProcesses = 4;
const releaseControlVerifiedUnits = 2;
const releaseControlPostconditions = 16;
const provenUnitCount = verifiedUnitCount + releaseControlVerifiedUnits;
const provenPostconditionCount =
  declaredPostconditionCount + releaseControlPostconditions;

const expected = [
  "canFetchNext",
  "cursorDecision",
  "compatibleRegion",
  "boundedLimit",
  "previewLimit",
  "totalSource",
  "storesSearch",
  "searchTrigger",
  "siteRequestAdmission",
  "fitsSitePage",
  "importDecision",
  "promotionAdmission",
  "schoolEvidence",
  "singleCandidate",
  "sourceRowsAccounted",
  "withdrawalDecision",
  "recoveryDecision",
  "leaseAdmission",
  "probeHold",
  "evidenceAdmission",
  "canRetireResource",
  "retainsCoverage",
  "snapshotAdmission",
  "nameRankAt",
  "groupPrecedes",
  "searchSource",
  "nextVisible",
  "indexAdmission",
  "rowLocatorDecision",
  "deltaPublication",
  "copyAdmission",
  "deltaAdmission",
  "rangeVerdict",
  "rangeStart",
  "rangeEnd",
];
const boundFiles = [
  "src/core/snapshot-policy.ts",
  "src/core/byte-range-policy.ts",
  "src/core/byte-range.ts",
  "tests/unit/byte-range.test.ts",
  "src/core/catalog.ts",
  "src/routes/privacy.tsx",
  "src/routes/support.tsx",
  "src/routes/about.tsx",
  "src/ui/information-page.tsx",
  "src/ui/service-information.ts",
  "src/ui/styles.css.ts",
  "tools/directory-fixture.ts",
  "tools/native-fixture.ts",
  "tests/unit/native-contract.test.ts",
  "tests/browser/information.spec.ts",
  "ios/Tests/PhonebookKitTests/DirectoryContract.json",
  "tools/check-data.ts",
  "tools/check-fixture.ts",
  "tools/check.ts",
  "tools/test.ts",
  "tools/verification-receipt.ts",
  "tools/publication-coverage.ts",
  "tests/unit/verification-receipt.test.ts",
  "tests/unit/publication-coverage.test.ts",
  "src/core/dataset-storage.ts",
  "tools/release-lifecycle.ts",
  "tools/release-provider.ts",
  "tools/release-store.ts",
  "tools/control-store.ts",
  "tools/control-lease.ts",
  "tools/control-import.ts",
  "tests/unit/control-store.test.ts",
  "tests/unit/control-lease.test.ts",
  "tests/unit/control-import.test.ts",
  "tests/unit/release-inputs.test.ts",
  "tests/unit/remote-data.test.ts",
  "tests/unit/test-stages.test.ts",
  "tests/unit/release-provider.test.ts",
  "src/server/version-header.ts",
  "tests/unit/version-header.test.ts",
  "tools/release-retention.ts",
  "tools/release.ts",
  "tools/worker-settings.ts",
  "tools/probe-budget.ts",
  "tests/unit/release-lifecycle.test.ts",
  "tests/unit/release-retention.test.ts",
  "tests/unit/release-store.test.ts",
  "tests/unit/withdrawal-drill.test.ts",
  "tests/unit/worker-settings.test.ts",
  "tests/unit/probe-budget.test.ts",
  "tests/unit/api.test.ts",
  "tools/public-request.ts",
  "tests/unit/public-request.test.ts",
  "tests/public/fixtures.ts",
  "tests/public/tsconfig.json",
  "tools/verification-artifacts.ts",
  "tests/unit/verification-artifacts.test.ts",
  "src/core/collection-policy.ts",
  "src/core/address.ts",
  "tools/collection/artifacts.ts",
  "tools/collection/catalog.ts",
  "tools/collection/extract.ts",
  "tools/collection/models.ts",
  "tools/collection/overlay.ts",
  "tools/collection/public-facility.ts",
  "tools/collection/read-tables.ts",
  "tools/collection/read-pdf.ts",
  "tools/collection/run.ts",
  "tools/collection/school-registry.ts",
  "tests/unit/address.test.ts",
  "tests/unit/collection-artifacts.test.ts",
  "tests/unit/collection-policy.test.ts",
  "tests/unit/collection-overlay.test.ts",
  "tests/unit/collection.test.ts",
  "tests/unit/snapshot.test.ts",
  "src/core/search-policy.ts",
  "src/core/search.ts",
  "src/core/search-trigger-policy.ts",
  "src/core/search-input.ts",
  "src/core/phone.ts",
  "tests/unit/search-trigger.test.ts",
  "tests/browser/search-trigger.spec.ts",
  "src/core/site-request-policy.ts",
  "src/core/publication-policy.ts",
  "tools/cloudflare.ts",
  "tools/remote-statements.ts",
  "tools/seed-database.ts",
  "tools/remote-data.ts",
  "tools/publish.ts",
  "tests/public/playwright.config.ts",
  "tests/public/site.spec.ts",
  "tests/public/api.spec.ts",
  "tests/browser/fixtures.ts",
  "tests/browser/privacy.spec.ts",
  "tests/browser/external-links.spec.ts",
  "tests/unit/publication.test.ts",
  "justfile",
  "tests/unit/site-request.test.ts",
  "src/server.ts",
  "vite.config.ts",
  "src/ui/components.tsx",
  "src/ui/group-results.tsx",
  "src/ui/search-page.tsx",
  "src/server/database.ts",
  "src/server/search-cache.ts",
  "src/core/models.ts",
  "src/core/http-status.ts",
  "src/core/environment.ts",
  "src/server/api.ts",
  "src/core/row-locator-policy.ts",
  "src/core/content-negotiation.ts",
  "tests/unit/row-locator.test.ts",
  "src/core/directory-delta-policy.ts",
  "src/core/directory-delta.ts",
  "tools/directory-delta.ts",
  "tests/unit/directory-delta.test.ts",
  "tests/unit/content-negotiation.test.ts",
  "tests/unit/workerd-api.test.ts",
  "tests/unit/workerd-fixture.ts",
  "cloudflare.config.ts",
  "tools/prove.ts",
  "tools/process.ts",
  "tests/unit/process.test.ts",
  "tools/snapshot.ts",
  "tools/proof-receipt.ts",
  "tools/step-timing.ts",
  "tests/unit/proof-receipt.test.ts",
  "tests/unit/step-timing.test.ts",
  "src/core/directory-archive.ts",
  "tests/unit/directory-archive.test.ts",
  "src/core/search-index.ts",
  "tools/search-index.ts",
  "tests/unit/search-index.test.ts",
  "src/core/local-search-policy.ts",
  "src/core/local-search.ts",
  "src/core/local-search-protocol.ts",
  "src/ui/local-search-service.ts",
  "src/ui/local-search-worker.ts",
  "tests/unit/local-search-fixture.ts",
  "tests/unit/local-search-policy.test.ts",
  "tests/unit/local-search.test.ts",
  "tests/unit/local-search-parity.test.ts",
  "tests/unit/local-search-worker.test.ts",
  "src/ui/local-index.ts",
  "src/ui/result-cards.ts",
  "tests/browser/local-search.spec.ts",
  "tests/browser/search-sources.ts",
  "package.json",
  "tsconfig.json",
  "mise.toml",
  "package-lock.json",
  "lemmascript.json",
  "proof/Dockerfile",
];

const proofRoot = "proof/input";
interface ProofSourceBinding {
  readonly file: string;
  readonly input: string;
  readonly sha256: string;
}
const proofSources = [
  "src/core/collection-policy.ts",
  "src/core/search-policy.ts",
  "src/core/search-trigger-policy.ts",
  "src/core/site-request-policy.ts",
  "src/core/publication-policy.ts",
  "src/core/snapshot-policy.ts",
  "src/core/local-search-policy.ts",
  "src/core/row-locator-policy.ts",
  "src/core/directory-delta-policy.ts",
  "src/core/byte-range-policy.ts",
];
const modelPaths = proofSources.map(
  (path) => `${proofRoot}/proof/generated/${path.replace(/\.ts$/u, ".dfy")}`,
);
const receiptPath = ".local/proof-receipt.json";
const negativeSources = "proof/negative";
const generatedModels = "proof/generated";

/** A copied policy source with one mutation that must make Dafny report an unproved contract. */
interface NegativeControl {
  readonly name: string;
  readonly source: string;
  readonly from: string;
  readonly to: string;
}

const searchPolicy = "src/core/search-policy.ts";
const triggerPolicy = "src/core/search-trigger-policy.ts";
const sitePolicy = "src/core/site-request-policy.ts";
const publicationPolicy = "src/core/publication-policy.ts";
const collectionPolicy = "src/core/collection-policy.ts";
const localSearchPolicy = "src/core/local-search-policy.ts";
const rowPolicy = "src/core/row-locator-policy.ts";
const deltaPolicy = "src/core/directory-delta-policy.ts";
const negativeControls: readonly NegativeControl[] = [
  {
    name: "search-policy",
    source: searchPolicy,
    from: "const maximumSearchLimit = 100;",
    to: "const maximumSearchLimit = 101;",
  },
  {
    name: "total-scope",
    source: searchPolicy,
    from: "if (queried || municipality) return",
    to: "if (queried) return",
  },
  {
    name: "cache-status",
    source: searchPolicy,
    from: "return status === cacheableStatus;",
    to: "return status >= cacheableStatus;",
  },
  {
    name: "trigger-composition",
    source: triggerPolicy,
    from: '  if (composing) return "wait";\n',
    to: "",
  },
  {
    name: "trigger-telephone",
    source: triggerPolicy,
    from: 'return completeTelephone ? "settle" : "wait";',
    to: 'return "settle";',
  },
  {
    name: "trigger-pause",
    source: triggerPolicy,
    from: "const minimumPauseIntervals = 2;",
    to: "const minimumPauseIntervals = 1;",
  },
  {
    name: "site-admission",
    source: sitePolicy,
    from: '  if (!sameOrigin) return "cross_origin";\n',
    to: "",
  },
  {
    name: "site-page",
    source: sitePolicy,
    from: "const sitePageSize = 30;",
    to: "const sitePageSize = 31;",
  },
  {
    name: "import-identity",
    source: publicationPolicy,
    from: 'if (current === "") return "start";',
    to: 'if (current !== "") return "start";',
  },
  {
    name: "promotion-verified",
    source: publicationPolicy,
    from: '  if (!verified) return "unverified";\n',
    to: "",
  },
  {
    name: "promotion-current",
    source: publicationPolicy,
    from: '  if (currentVersion !== previousVersion) return "current-changed";\n',
    to: "",
  },
  {
    name: "promotion-version",
    source: publicationPolicy,
    from: '  if (deployedCandidate !== verifiedVersion) return "different-version";\n',
    to: "",
  },
  {
    name: "withdrawal-ownership",
    source: publicationPolicy,
    from: 'return candidateOwned ? "remove-candidate" : "refuse";',
    to: 'return "remove-candidate";',
  },
  {
    name: "recovery-ownership",
    source: publicationPolicy,
    from: 'if (!previousPresent) return "refuse";',
    to: 'if (previousPresent) return "refuse";',
  },
  {
    name: "retention-pending",
    source: publicationPolicy,
    from: "return owned && !active && !rollback && !pending;",
    to: "return owned && !active && !rollback;",
  },
  {
    name: "coverage-retention",
    source: publicationPolicy,
    from: "return candidate * coverageScale >= previous * coverageRetained;",
    to: "return candidate * coverageScale >= previous * (coverageRetained - 1);",
  },
  {
    name: "lease-expiry",
    source: publicationPolicy,
    from: "if (serverTimeMs >= expiresAtMs) return",
    to: "if (serverTimeMs > expiresAtMs) return",
  },
  {
    name: "probe-hold",
    source: publicationPolicy,
    from: "return oldestMs + windowMs - nowMs;",
    to: "return oldestMs + windowMs - nowMs + 1;",
  },
  {
    name: "evidence-signer",
    source: publicationPolicy,
    from: '  if (signer !== expectedSigner) return "different-signer";\n',
    to: "",
  },
  {
    name: "evidence-inputs",
    source: publicationPolicy,
    from: '  if (inputs !== expectedInputs) return "stale-inputs";\n',
    to: "",
  },
  {
    name: "collection-ambiguity",
    source: collectionPolicy,
    from: "return count === 1;",
    to: "return count === 0;",
  },
  {
    name: "collection-accounting",
    source: collectionPolicy,
    from: "return rows === accepted + missing + invalid + duplicate + excluded;",
    to: "return rows === accepted + missing + invalid + excluded;",
  },
  {
    name: "collection-name-evidence",
    source: collectionPolicy,
    from: "  return (\n    namePresent &&",
    to: "  return (\n    true &&",
  },
  {
    name: "snapshot-policy",
    source: "src/core/snapshot-policy.ts",
    from: 'if (supplied && !matches) return "snapshot_changed";',
    to: 'if (!supplied && !matches) return "snapshot_changed";',
  },
  {
    name: "local-rank",
    source: localSearchPolicy,
    from: "if (at > 0) return substringRank;",
    to: "if (at > 1) return substringRank;",
  },
  {
    name: "local-group-order",
    source: localSearchPolicy,
    from: "(rank === otherRank && row < otherRow);",
    to: "(rank === otherRank && row <= otherRow);",
  },
  {
    name: "local-source",
    source: localSearchPolicy,
    from: 'return index === "ready" ? "local" : "server";',
    to: 'return index !== "unavailable" ? "local" : "server";',
  },
  {
    name: "local-continuation",
    source: localSearchPolicy,
    from: "const continuationPage = 30;",
    to: "const continuationPage = 31;",
  },
  {
    name: "local-admission",
    source: localSearchPolicy,
    from: '  if (!digestMatches) return "digest_mismatch";\n',
    to: "",
  },
  {
    name: "row-range",
    source: rowPolicy,
    from: 'if (row >= contacts) return "not_found";',
    to: 'if (row > contacts) return "not_found";',
  },
  {
    name: "row-snapshot",
    source: rowPolicy,
    from: '  if (!current) return "snapshot_changed";\n',
    to: "",
  },
  {
    name: "delta-budget",
    source: deltaPolicy,
    from: "const deltaBudgetDenominator = 2;",
    to: "const deltaBudgetDenominator = 1;",
  },
  {
    name: "delta-range",
    source: deltaPolicy,
    from: "return start >= 0 && count >= 1 && start + count <= baseRows;",
    to: "return start >= 0 && count >= 1 && start + count <= baseRows + 1;",
  },
  {
    name: "delta-digest",
    source: deltaPolicy,
    from: '  if (!digestMatches) return "digest_mismatch";\n',
    to: "",
  },
];

function negativeSource(control: NegativeControl): string {
  return `${negativeSources}/${control.name}.ts`;
}

function negativeModel(control: NegativeControl): string {
  return `${proofRoot}/${generatedModels}/${negativeSources}/${control.name}.dfy`;
}

/** Holds when Dafny ran and reported at least one unproved contract, so a tool error or timeout can't count as a rejection. */
function rejectedByVerifier(result: CommandResult): boolean {
  return (
    result.code !== 0 &&
    /[1-9][0-9]* error/u.test(result.output) &&
    /could not be proved|could not prove/u.test(result.output)
  );
}

const inventory: ProofInventory = {
  boundFiles,
  inputRoot: proofRoot,
  modelPaths,
  contracts: expected,
  verifiedUnits: provenUnitCount,
  postconditions: provenPostconditionCount,
};
const timer = new StepTimer();

async function verifierImage(): Promise<string> {
  const build = await command(
    "docker",
    [
      "build",
      "--platform=linux/amd64",
      // A provenance attestation carries its build time, so each cached build would get a new image ID.
      "--provenance=false",
      "--quiet",
      "--file",
      `${proofRoot}/proof/Dockerfile`,
      proofRoot,
    ],
    true,
  );
  const image = build.output.trim().split("\n").at(-1) ?? "";
  if (build.code !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(image))
    throw new Error(`Verifier image build failed: ${build.output}`);
  return image;
}

/** Hashes npm's record of the installed package tree, which holds the model generator. */
function installedPackages(): Promise<string | null> {
  return digestOrNull("node_modules/.package-lock.json");
}

async function generatorPath(): Promise<string> {
  const metadata: unknown = JSON.parse(
    await readFile("node_modules/lemmascript/package.json", "utf8"),
  );
  const { bin } = v.parse(
    v.object({ bin: v.object({ lsc: v.string() }) }),
    metadata,
  );
  return resolve("node_modules/lemmascript", bin.lsc);
}

/** Type-checks `files` with only the snapshot and the ES2023 library, without any type package. */
async function checkWithoutPackages(
  scratch: string,
  files: readonly string[],
): Promise<CommandResult> {
  const project = join(scratch, `tsconfig.${randomUUID()}.json`);
  await writeFile(
    project,
    JSON.stringify({
      extends: "./input/tsconfig.json",
      compilerOptions: { lib: ["ES2023"], types: [] },
      include: [],
      files,
    }),
  );
  return command(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--pretty",
      "false",
      "--project",
      project,
    ],
    true,
  );
}

/**
 * Requires every proof source to resolve each name within the snapshot and the ES2023 library.
 * A copy outside the checkout sees no package types, and the pinned type packages only add members to `ErrorConstructor` and `ImportMeta` among ES2023 declarations, so such a source translates to the same model there.
 * The check must also refuse a planted package import and a planted ambient type.
 */
async function requireSelfContainedSources(scratch: string): Promise<void> {
  const sources = await checkWithoutPackages(
    scratch,
    proofSources.map((path) => `input/${path}`),
  );
  if (sources.code !== 0)
    throw new Error(
      `A proof source needs a declaration outside its snapshot: ${sources.output}`,
    );
  const control = "source-isolation-control.ts";
  await writeFile(
    join(scratch, control),
    'import type { InferOutput } from "valibot";\nexport type Imported = InferOutput<never>;\nexport type Ambient = CfProperties;\n',
  );
  const planted = await checkWithoutPackages(scratch, [control]);
  if (
    planted.code === 0 ||
    !planted.output.includes("TS2307") ||
    !planted.output.includes("TS2304")
  )
    throw new Error(
      `The source isolation control was inconclusive: ${planted.output}`,
    );
}

async function runGenerator(
  generator: string,
  snapshot: string,
  path: string,
): Promise<void> {
  const generated = await command(
    process.execPath,
    [generator, "gen", "--backend=dafny", path],
    true,
    snapshot,
  );
  if (generated.code !== 0)
    throw new Error(
      `Model generation failed (${generated.code}) for ${path}: ${generated.output}`,
    );
}

/**
 * Generates every positive and negative model in a per-run copy of the snapshot outside the checkout, where the generator's TypeScript project finds no installed packages.
 * The models and negative sources then return to their paths in the snapshot.
 */
async function generateModels(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "public-phonebook-proof-"));
  try {
    const snapshot = join(scratch, "input");
    await cp(proofRoot, snapshot, { recursive: true });
    await requireSelfContainedSources(scratch);
    await mkdir(join(snapshot, negativeSources), { recursive: true });
    for (const control of negativeControls) {
      const source = await readFile(join(snapshot, control.source), "utf8");
      const broken = source.replace(control.from, control.to);
      if (broken === source)
        throw new Error(
          `The ${control.name} negative control did not mutate the implementation`,
        );
      await writeFile(join(snapshot, negativeSource(control)), broken);
    }
    const generator = await generatorPath();
    await mapConcurrently(
      [...proofSources, ...negativeControls.map(negativeSource)],
      generatorProcesses,
      (path) => runGenerator(generator, snapshot, path),
    );
    for (const directory of [generatedModels, negativeSources])
      await cp(join(snapshot, directory), join(proofRoot, directory), {
        recursive: true,
      });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

type Verifier = (models: readonly string[]) => Promise<CommandResult>;

/** Runs `action` with one verifier container that has the proof limits, and runs each verification as its own Dafny process in that container. */
async function withVerifier<T>(
  image: string,
  action: (verify: Verifier) => Promise<T>,
): Promise<T> {
  const name = `dial-proof-${randomUUID()}`;
  const verify: Verifier = (models) =>
    command(
      "docker",
      [
        "exec",
        name,
        verifierExecutable,
        "verify",
        ...models,
        "--resource-limit=5000000",
        "--verification-time-limit=30",
        "--unicode-char=false",
        "--allow-deprecation",
      ],
      true,
    );
  let result: Result<T, unknown>;
  try {
    const started = await timer.time("container", () =>
      command(
        "docker",
        [
          "run",
          "--detach",
          "--rm",
          "--platform=linux/amd64",
          "--name",
          name,
          "--network=none",
          "--read-only",
          "--memory=2048m",
          "--memory-swap=2048m",
          `--cpus=${verifierCpus}`,
          "--pids-limit=256",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs=/tmp:rw,nosuid,size=128m",
          "--mount",
          `type=bind,src=${process.cwd()},dst=/work,readonly`,
          "--workdir=/work",
          // The container's lifetime is the safety stop for every Dafny process in it.
          "--entrypoint=/usr/bin/sleep",
          image,
          String(safetyStopSeconds),
        ],
        true,
      ),
    );
    if (started.code !== 0)
      throw new Error(`Proof container start failed: ${started.output}`);
    result = { ok: true, value: await action(verify) };
  } catch (error) {
    result = { ok: false, error };
  }
  const cleanup = await command("docker", ["rm", "--force", name], true);
  if (cleanup.code !== 0 && !cleanup.output.includes("No such container"))
    throw new AggregateError(
      result.ok ? [] : [result.error],
      `Proof container cleanup failed: ${cleanup.output}`,
    );
  if (!result.ok) throw result.error;
  return result.value;
}

/** Copies every bound file into the read-only input snapshot and checks the declared postcondition inventory. */
async function copyInputs(): Promise<ProofSourceBinding[]> {
  await rm("proof/generated", { recursive: true, force: true });
  await rm(proofRoot, { recursive: true, force: true });
  const bindings: ProofSourceBinding[] = [];
  for (const file of boundFiles) {
    const input = `${proofRoot}/${file}`;
    await mkdir(dirname(input), { recursive: true });
    await writeFile(input, await readFile(file), { mode: immutableFileMode });
    bindings.push({ file, input, sha256: await fileDigest(input) });
  }
  const declarations = await Promise.all(
    proofSources.map((path) => readFile(`${proofRoot}/${path}`, "utf8")),
  );
  if (
    declarations.reduce(
      (sum, source) =>
        sum + [...source.matchAll(/^\s*\/\/@ ensures /gm)].length,
      0,
    ) !== provenPostconditionCount
  )
    throw new Error("The declared postcondition inventory changed");
  return bindings;
}

/** Runs every proof, negative control, and receipt control, and records the tools only after all of them pass. */
async function proveCompletely(): Promise<void> {
  await rm(receiptPath, { force: true });
  const generator = {
    node: process.version,
    packages: await installedPackages(),
  };
  let complete = false;
  try {
    const bindings = await timer.time("inputs", copyInputs);
    await timer.time("models", generateModels);
    const models: string[] = [];
    for (const path of modelPaths) {
      const generated = await readFile(path, "utf8");
      if (generated !== (await readFile(`${path}.gen`, "utf8")))
        throw new Error("The generated model was modified");
      if (/\b(?:assume|axiom|extern)\b/u.test(generated))
        throw new Error("Unsupported proof escape");
      models.push(generated);
    }
    const model = models.join("\n");
    const modelBindings = await Promise.all(
      modelPaths.map(async (path) => ({
        path,
        sha256: await fileDigest(path),
      })),
    );
    for (const name of expected) {
      if (
        !model.includes(`function ${name}(`) ||
        !model.includes(`lemma ${name}_ensures(`)
      )
        throw new Error(`Missing proof: ${name}`);
    }
    const image = await timer.time("image", verifierImage);
    await withVerifier(image, async (verify) => {
      const positive = await timer.time("proof", () => verify(modelPaths));
      console.info(positive.output);
      if (
        positive.code !== 0 ||
        !new RegExp(
          `finished with ${provenUnitCount} verified, 0 errors`,
          "u",
        ).test(positive.output)
      )
        throw new Error("The complete proof inventory did not pass");
      const negatives = await timer.time("negative proofs", () =>
        mapConcurrently(negativeControls, verifierCpus, (control) =>
          verify([negativeModel(control)]),
        ),
      );
      for (const [index, control] of negativeControls.entries()) {
        const rejected = negatives[index];
        if (!rejected || !rejectedByVerifier(rejected))
          throw new Error(
            `The ${control.name} negative control was inconclusive: ${rejected?.output}`,
          );
      }
    });
    const receipt = {
      formatVersion: proofReceiptFormat,
      bindings,
      image,
      models: modelBindings,
      contracts: expected,
      verifiedUnits: provenUnitCount,
      postconditions: provenPostconditionCount,
      semantics:
        "Dafny integers over validated finite integer limits; JavaScript UTF-16 strings",
      negativeControl:
        "limit 101, a municipality-blind catalog total, a cached failure status, a composition-blind search trigger, an incomplete telephone search, a one-interval pause, an admitted cross-origin site request, a 31-row site page, conflicting import identities, promotion of an unverified, displaced, or different candidate, withdrawal of a foreign candidate, ambiguous school selection, missing row accounting, missing name evidence, changed snapshot admission, a substring ranked at the second position, a reflexive result order, a loading index searched on the device, a 31-row continuation, an index admitted without its digest, an off-by-one row range, a snapshot-blind row locator, a delta budget of the whole archive, an off-by-one copy range, and a delta admitted without its digest rejected",
      result: "verified",
    };
    await timer.time("receipt", async () => {
      for (const binding of bindings) {
        if (
          (await fileDigest(binding.file)) !== binding.sha256 ||
          (await fileDigest(binding.input)) !== binding.sha256
        )
          throw new Error(
            `Proof input changed during verification: ${binding.file}`,
          );
      }
      for (const binding of modelBindings)
        if ((await fileDigest(binding.path)) !== binding.sha256)
          throw new Error(
            `Proof model changed during verification: ${binding.path}`,
          );
      if ((await installedPackages()) !== generator.packages)
        throw new Error("The installed packages changed during verification");
      await writeFile(
        receiptPath,
        JSON.stringify(receipt, null, jsonIndentation),
      );
    });
    await timer.time("receipt controls", receiptControls);
    const final = `${receiptPath}.${randomUUID()}`;
    await writeFile(
      final,
      JSON.stringify({ ...receipt, tools: generator }, null, jsonIndentation),
    );
    await rename(final, receiptPath);
    complete = true;
  } finally {
    if (!complete) await rm(receiptPath, { force: true });
  }
}

/** Requires the receipt check to reject an altered input copy and an altered model, then to accept the restored files. */
async function receiptControls(): Promise<void> {
  for (const control of [
    {
      path: `${proofRoot}/src/core/search-policy.ts`,
      message: "Stale proof input:",
      mode: immutableFileMode,
    },
    {
      path: modelPaths[0],
      message: "Stale proof model:",
      mode: writableFileMode,
    },
  ]) {
    if (!control.path)
      throw new Error("The proof receipt control has no target");
    const bytes = await readFile(control.path);
    try {
      await chmod(control.path, writableFileMode);
      const altered = new Uint8Array(bytes.length + 1);
      altered.set(bytes);
      altered[bytes.length] = lineFeedByte;
      await writeFile(control.path, altered);
      const stale = await command(
        process.execPath,
        ["tools/prove.ts", "--check-receipt"],
        true,
      );
      if (stale.code === 0 || !stale.output.includes(control.message))
        throw new Error(
          `The receipt control was inconclusive: ${stale.output}`,
        );
    } finally {
      await writeFile(control.path, bytes);
      await chmod(control.path, control.mode);
    }
  }
  await requireCommand(process.execPath, ["tools/prove.ts", "--check-receipt"]);
}

async function main(): Promise<void> {
  await mkdir(".local", { recursive: true });
  const lock = await open(".local/proof.lock", "wx");
  try {
    const outcome = await provedOrReused(inventory, {
      receipt: () => readProofReceipt(receiptPath),
      observe: () => timer.time("receipt check", () => observeProof(inventory)),
      tools: () =>
        timer.time("image", async () => ({
          image: await verifierImage(),
          node: process.version,
          packages: await installedPackages(),
        })),
      prove: proveCompletely,
    });
    console.info(
      JSON.stringify({
        operation: "proof",
        verifiedUnits: provenUnitCount,
        postconditions: provenPostconditionCount,
        ...(outcome.result === "reused"
          ? { result: "reused", receipt: receiptPath }
          : {
              negativeControl: "rejected",
              negativeControls: negativeControls.length,
              receiptControls: "rejected",
              result: "verified",
              reason: outcome.reason,
            }),
        totalMs: timer.totalMs(),
        steps: timer.steps(),
      }),
    );
  } finally {
    await lock.close();
    await rm(".local/proof.lock");
    console.error(timer.table("proof"));
  }
}

if (process.argv[commandArgumentOffset] === "--check-receipt") {
  const stale = staleProof(
    await readProofReceipt(receiptPath),
    inventory,
    await observeProof(inventory),
  );
  if (stale) throw new Error(stale);
} else {
  if (process.argv.length !== commandArgumentOffset)
    throw new Error("Usage: npm run prove [-- --check-receipt]");
  await main();
}
