import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  assuranceInputs,
  matchesInput,
  selectAssurance,
} from "../../tools/change-scope.ts";

const proofSourceList = /const proofSources = \[([^\]]*)\]/u;
const quotedPath = /"([^"]+)"/gu;

it("matches exact files, directory prefixes, and one-segment wildcards", () => {
  expect(matchesInput("mise.toml", "mise.toml")).toBe(true);
  expect(matchesInput("mise.toml.bak", "mise.toml")).toBe(false);
  expect(matchesInput("ios/Sources/App.swift", "ios/")).toBe(true);
  expect(matchesInput("ios-notes.md", "ios/")).toBe(false);
  expect(
    matchesInput("src/core/search-policy.ts", "src/core/*-policy.ts"),
  ).toBe(true);
  expect(
    matchesInput("src/core/nested/search-policy.ts", "src/core/*-policy.ts"),
  ).toBe(false);
  expect(matchesInput("src/core/search.ts", "src/core/*-policy.ts")).toBe(
    false,
  );
  expect(matchesInput("src/core-policy.ts", "src/core/*-policy.ts")).toBe(
    false,
  );
});

it("skips both assurance jobs for changes outside their inputs", () => {
  expect(
    selectAssurance(false, [
      "src/ui/search-page.tsx",
      "tests/browser/csp.spec.ts",
      "docs/verification.md",
      ".github/workflows/runner-probe.yml",
      "tools/workflow-policy.ts",
    ]),
  ).toEqual({ proofs: false, ios: false });
  expect(selectAssurance(false, [])).toEqual({ proofs: false, ios: false });
});

it("selects each assurance job from its own inputs", () => {
  expect(selectAssurance(false, ["src/core/copy-policy.ts"])).toEqual({
    proofs: true,
    ios: false,
  });
  expect(selectAssurance(false, ["verification/ios/Publication.lean"])).toEqual(
    { proofs: true, ios: false },
  );
  expect(
    selectAssurance(false, ["ios/Sources/PhonebookKit/Directory.swift"]),
  ).toEqual({ proofs: false, ios: true });
  expect(
    selectAssurance(false, ["ios/Sources/PhonebookCore/ReceiveBudget.swift"]),
  ).toEqual({ proofs: true, ios: true });
  for (const definition of [
    ".github/workflows/checks.yml",
    ".github/actions/toolchain/action.yml",
    "mise.toml",
    "justfile",
  ])
    expect(selectAssurance(false, [definition])).toEqual({
      proofs: true,
      ios: true,
    });
});

it("runs both assurance jobs when the manual campaign is requested", () => {
  expect(selectAssurance(true, undefined)).toEqual({ proofs: true, ios: true });
  expect(selectAssurance(true, [])).toEqual({ proofs: true, ios: true });
  expect(selectAssurance(false, undefined)).toEqual({
    proofs: false,
    ios: false,
  });
});

it("treats every translated proof source as a proof input", async () => {
  const declaration = proofSourceList.exec(
    await readFile("tools/prove.ts", "utf8"),
  );
  const sources = [...(declaration?.[1] ?? "").matchAll(quotedPath)].map(
    ([, path]) => path ?? "",
  );
  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources)
    expect(
      assuranceInputs.proofs.some((pattern) => matchesInput(source, pattern)),
    ).toBe(true);
});
