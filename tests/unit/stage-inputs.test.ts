import { readFile } from "node:fs/promises";
import { candidateStages } from "@public-phonebook/cloudflare/release-store";
import { describe, expect, it } from "vitest";
import {
  iosCheckScope,
  stageExpectations,
  stageInputDigest,
  stageInputs,
  stageReads,
  type TrackedFile,
  trackedFiles,
} from "../../tools/stage-inputs.ts";

const manifest = "a".repeat(64);
const otherManifest = "b".repeat(64);

function file(path: string, object = "1".repeat(40)): TrackedFile {
  return { mode: "100644", object, path };
}

const files = [
  file("apps/ios/Sources/App.swift"),
  file("verification/ios/Publication.lean"),
  file("tools/ios-check/src/ios.rs"),
  file("packages/directory/src/search.ts"),
  file("apps/web/src/ui/search-page.tsx"),
  file("apps/web/src/ui/icons.tsx"),
  file("docs/deployment.md"),
  file(".github/workflows/candidate.yml"),
];

function changed(path: string): readonly TrackedFile[] {
  return files.map((entry) =>
    entry.path === path ? file(path, "2".repeat(40)) : entry,
  );
}

function changedStages(
  path: string,
  manifestSha256 = manifest,
): readonly string[] {
  const before = stageExpectations(files, manifest);
  const after = stageExpectations(changed(path), manifestSha256);
  return candidateStages.filter(
    (stage) => before[stage].inputsSha256 !== after[stage].inputsSha256,
  );
}

describe("stage inputs", () => {
  it("matches the scope that the iOS check hashes for its own receipts", async () => {
    const source = await readFile("tools/ios-check/src/ios.rs", "utf8");
    const declaration = /const SCOPE: \[&str; (\d+)\] = \[([^\]]*)\];/u.exec(
      source,
    );
    if (!declaration?.[1] || declaration[2] === undefined)
      throw new Error("The iOS check scope is missing");
    const scope = [...declaration[2].matchAll(/"([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(scope).toHaveLength(Number(declaration[1]));
    expect(iosCheckScope).toEqual(scope);
  });

  it("reruns the Web stages and keeps the iOS stages for a page change", () => {
    expect(changedStages("apps/web/src/ui/search-page.tsx")).toEqual([
      "check",
      "data",
      "parity",
      "phones",
      "prove",
      "e2e",
    ]);
  });

  it("reruns every stage for a change that both apps read", () => {
    expect(changedStages("packages/directory/src/search.ts")).toEqual(
      candidateStages,
    );
    expect(changedStages("apps/web/src/ui/icons.tsx")).toEqual(candidateStages);
    expect(changedStages(".github/workflows/candidate.yml")).toEqual(
      candidateStages,
    );
  });

  it("reruns only the stages that read native files for a native change", () => {
    for (const path of [
      "apps/ios/Sources/App.swift",
      "verification/ios/Publication.lean",
      "tools/ios-check/src/ios.rs",
    ])
      expect(changedStages(path), path).toEqual([
        "check",
        "prove",
        "ios-prove",
        "ios-check",
      ]);
  });

  it("reruns only the stages that read the dataset for a new dataset", () => {
    expect(changedStages("none", otherManifest)).toEqual(
      candidateStages.filter((stage) => stageInputs[stage].dataset),
    );
    expect(
      candidateStages.filter((stage) => stageInputs[stage].dataset),
    ).toEqual(["data", "parity", "phones", "e2e"]);
  });

  it("matches whole path segments and refuses an empty selection or a missing dataset", () => {
    const ios = stageInputs["ios-check"];
    expect(stageReads(ios, "apps/ios")).toBe(true);
    expect(stageReads(ios, "apps/ios/App.swift")).toBe(true);
    expect(stageReads(ios, "iosx/App.swift")).toBe(false);
    expect(stageReads(stageInputs.e2e, "apps/ios/App.swift")).toBe(false);
    expect(stageReads(stageInputs.e2e, "docs/design-system.json")).toBe(true);
    expect(() =>
      stageInputDigest("ios-check", [file("docs/a.md")], null),
    ).toThrow("reads no tracked file");
    expect(() => stageInputDigest("e2e", files, null)).toThrow(
      "reads a dataset",
    );
    expect(stageExpectations(files, manifest).check.manifestSha256).toBeNull();
    expect(stageExpectations(files, manifest).e2e.manifestSha256).toBe(
      manifest,
    );
  });

  it("lists the committed files of this checkout", async () => {
    const status = await import("../../tools/process.ts").then(({ command }) =>
      command("git", ["status", "--porcelain"], true),
    );
    if (status.stdout.trim()) {
      await expect(trackedFiles()).rejects.toThrow("clean committed");
      return;
    }
    const listed = await trackedFiles();
    expect(listed.some((entry) => entry.path === "tools/stage-inputs.ts")).toBe(
      true,
    );
    expect(listed.every((entry) => /^[0-7]{6}$/u.test(entry.mode))).toBe(true);
  });
});
