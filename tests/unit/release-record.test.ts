import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  controlKeys,
  fileControlStore,
  readObject,
  sha256Hex,
} from "../../tools/control-store.ts";
import type {
  ReleaseJournal,
  ReleaseTarget,
} from "../../tools/release-lifecycle.ts";
import {
  assembleRecord,
  checkSbom,
  nameBasedUuid,
  npmPurl,
  parseSha256Sums,
  productionApprovers,
  productionSbom,
  recordFiles,
  releaseEvidence,
  releaseNotes,
  releaseTag,
  sha256Sums,
  sumsFile,
  verifyRecord,
} from "../../tools/release-record.ts";
import {
  candidateSigner,
  candidateStages,
  journalWriter,
  type RunProvenance,
  recordCandidateEvidence,
  releaseSigner,
  storeVerificationDataset,
} from "../../tools/release-store.ts";
import { stageExpectations } from "../../tools/stage-inputs.ts";
import { passingEvidence } from "./stage-evidence-fixture.ts";

const integrity = "sha512-AAEC";
const lock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "fixture", dependencies: { alpha: "1.0.0" } },
    "node_modules/alpha": { version: "1.0.0", license: "MIT", integrity },
    "node_modules/@scope/beta": {
      version: "2.0.0",
      license: "MIT OR Apache-2.0",
      integrity,
    },
    "node_modules/alpha/node_modules/gamma": {
      version: "3.0.0",
      license: "ISC",
      integrity: "sha1-AAEC",
    },
    "node_modules/other/node_modules/gamma": {
      version: "3.0.0",
      license: "ISC",
      integrity: "sha1-AAEC",
    },
    "node_modules/tool": {
      version: "4.0.0",
      license: "MIT",
      integrity,
      dev: true,
    },
    "node_modules/maybe": {
      version: "5.0.0",
      license: "MIT",
      integrity,
      devOptional: true,
    },
  },
};
const tree = "a".repeat(40);
const actions: RunProvenance = {
  kind: "github-actions",
  repository: "P4suta/public-phonebook",
  workflow: releaseSigner,
  runId: "41",
  runAttempt: 1,
  commit: "b".repeat(40),
  actor: "P4suta",
};

describe("SBOM", () => {
  it("carries the fields that actions/attest requires to recognize CycloneDX, with a content-derived serial number", () => {
    expect(
      nameBasedUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com"),
    ).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    const bom = productionSbom(lock, { name: "fixture", version: tree });
    // actions/attest 59d89421 src/sbom.ts checkIsCycloneDX
    expect(Boolean(bom.bomFormat && bom.serialNumber && bom.specVersion)).toBe(
      true,
    );
    expect(bom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(productionSbom(lock, { name: "fixture", version: tree })).toEqual(
      bom,
    );
    expect(
      productionSbom(lock, { name: "fixture", version: "b".repeat(40) })
        .serialNumber,
    ).not.toBe(bom.serialNumber);
    const { serialNumber: _, ...unnumbered } = bom;
    expect(() =>
      checkSbom(unnumbered, { name: "fixture", dependencies: {} }),
    ).toThrow();
  });

  it("derives a well-formed, repeatable version 5 identifier for every namespace and name", () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.string({ unit: "grapheme" }),
        (namespace, name) => {
          const identifier = nameBasedUuid(namespace, name);
          expect(identifier).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );
          expect(nameBasedUuid(namespace, name)).toBe(identifier);
          expect(nameBasedUuid(namespace, `${name}.`)).not.toBe(identifier);
        },
      ),
      { seed: 410_331, numRuns: 500 },
    );
  });

  it("names npm packages with their purl, encoding a scope", () => {
    expect(npmPurl("alpha", "1.0.0")).toBe("pkg:npm/alpha@1.0.0");
    expect(npmPurl("@scope/beta", "2.0.0")).toBe("pkg:npm/%40scope/beta@2.0.0");
  });

  it("lists each locked production package once with its license and integrity digest", () => {
    const bom = productionSbom(lock, { name: "fixture", version: tree });
    expect(bom.metadata.component).toMatchObject({
      type: "application",
      name: "fixture",
      version: tree,
    });
    expect(bom.components.map((component) => component.purl)).toEqual([
      "pkg:npm/%40scope/beta@2.0.0",
      "pkg:npm/alpha@1.0.0",
      "pkg:npm/gamma@3.0.0",
    ]);
    expect(bom.components[1]).toEqual({
      type: "library",
      name: "alpha",
      version: "1.0.0",
      purl: "pkg:npm/alpha@1.0.0",
      licenses: [{ expression: "MIT" }],
      hashes: [{ alg: "SHA-512", content: "000102" }],
    });
    expect(bom.components[2]?.hashes).toEqual([
      { alg: "SHA-1", content: "000102" },
    ]);
    expect(
      checkSbom(bom, { name: "fixture", dependencies: { alpha: "1" } }),
    ).toBe(3);
  });

  it("refuses an unidentified package, another product, and a missing direct dependency", () => {
    for (const entry of [
      { version: "1.0.0", integrity },
      { version: "1.0.0", license: "MIT" },
      { license: "MIT", integrity },
      { version: "1.0.0", license: "MIT", integrity: "md5-AAEC" },
    ])
      expect(() =>
        productionSbom(
          { lockfileVersion: 3, packages: { "node_modules/x": entry } },
          { name: "fixture", version: tree },
        ),
      ).toThrow();
    const bom = productionSbom(lock, { name: "fixture", version: tree });
    expect(() => checkSbom(bom, { name: "other" })).toThrow("another product");
    expect(() =>
      checkSbom(bom, { name: "fixture", dependencies: { missing: "1" } }),
    ).toThrow("missing");
    expect(() =>
      checkSbom(
        { ...bom, components: [{ ...bom.components[0], licenses: [] }] },
        { name: "fixture" },
      ),
    ).toThrow();
  });
});

describe("release identity and approval", () => {
  it("names a release by its UTC date and run number", () => {
    expect(releaseTag(new Date(Date.UTC(2026, 10, 2, 23)), 15)).toBe(
      "v2026.1102.15",
    );
    expect(releaseTag(new Date(Date.UTC(2027, 0, 2)), 7)).toBe("v2027.102.7");
    for (const run of [0, Number.NaN, 1.5])
      expect(() => releaseTag(new Date(), run)).toThrow();
  });

  it("records only approvals of the production environment and refuses a rejected or missing one", () => {
    const review = (
      state: string,
      login: string,
      name = "production",
    ): Record<string, unknown> => ({
      state,
      comment: "",
      environments: [{ id: 1, name }],
      user: { login },
    });
    expect(
      productionApprovers([
        review("approved", "P4suta"),
        review("approved", "P4suta"),
        review("approved", "another", "testflight"),
      ]),
    ).toEqual(["P4suta"]);
    expect(() =>
      productionApprovers([
        review("approved", "P4suta"),
        review("rejected", "another"),
      ]),
    ).toThrow("other than an approval");
    expect(() =>
      productionApprovers([review("approved", "P4suta", "testflight")]),
    ).toThrow("no approval");
    expect(() => productionApprovers({})).toThrow();
  });
});

describe("checksums", () => {
  it("writes sorted lines and reads back exactly the listed digests", () => {
    const text = sha256Sums([
      { name: "b.json", sha256: "2".repeat(64), bytes: 2 },
      { name: "a.tar", sha256: "1".repeat(64), bytes: 1 },
    ]);
    expect(text).toBe(`${"1".repeat(64)}  a.tar\n${"2".repeat(64)}  b.json\n`);
    expect([...parseSha256Sums(text)]).toEqual([
      ["a.tar", "1".repeat(64)],
      ["b.json", "2".repeat(64)],
    ]);
    for (const malformed of [
      `${"1".repeat(63)}  a.tar\n`,
      `${"1".repeat(64)} a.tar\n`,
      `${"1".repeat(64)}  a/b\n`,
      `${text}${"3".repeat(64)}  a.tar\n`,
    ])
      expect(() => parseSha256Sums(malformed)).toThrow();
  });
});

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "phonebook-record-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeRecord(record: string): Promise<void> {
  await mkdir(record, { recursive: true });
  const assets = [];
  for (const name of Object.values(recordFiles)) {
    const bytes = new TextEncoder().encode(`${name}\n`);
    await writeFile(join(record, name), bytes);
    assets.push({ name, sha256: sha256Hex(bytes), bytes: bytes.byteLength });
  }
  await writeFile(join(record, sumsFile), sha256Sums(assets));
}

describe("record verification", () => {
  it("accepts exactly the expected assets with matching digests", async () => {
    await writeRecord(directory);
    expect(await verifyRecord(directory)).toHaveLength(
      Object.values(recordFiles).length,
    );
  });

  it("refuses a changed byte, a missing asset, and an extra asset", async () => {
    await writeRecord(directory);
    await writeFile(join(directory, recordFiles.catalog), "changed\n");
    await expect(verifyRecord(directory)).rejects.toThrow("differs");
    await writeRecord(directory);
    await rm(join(directory, recordFiles.sbom));
    await expect(verifyRecord(directory)).rejects.toThrow("exactly");
    await writeRecord(directory);
    await writeFile(join(directory, "extra.txt"), "extra\n");
    await expect(verifyRecord(directory)).rejects.toThrow("exactly");
  });
});

const target: ReleaseTarget = {
  releaseId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  sourceTree: tree,
  snapshot: "3".repeat(64),
  databaseSha256: "4".repeat(64),
  databaseId: "55555555-5555-4555-8555-555555555555",
  manifestSha256: "6".repeat(64),
  artifactSha256: "7".repeat(64),
  manifestBinding: "digest",
};
const verified: ReleaseJournal = {
  phase: "verified",
  candidate: target,
  previous: {
    ...target,
    releaseId: "88888888-8888-4888-8888-888888888888",
    versionId: "99999999-9999-4999-8999-999999999999",
  },
};

describe("release evidence", () => {
  const stages = candidateStages.map((stage) => ({
    stage,
    inputsSha256: "e".repeat(64),
    decision: "admit" as const,
  }));

  it("names the release, its predecessor, the stages, the approvers, and the assets", () => {
    const evidence = releaseEvidence({
      tag: "v2026.1102.15",
      journal: verified,
      provenance: actions,
      stages,
      approvers: ["P4suta"],
      assets: [],
    });
    expect(evidence.release).toMatchObject({
      releaseId: target.releaseId,
      versionId: target.versionId,
      previousVersionId: verified.previous?.versionId,
      buildDigest: target.artifactSha256,
    });
    expect(releaseNotes(evidence)).toContain(target.versionId);
  });

  it("refuses an unfinished release, an adopted baseline, and refused stage evidence", () => {
    const input = {
      tag: "v2026.1102.15",
      provenance: actions,
      stages,
      approvers: ["P4suta"],
      assets: [],
    };
    for (const journal of [
      { ...verified, phase: "candidate-verified" as const },
      { ...verified, phase: "recovered" as const },
      {
        ...verified,
        candidate: { ...target, sourceTree: null, artifactSha256: null },
      },
    ])
      expect(() => releaseEvidence({ ...input, journal })).toThrow();
    expect(() =>
      releaseEvidence({
        ...input,
        journal: verified,
        stages: [
          {
            stage: "check",
            inputsSha256: "e".repeat(64),
            decision: "stale-inputs",
          },
        ],
      }),
    ).toThrow("every stage");
  });

  it("assembles a verifiable record and keeps its evidence in the control store", async () => {
    const store = fileControlStore(join(directory, "store"));
    const bundle = join(directory, "bundle");
    await mkdir(bundle);
    const manifest = new TextEncoder().encode('{"fixture":"manifest"}\n');
    await writeFile(join(bundle, "manifest.ready.json"), manifest);
    await writeFile(join(bundle, "catalog.json"), '{"fixture":"catalog"}\n');
    const manifestSha256 = await storeVerificationDataset(store, bundle);
    const candidate = { ...target, manifestSha256 };
    await journalWriter(store, "production", actions, null).save({
      ...verified,
      candidate,
    });
    const files = [
      { mode: "100644", object: "1".repeat(40), path: "ios/App.swift" },
      { mode: "100644", object: "2".repeat(40), path: "src/ui/page.tsx" },
    ];
    const expected = stageExpectations(files, manifestSha256);
    for (const stage of candidateStages)
      await recordCandidateEvidence(
        store,
        passingEvidence(
          stage,
          expected[stage],
          { ...actions, workflow: candidateSigner },
          tree,
        ),
      );
    const record = join(directory, "record");
    await mkdir(record);
    await writeFile(join(record, recordFiles.build), "tar");
    await writeFile(join(record, recordFiles.attestations), "{}\n");
    await writeFile(
      join(record, recordFiles.approval),
      JSON.stringify([
        {
          state: "approved",
          environments: [{ name: "production" }],
          user: { login: "P4suta" },
        },
      ]),
    );
    const bom = productionSbom(
      JSON.parse(await readFile("package-lock.json", "utf8")),
      { name: "public-phonebook", version: tree },
    );
    await writeFile(join(record, recordFiles.sbom), JSON.stringify(bom));
    const evidence = await assembleRecord(
      store,
      record,
      "v2026.1102.15",
      { tree, files },
      actions,
    );
    expect(evidence.approvers).toEqual(["P4suta"]);
    expect(evidence.release.manifestSha256).toBe(manifestSha256);
    expect(await verifyRecord(record)).toHaveLength(
      Object.values(recordFiles).length,
    );
    const stored = await readObject(
      store,
      controlKeys.evidence(
        "releases",
        sha256Hex(
          new Uint8Array(await readFile(join(record, recordFiles.evidence))),
        ),
      ),
    );
    expect(stored).not.toBeNull();
    await expect(
      assembleRecord(
        store,
        record,
        "v2026.1102.15",
        { tree: "c".repeat(40), files },
        actions,
      ),
    ).rejects.toThrow("another source tree");
  });
});
