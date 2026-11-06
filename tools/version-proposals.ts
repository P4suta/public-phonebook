import { readFile } from "node:fs/promises";
import { type ConventionalCommit, GitHub, Manifest } from "release-please";
import { ManifestPlugin } from "release-please/build/src/plugin.js";
import * as v from "valibot";

const revision = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u));
const initialArgument = 2;
export const VersionRequestSchema = v.strictObject({
  format: v.literal(1),
  app: v.picklist(["ios", "android"]),
  source: revision,
  baseline: revision,
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
  commits: v.array(v.strictObject({ sha: revision, include: v.boolean() })),
});
type VersionRequest = v.InferOutput<typeof VersionRequestSchema>;

export class VersionInputs extends ManifestPlugin {
  readonly decisions: ReadonlyMap<string, boolean>;

  constructor(github: GitHub, manifest: Manifest, request: VersionRequest) {
    super(github, "main", manifest.repositoryConfig);
    this.decisions = new Map(
      request.commits.map((commit) => [commit.sha, commit.include]),
    );
    if (this.decisions.size !== request.commits.length)
      throw new Error("Duplicate commits in version preparation");
  }

  override processCommits(commits: ConventionalCommit[]): ConventionalCommit[] {
    return commits.filter((commit) => {
      const include = this.decisions.get(commit.sha);
      if (include === undefined)
        throw new Error("Version history changed after preparation");
      return include;
    });
  }
}

export async function versionManifest(
  github: GitHub,
  request: VersionRequest,
): Promise<Manifest> {
  const manifest = await Manifest.fromManifest(
    github,
    "main",
    `releases/${request.app}/config.json`,
    `releases/${request.app}/manifest.json`,
    {
      lastReleaseSha: request.baseline,
      commitSearchDepth: request.commits.length + 1,
      labels: [`version:${request.app}:pending`],
      releaseLabels: [`version:${request.app}:merged`],
    },
  );
  if (manifest.releasedVersions["."]?.toString() !== request.version)
    throw new Error("The version proposal baseline changed after preparation");
  manifest.plugins.push(new VersionInputs(github, manifest, request));
  return manifest;
}

async function prepare(path: string): Promise<void> {
  const request = v.parse(
    VersionRequestSchema,
    JSON.parse(await readFile(path, "utf8")),
  );
  const token = process.env.GH_TOKEN;
  if (!token)
    throw new Error("Version preparation requires its scoped GitHub App token");
  const github = await GitHub.create({
    token,
    owner: "P4suta",
    repo: "public-phonebook",
  });
  const manifest = await versionManifest(github, request);
  const proposals = await manifest.createPullRequests();
  console.info(
    JSON.stringify({
      operation: "version.proposal",
      app: request.app,
      source: request.source,
      proposals: proposals
        .filter((proposal) => proposal !== undefined)
        .map((proposal) => proposal.number),
      publication: "not-requested",
    }),
  );
}

if (import.meta.main) {
  const [path, ...extra] = process.argv.slice(initialArgument);
  if (!path || extra.length)
    throw new Error("Pass one prepared version request");
  try {
    await prepare(path);
  } catch {
    console.error(
      "Version proposal outcome requires reconciliation; no release publication was requested",
    );
    process.exitCode = 1;
  }
}
