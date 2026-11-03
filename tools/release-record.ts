import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { releaseControl } from "../src/core/environment.ts";
import {
  type ControlStore,
  controlKeys,
  controlStoreFromEnvironment,
  sha256Hex,
  writeOnce,
} from "./control-store.ts";
import { command, requireCommand } from "./process.ts";
import { exportOutputs } from "./publish.ts";
import type { ReleaseJournal } from "./release-lifecycle.ts";
import {
  candidateEvidenceAdmission,
  encodeRecord,
  loadRelease,
  materializeVerificationDataset,
  type RunProvenance,
  runProvenance,
  type StageAdmission,
} from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import {
  stageExpectations,
  type TrackedFile,
  trackedFiles,
} from "./stage-inputs.ts";

export const recordFiles = {
  build: "worker-build.tar",
  sbom: "sbom.cdx.json",
  attestations: "attestations.jsonl",
  approval: "approval.json",
  manifest: "manifest.ready.json",
  catalog: "catalog.json",
  evidence: "release-evidence.json",
} as const;
export const sumsFile = "SHA256SUMS";
const evidenceFormat = 1;
const cyclonedxVersion = "1.6";
const tagMonthScale = 100;
const evidenceScope = "releases";
const nodeModules = "node_modules/";
const hexRadix = 16;
const hexDigits = 2;
const commandArgumentOffset = 2;
const directoryArguments = 2;
const publishedArguments = 3;
const verificationCache = ".local/control-cache/datasets";
const releaseWorkflowPath = `.github/workflows/${releaseControl.releaseWorkflow}`;
const releaseRef = `refs/heads/${releaseControl.releaseBranch}`;
const sbomPredicate = "https://cyclonedx.org/bom";
const productionEnvironment = "production";
const integrityAlgorithms: Readonly<Record<string, string>> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

const LockSchema = v.object({
  lockfileVersion: v.literal(3),
  packages: v.record(
    v.string(),
    v.looseObject({
      name: v.optional(v.string()),
      version: v.optional(v.string()),
      license: v.optional(v.string()),
      integrity: v.optional(v.string()),
      dev: v.optional(v.boolean()),
      devOptional: v.optional(v.boolean()),
      link: v.optional(v.boolean()),
    }),
  ),
});
const PackageSchema = v.looseObject({
  name: v.string(),
  dependencies: v.optional(v.record(v.string(), v.string()), {}),
});
const ComponentSchema = v.looseObject({
  type: v.literal("library"),
  name: v.pipe(v.string(), v.minLength(1)),
  version: v.pipe(v.string(), v.minLength(1)),
  purl: v.pipe(v.string(), v.startsWith("pkg:npm/")),
  licenses: v.pipe(
    v.array(v.looseObject({ expression: v.pipe(v.string(), v.minLength(1)) })),
    v.minLength(1),
  ),
  hashes: v.pipe(
    v.array(
      v.looseObject({
        alg: v.picklist(Object.values(integrityAlgorithms)),
        content: v.pipe(v.string(), v.regex(/^[0-9a-f]+$/u)),
      }),
    ),
    v.minLength(1),
  ),
});
const SbomSchema = v.looseObject({
  bomFormat: v.literal("CycloneDX"),
  specVersion: v.literal(cyclonedxVersion),
  metadata: v.looseObject({
    component: v.looseObject({
      type: v.literal("application"),
      name: v.string(),
      version: v.pipe(v.string(), v.minLength(1)),
    }),
  }),
  components: v.pipe(v.array(ComponentSchema), v.minLength(1)),
});
export type Sbom = v.InferOutput<typeof SbomSchema>;

export function npmPurl(name: string, version: string): string {
  const separator = name.indexOf("/");
  return name.startsWith("@") && separator > 0
    ? `pkg:npm/${encodeURIComponent(name.slice(0, separator))}${name.slice(separator)}@${version}`
    : `pkg:npm/${name}@${version}`;
}

function integrityHashes(
  integrity: string,
): readonly { alg: string; content: string }[] {
  return integrity.split(/\s+/u).map((entry) => {
    const separator = entry.indexOf("-");
    const alg = integrityAlgorithms[entry.slice(0, separator)];
    if (separator < 0 || !alg)
      throw new Error(`Unsupported package integrity: ${entry}`);
    return { alg, content: base64Hex(entry.slice(separator + 1)) };
  });
}

function base64Hex(encoded: string): string {
  const binary = atob(encoded);
  return Array.from({ length: binary.length }, (_, index) =>
    binary.charCodeAt(index).toString(hexRadix).padStart(hexDigits, "0"),
  ).join("");
}

export function productionSbom(
  lock: unknown,
  product: { readonly name: string; readonly version: string },
): Sbom {
  const { packages } = v.parse(LockSchema, lock);
  const components = new Map<string, Sbom["components"][number]>();
  for (const [path, entry] of Object.entries(packages)) {
    if (
      !path.startsWith(nodeModules) ||
      entry.dev ||
      entry.devOptional ||
      entry.link
    )
      continue;
    const name =
      entry.name ??
      path.slice(path.lastIndexOf(nodeModules) + nodeModules.length);
    if (!entry.version || !entry.license || !entry.integrity)
      throw new Error(
        `A locked production package lacks its version, license, or integrity: ${path}`,
      );
    const purl = npmPurl(name, entry.version);
    components.set(purl, {
      type: "library",
      name,
      version: entry.version,
      purl,
      licenses: [{ expression: entry.license }],
      hashes: [...integrityHashes(entry.integrity)],
    });
  }
  return v.parse(SbomSchema, {
    bomFormat: "CycloneDX",
    specVersion: cyclonedxVersion,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": product.name,
        name: product.name,
        version: product.version,
      },
    },
    components: [...components.values()].sort((first, second) =>
      first.purl < second.purl ? -1 : first.purl === second.purl ? 0 : 1,
    ),
  });
}

export function checkSbom(sbom: unknown, packageJson: unknown): number {
  const bom = v.parse(SbomSchema, sbom);
  const product = v.parse(PackageSchema, packageJson);
  if (bom.metadata.component.name !== product.name)
    throw new Error("The SBOM names another product");
  const names = new Set(bom.components.map((component) => component.name));
  const missing = Object.keys(product.dependencies).filter(
    (name) => !names.has(name),
  );
  if (missing.length)
    throw new Error(
      `The SBOM lacks direct production dependencies: ${missing.join(", ")}`,
    );
  return bom.components.length;
}

export function releaseTag(date: Date, runNumber: number): string {
  const run = v.parse(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
    runNumber,
  );
  return `v${date.getUTCFullYear()}.${(date.getUTCMonth() + 1) * tagMonthScale + date.getUTCDate()}.${run}`;
}

const ApprovalsSchema = v.array(
  v.looseObject({
    state: v.picklist(["approved", "rejected", "pending"]),
    environments: v.array(v.looseObject({ name: v.string() })),
    user: v.looseObject({ login: v.string() }),
  }),
);

export function productionApprovers(raw: unknown): readonly string[] {
  const reviews = v
    .parse(ApprovalsSchema, raw)
    .filter((review) =>
      review.environments.some(
        (environment) => environment.name === productionEnvironment,
      ),
    );
  if (reviews.some((review) => review.state !== "approved"))
    throw new Error(
      "The production environment has a review other than an approval",
    );
  const approvers = [...new Set(reviews.map((review) => review.user.login))];
  if (!approvers.length)
    throw new Error("The production environment has no approval in this run");
  return approvers.sort();
}

export interface AssetDigest {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export function sha256Sums(assets: readonly AssetDigest[]): string {
  return [...assets]
    .sort((first, second) =>
      first.name < second.name ? -1 : first.name === second.name ? 0 : 1,
    )
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join("");
}

export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split("\n").filter(Boolean)) {
    const [, digest, name] = /^([0-9a-f]{64}) {2}([\w.-]+)$/u.exec(line) ?? [];
    if (!digest || !name || entries.has(name))
      throw new Error(`A checksum line is malformed or repeated: ${line}`);
    entries.set(name, digest);
  }
  return entries;
}

async function digestFile(
  directory: string,
  name: string,
): Promise<AssetDigest> {
  const path = join(directory, name);
  return {
    name,
    sha256: await fileDigest(path),
    bytes: (await stat(path)).size,
  };
}

export async function verifyRecord(
  directory: string,
): Promise<readonly AssetDigest[]> {
  const listed = parseSha256Sums(
    await readFile(join(directory, sumsFile), "utf8"),
  );
  const expected = Object.values(recordFiles).toSorted();
  const present = (await readdir(directory))
    .filter((name) => name !== sumsFile)
    .toSorted();
  if (
    JSON.stringify([...listed.keys()].toSorted()) !==
      JSON.stringify(expected) ||
    JSON.stringify(present) !== JSON.stringify(expected)
  )
    throw new Error(
      "The release record doesn't hold exactly the expected assets",
    );
  const assets: AssetDigest[] = [];
  for (const name of expected) {
    const asset = await digestFile(directory, name);
    if (asset.sha256 !== listed.get(name))
      throw new Error(`A release asset differs from its checksum: ${name}`);
    assets.push(asset);
  }
  return assets;
}

export interface ReleaseEvidence {
  readonly formatVersion: typeof evidenceFormat;
  readonly tag: string;
  readonly repository: string;
  readonly provenance: RunProvenance;
  readonly release: {
    readonly releaseId: string;
    readonly versionId: string;
    readonly previousVersionId: string | null;
    readonly sourceTree: string;
    readonly snapshot: string;
    readonly manifestSha256: string;
    readonly databaseSha256: string;
    readonly databaseId: string;
    readonly buildDigest: string;
  };
  readonly candidateStages: readonly StageAdmission[];
  readonly approvers: readonly string[];
  readonly assets: readonly AssetDigest[];
}

export function releaseEvidence(input: {
  readonly tag: string;
  readonly journal: ReleaseJournal;
  readonly provenance: RunProvenance;
  readonly stages: readonly StageAdmission[];
  readonly approvers: readonly string[];
  readonly assets: readonly AssetDigest[];
}): ReleaseEvidence {
  const { candidate, previous, phase } = input.journal;
  if (
    phase !== "verified" ||
    !candidate.versionId ||
    !candidate.sourceTree ||
    !candidate.artifactSha256
  )
    throw new Error(
      "A release record needs a verified release built from this repository",
    );
  const refused = input.stages.filter((stage) => stage.decision !== "admit");
  if (refused.length || !input.stages.length)
    throw new Error("A release record needs admitted evidence for every stage");
  return {
    formatVersion: evidenceFormat,
    tag: input.tag,
    repository: releaseControl.repository,
    provenance: input.provenance,
    release: {
      releaseId: candidate.releaseId,
      versionId: candidate.versionId,
      previousVersionId: previous?.versionId ?? null,
      sourceTree: candidate.sourceTree,
      snapshot: candidate.snapshot,
      manifestSha256: candidate.manifestSha256,
      databaseSha256: candidate.databaseSha256,
      databaseId: candidate.databaseId,
      buildDigest: candidate.artifactSha256,
    },
    candidateStages: input.stages,
    approvers: input.approvers,
    assets: input.assets,
  };
}

export function releaseNotes(evidence: ReleaseEvidence): string {
  const { release } = evidence;
  return [
    `Production release ${evidence.tag} serves snapshot \`${release.snapshot}\`.`,
    "",
    `- Release ID: \`${release.releaseId}\``,
    `- Worker version: \`${release.versionId}\``,
    `- Dataset manifest: \`${release.manifestSha256}\``,
    `- Source tree: \`${release.sourceTree}\``,
    `- Approved by: ${evidence.approvers.join(", ")}`,
    "",
    `Check the assets with \`sha256sum --check ${sumsFile}\` and \`mise x -- just release-verify ${evidence.tag} DIRECTORY\`.`,
    "",
  ].join("\n");
}

async function sourceTree(): Promise<string> {
  const tree = await command("git", ["rev-parse", "HEAD^{tree}"], true);
  if (tree.code !== 0) throw new Error("Cannot identify the source tree");
  return tree.stdout.trim();
}

export async function assembleRecord(
  store: ControlStore,
  directory: string,
  tag: string,
  source: { readonly tree: string; readonly files: readonly TrackedFile[] },
  provenance: RunProvenance,
): Promise<ReleaseEvidence> {
  const head = await loadRelease(store, "production");
  if (!head) throw new Error("There is no production journal");
  const { candidate } = head.journal;
  if (candidate.sourceTree !== source.tree)
    throw new Error("The verified release was built from another source tree");
  const verification = await materializeVerificationDataset(
    store,
    candidate.manifestSha256,
    resolve(verificationCache),
  );
  for (const file of [recordFiles.manifest, recordFiles.catalog])
    await copyFile(join(verification, file), join(directory, file));
  checkSbom(
    JSON.parse(await readFile(join(directory, recordFiles.sbom), "utf8")),
    JSON.parse(await readFile("package.json", "utf8")),
  );
  const assets: AssetDigest[] = [];
  for (const name of Object.values(recordFiles).filter(
    (file) => file !== recordFiles.evidence,
  ))
    assets.push(await digestFile(directory, name));
  const evidence = releaseEvidence({
    tag,
    journal: head.journal,
    provenance,
    stages: await candidateEvidenceAdmission(
      store,
      stageExpectations(source.files, candidate.manifestSha256),
    ),
    approvers: productionApprovers(
      JSON.parse(await readFile(join(directory, recordFiles.approval), "utf8")),
    ),
    assets,
  });
  const bytes = encodeRecord(evidence);
  await writeFile(join(directory, recordFiles.evidence), bytes);
  await writeFile(
    join(directory, sumsFile),
    sha256Sums([
      ...assets,
      {
        name: recordFiles.evidence,
        sha256: sha256Hex(bytes),
        bytes: bytes.byteLength,
      },
    ]),
  );
  await writeOnce(
    store,
    controlKeys.evidence(evidenceScope, sha256Hex(bytes)),
    bytes,
  );
  return evidence;
}

async function attestations(directory: string): Promise<void> {
  const build = resolve(directory, recordFiles.build);
  const signer = `${releaseControl.repository}/${releaseWorkflowPath}`;
  for (const predicate of [[], ["--predicate-type", sbomPredicate]])
    await requireCommand("gh", [
      "attestation",
      "verify",
      build,
      "--repo",
      releaseControl.repository,
      "--signer-workflow",
      signer,
      "--source-ref",
      releaseRef,
      ...predicate,
    ]);
  const scratch = await mkdtemp(join(tmpdir(), "phonebook-attestations-"));
  try {
    await requireCommand(
      "gh",
      ["attestation", "download", build, "--repo", releaseControl.repository],
      scratch,
    );
    const bundles = (await readdir(scratch)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    if (bundles.length !== 1 || !bundles[0])
      throw new Error("The build has no single attestation bundle");
    await rename(
      join(scratch, bundles[0]),
      join(directory, recordFiles.attestations),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function verifyPublished(tag: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await requireCommand("gh", [
    "release",
    "download",
    tag,
    "--repo",
    releaseControl.repository,
    "--dir",
    directory,
  ]);
  const assets = await verifyRecord(directory);
  const scratch = await mkdtemp(join(tmpdir(), "phonebook-release-"));
  try {
    await copyFile(
      join(directory, recordFiles.build),
      join(scratch, recordFiles.build),
    );
    await attestations(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.info(
    JSON.stringify({
      operation: "release.verify",
      tag,
      assets: assets.length,
      result: "verified",
    }),
  );
}

const usage =
  "Usage: release-record sbom OUTPUT --version VERSION | tag | attestations DIRECTORY | assemble DIRECTORY --tag TAG --notes FILE | verify DIRECTORY | verify-published TAG DIRECTORY";

async function main(args: readonly string[]): Promise<void> {
  const [action, first, flag, value, notesFlag, notes] = args;
  if (action === "sbom" && first && flag === "--version" && value) {
    const bom = productionSbom(
      JSON.parse(await readFile("package-lock.json", "utf8")),
      {
        name: v.parse(
          PackageSchema,
          JSON.parse(await readFile("package.json", "utf8")),
        ).name,
        version: value,
      },
    );
    const components = checkSbom(
      bom,
      JSON.parse(await readFile("package.json", "utf8")),
    );
    await writeFile(first, encodeRecord(bom));
    console.info(JSON.stringify({ operation: "release.sbom", components }));
    return;
  }
  if (action === "tag" && args.length === 1) {
    const tag = releaseTag(new Date(), Number(process.env.GITHUB_RUN_NUMBER));
    await exportOutputs({ tag });
    console.info(JSON.stringify({ operation: "release.tag", tag }));
    return;
  }
  if (
    action === "attestations" &&
    first &&
    args.length === directoryArguments
  ) {
    await attestations(first);
    return;
  }
  if (
    action === "assemble" &&
    first &&
    flag === "--tag" &&
    value &&
    notesFlag === "--notes" &&
    notes
  ) {
    const evidence = await assembleRecord(
      controlStoreFromEnvironment(),
      first,
      value,
      { tree: await sourceTree(), files: await trackedFiles() },
      runProvenance(),
    );
    await writeFile(notes, releaseNotes(evidence));
    console.info(
      JSON.stringify({
        operation: "release.record",
        tag: evidence.tag,
        assets: evidence.assets.length + 1,
        evidence: sha256Hex(encodeRecord(evidence)),
      }),
    );
    return;
  }
  if (action === "verify" && first && args.length === directoryArguments) {
    const assets = await verifyRecord(first);
    console.info(
      JSON.stringify({
        operation: "release.verify",
        assets: assets.length,
        result: "verified",
      }),
    );
    return;
  }
  if (
    action === "verify-published" &&
    first &&
    flag &&
    args.length === publishedArguments
  ) {
    await verifyPublished(first, flag);
    return;
  }
  throw new Error(usage);
}

if (process.argv[1] === resolve("tools/release-record.ts"))
  await main(process.argv.slice(commandArgumentOffset));
