import { readFile } from "node:fs/promises";
import { GitHub } from "release-please";
import type { Commit } from "release-please/build/src/commit.js";
import type { PullRequest } from "release-please/build/src/pull-request.js";
import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VersionRequestSchema,
  versionManifest,
} from "../../tools/version-proposals.ts";

const baseline = "1".repeat(40);
const source = "3".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(
  app: "ios" | "android",
  commits: readonly Commit[],
  version = "1.0.0",
  mergedLabels: readonly string[] = [],
): Promise<{
  readonly github: GitHub;
  readonly files: Map<string, string>;
  readonly created: PullRequest[];
  readonly publications: string[];
}> {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  const github = await GitHub.create({
    owner: "P4suta",
    repo: "public-phonebook",
    defaultBranch: "main",
    token: "fixture-token",
  });
  const files = new Map([
    [`apps/${app}/version.txt`, `${version}\n`],
    [`releases/${app}/manifest.json`, JSON.stringify({ ".": version })],
  ]);
  const created: PullRequest[] = [];
  const publications: string[] = [];
  vi.spyOn(github, "getFileContentsOnBranch").mockImplementation(
    async (path) => {
      const parsedContent = files.get(path) ?? (await readFile(path, "utf8"));
      return {
        sha: baseline,
        content: btoa(
          Array.from(new TextEncoder().encode(parsedContent), (byte) =>
            String.fromCharCode(byte),
          ).join(""),
        ),
        parsedContent,
        mode: "100644",
      };
    },
  );
  vi.spyOn(github, "releaseIterator").mockImplementation(async function* () {
    yield* [];
  });
  vi.spyOn(github, "tagIterator").mockImplementation(async function* () {
    yield* [];
  });
  vi.spyOn(github, "mergeCommitIterator").mockImplementation(
    async function* () {
      yield* commits.toReversed();
      yield {
        sha: baseline,
        message: `chore(${app}): prepare version ${version}`,
        files: [`apps/${app}/version.txt`],
      };
    },
  );
  vi.spyOn(github, "pullRequestIterator").mockImplementation(
    async function* (_branch, status) {
      if (status === "MERGED" && mergedLabels.length)
        yield {
          number: 1,
          title: `chore(main): release ${app} ${version}`,
          body: "",
          files: [`apps/${app}/version.txt`],
          labels: [...mergedLabels],
          headBranchName: `release-please--branches--main--components--${app}`,
          baseBranchName: "main",
          mergeCommitOid: baseline,
        };
    },
  );
  vi.spyOn(github, "createRelease").mockImplementation(async () => {
    publications.push("release");
    throw new Error("Version preparation attempted publication");
  });
  vi.spyOn(github, "createPullRequest").mockImplementation(
    async (proposal, _branch, _message, updates) => {
      for (const update of updates) {
        let original = files.get(update.path);
        if (original === undefined && !update.createIfMissing)
          original = await readFile(update.path, "utf8");
        files.set(update.path, update.updater.updateContent(original));
      }
      const result = { ...proposal, number: 123 };
      created.push(result);
      return result;
    },
  );
  return { github, files, created, publications };
}

describe("pinned release-please proposal integration", () => {
  it("refuses a version manifest that changed after Rust preparation", async () => {
    const memory = await fixture("ios", [], "2.0.0");
    const request = v.parse(VersionRequestSchema, {
      format: 1,
      app: "ios",
      source,
      baseline,
      version: "1.0.0",
      commits: [],
    });
    await expect(versionManifest(memory.github, request)).rejects.toThrow(
      "baseline changed",
    );
    expect(memory.created).toEqual([]);
  });
  it.each(["ios", "android"] as const)(
    "includes shared root fixes and excludes Web presentation from %s versions",
    async (app) => {
      const commits: Commit[] = [
        {
          sha: "2".repeat(40),
          message: "feat(web): redesign search spacing",
          files: ["apps/web/src/ui/search.css"],
        },
        {
          sha: source,
          message: "fix(search): preserve canonical phone numbers",
          files: ["packages/directory/src/normalization.ts"],
        },
      ];
      const memory = await fixture(app, commits);
      const request = v.parse(VersionRequestSchema, {
        format: 1,
        app,
        source,
        baseline,
        version: "1.0.0",
        commits: commits.map((commit) => ({
          sha: commit.sha,
          include: commit.sha === source,
        })),
      });
      const manifest = await versionManifest(memory.github, request);
      const proposals = await manifest.createPullRequests();
      expect(proposals).toHaveLength(1);
      expect(memory.created[0]?.headBranchName).toBe(
        `release-please--branches--main--components--${app}`,
      );
      expect(memory.created[0]?.labels).toEqual([`version:${app}:pending`]);
      expect(memory.files.get(`apps/${app}/version.txt`)?.trim()).toBe("1.0.1");
      expect(memory.files.get(`releases/${app}/manifest.json`)).toContain(
        '"1.0.1"',
      );
      const changelog = memory.files.get(`apps/${app}/CHANGELOG.md`);
      expect(changelog).toContain("preserve canonical phone numbers");
      expect(changelog).not.toContain("redesign search spacing");
      if (app === "ios")
        expect(memory.files.get("apps/ios/AppStore/metadata.json")).toContain(
          '"version": "1.0.1"',
        );
      expect(memory.publications).toEqual([]);
    },
  );

  it("does not propose an app version for a CSS-only change", async () => {
    const commits = [
      {
        sha: source,
        message: "fix(web): adjust spacing",
        files: ["apps/web/src/ui/search.css"],
      },
    ];
    const memory = await fixture("ios", commits);
    const manifest = await versionManifest(
      memory.github,
      v.parse(VersionRequestSchema, {
        format: 1,
        app: "ios",
        source,
        baseline,
        version: "1.0.0",
        commits: [{ sha: source, include: false }],
      }),
    );
    expect(await manifest.createPullRequests()).toEqual([]);
    expect(memory.created).toEqual([]);
    expect(memory.publications).toEqual([]);
  });

  it("continues after a merged preparation without requiring a tag or a store upload", async () => {
    const commits = [
      {
        sha: source,
        message: "feat(ios): add category navigation",
        files: ["apps/ios/App/Search.swift"],
      },
    ];
    const memory = await fixture("ios", commits, "1.1.0", [
      "version:ios:merged",
    ]);
    const manifest = await versionManifest(
      memory.github,
      v.parse(VersionRequestSchema, {
        format: 1,
        app: "ios",
        source,
        baseline,
        version: "1.1.0",
        commits: [{ sha: source, include: true }],
      }),
    );
    expect(await manifest.createPullRequests()).toHaveLength(1);
    expect(memory.files.get("apps/ios/version.txt")?.trim()).toBe("1.2.0");
    expect(memory.publications).toEqual([]);
  });

  it("refuses unknown or duplicate prepared commit identities", async () => {
    const commits = [
      {
        sha: source,
        message: "fix(ios): improve loading",
        files: ["apps/ios/App/Search.swift"],
      },
    ];
    const memory = await fixture("ios", commits);
    const request = v.parse(VersionRequestSchema, {
      format: 1,
      app: "ios",
      source,
      baseline,
      version: "1.0.0",
      commits: [],
    });
    const missing = await versionManifest(memory.github, request);
    await expect(missing.createPullRequests()).rejects.toThrow(
      "history changed",
    );
    const duplicate = {
      ...request,
      commits: [
        { sha: source, include: true },
        { sha: source, include: false },
      ],
    };
    await expect(versionManifest(memory.github, duplicate)).rejects.toThrow(
      "Duplicate commits",
    );
    expect(memory.created).toEqual([]);
  });
});
