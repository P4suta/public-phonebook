import { randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";
import type { Result } from "../src/core/result.ts";
import { type CommandResult, command, requireCommand } from "./process.ts";

/** The Verify job runs on linux/amd64, so native npm binaries differ by architecture. */
export const containerPlatform = "linux/arm64";
// The hosted ubuntu-24.04 runner has 4 vCPUs and 16 GiB of memory.
const cpuLimit = 4;
const memoryLimitMib = 8192;
const processLimit = 4096;
const sharedMemoryMib = 1024;
const safetyStopSeconds = 3600;
// The assurance workflow's Linux jobs set CARGO_BUILD_JOBS to 2.
const cargoBuildJobs = 2;
const safetyStopExitCode = 124;
const commandArgumentOffset = 2;
const jsonIndentation = 2;
const millisecondsPerSecond = 1000;

const sourceMount = "/src";
const workTree = "/work";
const evidenceMount = "/evidence";
const timeoutExecutable = "/usr/bin/timeout";
const cgroupRoot = "/sys/fs/cgroup";
const imageTag = "public-phonebook-check-linux:local";
const imageDefinition = "verification/linux/Dockerfile";
const toolchainDefinition = "mise.toml";
const toolchainAction = ".github/actions/toolchain/action.yml";
const lockFile = "package-lock.json";
const evidenceRoot = ".local/check-linux";
const runLock = ".local/check-linux.lock";
const inventoryFile = "inventory";
const copiedFile = "copied";
const containerRecord = "container.json";
const verifyCommand = ["just", "check"] as const;
const corpusTestName = "reproduces the exact provider corpus";
const corpusTest = [
  "npm",
  "exec",
  "--no",
  "--",
  "vitest",
  "run",
  "tests/unit/native-contract.test.ts",
  "--testNamePattern",
  corpusTestName,
] as const;
const plantedFixture = "tools/directory-fixture.ts";
const plantedArchive = "contacts.jsonl.gz";
const portableGzipHeader =
  "  bytes[gzipOperatingSystemOffset] = gzipUnknownOperatingSystem;\n";

export const containerLimits = {
  cpus: cpuLimit,
  memoryMib: memoryLimitMib,
  swapMib: 0,
  processes: processLimit,
  sharedMemoryMib,
  safetyStopSeconds,
} as const;

export const cacheVolumes = [
  { name: "public-phonebook-check-linux-npm", target: "/home/pwuser/.npm" },
  {
    name: "public-phonebook-check-linux-cargo-registry",
    target: "/opt/cargo/registry",
  },
  {
    name: "public-phonebook-check-linux-cargo-target",
    target: `${workTree}/tools/ios-check/target`,
  },
] as const;

export interface ContainerRun {
  readonly name: string;
  readonly image: string;
  readonly source: string;
  readonly evidence: string;
  readonly steps: readonly string[];
}

export type CheckOutcome = "passed" | "failed" | "inconclusive";

interface ContainerResult {
  readonly code: number;
  readonly oomKilled: boolean;
  readonly seconds: number;
  readonly output: string;
}

interface ImageBuild {
  readonly image: string;
  readonly seconds: number;
}

export function containerArguments(run: ContainerRun): readonly string[] {
  if (run.steps.length === 0) throw new Error("The container needs a command");
  return [
    "run",
    `--name=${run.name}`,
    `--platform=${containerPlatform}`,
    "--init",
    `--cpus=${cpuLimit}`,
    `--memory=${memoryLimitMib}m`,
    `--memory-swap=${memoryLimitMib}m`,
    `--pids-limit=${processLimit}`,
    `--shm-size=${sharedMemoryMib}m`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--mount",
    `type=bind,src=${run.source},dst=${sourceMount},readonly`,
    "--mount",
    `type=bind,src=${run.evidence},dst=${evidenceMount}`,
    ...cacheVolumes.flatMap((volume) => [
      "--mount",
      `type=volume,src=${volume.name},dst=${volume.target}`,
    ]),
    "--env=CI=true",
    `--env=CARGO_BUILD_JOBS=${cargoBuildJobs}`,
    `--env=MISE_TRUSTED_CONFIG_PATHS=${sourceMount}:${workTree}`,
    `--workdir=${sourceMount}`,
    `--entrypoint=${timeoutExecutable}`,
    run.image,
    String(safetyStopSeconds),
    "mise",
    "x",
    "--",
    "node",
    `${sourceMount}/tools/check-linux.ts`,
    "--inside",
    ...run.steps,
  ];
}

export function checkOutcome(code: number, oomKilled: boolean): CheckOutcome {
  if (oomKilled || code === safetyStopExitCode) return "inconclusive";
  return code === 0 ? "passed" : "failed";
}

export function inventoryPaths(listing: string): readonly string[] {
  const paths = [...new Set(listing.split("\0").filter(Boolean))];
  for (const path of paths)
    if (
      isAbsolute(path) ||
      normalize(path) !== path ||
      path.split("/").includes("..")
    )
      throw new Error(`Unsafe inventory path: ${path}`);
  return paths;
}

const playwrightBase =
  /^FROM \S+\/playwright:v(?<version>\d+\.\d+\.\d+)-noble@sha256:[0-9a-f]{64}$/mu;
const miseBinary =
  /^COPY --from=\S+\/mise:(?<version>\d+\.\d+\.\d+)@sha256:[0-9a-f]{64} /mu;
const actionMise = /^\s+version: "(?<version>\d+\.\d+\.\d+)"$/mu;

export function imageParity(
  dockerfile: string,
  action: string,
  lockedPlaywright: string,
): readonly string[] {
  const problems: string[] = [];
  const playwright = playwrightBase.exec(dockerfile)?.groups?.version;
  if (playwright !== lockedPlaywright)
    problems.push(
      `The image's Playwright ${playwright ?? "base"} differs from the locked ${lockedPlaywright}`,
    );
  const mise = miseBinary.exec(dockerfile)?.groups?.version;
  const ciMise = actionMise.exec(action)?.groups?.version;
  if (mise === undefined || mise !== ciMise)
    problems.push(
      `The image's mise ${mise ?? "binary"} differs from the toolchain action's ${ciMise ?? "version"}`,
    );
  return problems;
}

export async function lockedPlaywright(): Promise<string> {
  const v = await import("valibot");
  const lock: unknown = JSON.parse(await readFile(lockFile, "utf8"));
  return v.parse(
    v.object({
      packages: v.object({
        "node_modules/playwright-core": v.object({ version: v.string() }),
      }),
    }),
    lock,
  ).packages["node_modules/playwright-core"].version;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) / millisecondsPerSecond);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function copyInventory(
  from: string,
  to: string,
  paths: readonly string[],
): Promise<readonly string[]> {
  const copied: string[] = [];
  for (const path of paths) {
    const target = join(to, path);
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(from, path), target);
      copied.push(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return copied;
}

async function cgroupPeak(file: string): Promise<number | null> {
  try {
    return Number((await readFile(join(cgroupRoot, file), "utf8")).trim());
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function inside(steps: readonly string[]): Promise<void> {
  const [executable, ...args] = steps;
  if (!executable) throw new Error("The container needs a command");
  const started = performance.now();
  const copied = await copyInventory(
    sourceMount,
    workTree,
    inventoryPaths(await readFile(join(evidenceMount, inventoryFile), "utf8")),
  );
  await writeFile(join(evidenceMount, copiedFile), copied.join("\0"));
  await requireCommand(
    "git",
    ["-c", "init.defaultBranch=main", "init", "--quiet"],
    workTree,
  );
  await requireCommand(
    "git",
    [
      "--literal-pathspecs",
      "add",
      `--pathspec-from-file=${join(evidenceMount, copiedFile)}`,
      "--pathspec-file-nul",
    ],
    workTree,
  );
  const copySeconds = elapsed(started);
  const installStarted = performance.now();
  const install = await command(
    "npm",
    ["ci", "--ignore-scripts"],
    false,
    workTree,
  );
  const installSeconds = elapsed(installStarted);
  const checkStarted = performance.now();
  const check =
    install.code === 0
      ? await command(executable, args, false, workTree)
      : null;
  const checkSeconds = check ? elapsed(checkStarted) : null;
  const code = check?.code ?? install.code;
  if (code !== 0)
    try {
      await cp(
        join(workTree, "test-results"),
        join(evidenceMount, "test-results"),
        { recursive: true },
      );
    } catch (error) {
      if (!missing(error)) throw error;
    }
  await writeFile(
    join(evidenceMount, containerRecord),
    JSON.stringify(
      {
        command: steps,
        node: process.version,
        architecture: process.arch,
        copiedFiles: copied.length,
        copySeconds,
        installExitCode: install.code,
        installSeconds,
        checkExitCode: check?.code ?? null,
        checkSeconds,
        memoryPeakBytes: await cgroupPeak("memory.peak"),
        processPeak: await cgroupPeak("pids.peak"),
      },
      null,
      jsonIndentation,
    ),
  );
  process.exitCode = code;
}

async function buildImage(): Promise<ImageBuild> {
  const context = resolve(evidenceRoot, "image");
  await rm(context, { recursive: true, force: true });
  await mkdir(context, { recursive: true });
  for (const file of [imageDefinition, toolchainDefinition])
    await copyFile(file, join(context, basename(file)));
  const identity = join(context, "image-id");
  const started = performance.now();
  await requireCommand("docker", [
    "build",
    `--platform=${containerPlatform}`,
    "--provenance=false",
    `--tag=${imageTag}`,
    `--iidfile=${identity}`,
    `--file=${join(context, basename(imageDefinition))}`,
    context,
  ]);
  const image = (await readFile(identity, "utf8")).trim();
  if (!/^sha256:[0-9a-f]{64}$/u.test(image))
    throw new Error(`The check image has no immutable identity: ${image}`);
  return { image, seconds: elapsed(started) };
}

async function observe(run: ContainerRun): Promise<ContainerResult> {
  const started = performance.now();
  const { code } = await command("docker", containerArguments(run));
  const seconds = elapsed(started);
  const state = await command(
    "docker",
    ["inspect", "--format={{.State.OOMKilled}}", run.name],
    true,
  );
  const logs = await command("docker", ["logs", run.name], true);
  if (state.code !== 0 || logs.code !== 0)
    throw new Error(
      `Could not read the check container: ${state.output}${logs.output}`,
    );
  await writeFile(join(run.evidence, "output.log"), logs.output);
  return {
    code,
    oomKilled: state.stdout.trim() === "true",
    seconds,
    output: logs.output,
  };
}

async function runContainer(
  run: ContainerRun,
  paths: readonly string[],
): Promise<ContainerResult> {
  await rm(run.evidence, { recursive: true, force: true });
  await mkdir(run.evidence, { recursive: true });
  await writeFile(join(run.evidence, inventoryFile), paths.join("\0"));
  let result: Result<ContainerResult, unknown>;
  try {
    result = { ok: true, value: await observe(run) };
  } catch (error) {
    result = { ok: false, error };
  }
  const cleanup = await command("docker", ["rm", "--force", run.name], true);
  if (cleanup.code !== 0 && !cleanup.output.includes("No such container"))
    throw new AggregateError(
      result.ok ? [] : [result.error],
      `Check container cleanup failed: ${cleanup.output}`,
    );
  if (!result.ok) throw result.error;
  return result.value;
}

function containerName(): string {
  return `public-phonebook-check-linux-${randomUUID()}`;
}

async function readRecord(path: string): Promise<unknown> {
  try {
    const record: unknown = JSON.parse(await readFile(path, "utf8"));
    return record;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function requireOutput(
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  const result = await command(executable, args, true);
  if (result.code !== 0)
    throw new Error(`Command failed (${result.code}): ${result.output}`);
  return result;
}

async function verify(
  build: ImageBuild,
  paths: readonly string[],
): Promise<void> {
  const evidence = resolve(evidenceRoot, "verify");
  const result = await runContainer(
    {
      name: containerName(),
      image: build.image,
      source: process.cwd(),
      evidence,
      steps: verifyCommand,
    },
    paths,
  );
  const head = await requireOutput("git", ["rev-parse", "HEAD"]);
  const status = await requireOutput("git", ["status", "--porcelain"]);
  const outcome = checkOutcome(result.code, result.oomKilled);
  const summary = {
    operation: "check-linux",
    outcome,
    exitCode: result.code,
    oomKilled: result.oomKilled,
    platform: containerPlatform,
    image: build.image,
    head: head.stdout.trim(),
    uncommittedPaths: status.stdout.split("\n").filter(Boolean).length,
    inventory: paths.length,
    buildSeconds: build.seconds,
    runSeconds: result.seconds,
  };
  await writeFile(
    join(evidence, "receipt.json"),
    JSON.stringify(
      {
        ...summary,
        limits: containerLimits,
        volumes: cacheVolumes,
        container: await readRecord(join(evidence, containerRecord)),
      },
      null,
      jsonIndentation,
    ),
  );
  console.info(JSON.stringify({ ...summary, evidence: evidenceRoot }));
  process.exitCode = result.code;
}

async function control(image: string, paths: readonly string[]): Promise<void> {
  const root = resolve(evidenceRoot, "control");
  const tree = join(root, "tree");
  await rm(root, { recursive: true, force: true });
  await copyInventory(process.cwd(), tree, paths);
  const fixture = join(tree, plantedFixture);
  const portable = await readFile(fixture, "utf8");
  const planted = portable.replace(portableGzipHeader, "");
  if (planted === portable)
    throw new Error("The control didn't remove the portable gzip header");
  await writeFile(fixture, planted);
  await symlink(resolve("node_modules"), join(tree, "node_modules"));
  await requireCommand(
    process.execPath,
    ["tools/native-fixture.ts", "--write-corpus"],
    tree,
  );
  const [executable, ...args] = corpusTest;
  const host = await command(executable, args, false, tree);
  if (host.code !== 0)
    throw new Error(
      "macOS rejected its own planted corpus, so the control is inconclusive",
    );
  const baseline = await runContainer(
    {
      name: containerName(),
      image,
      source: process.cwd(),
      evidence: join(root, "baseline"),
      steps: corpusTest,
    },
    paths,
  );
  if (baseline.code !== 0)
    throw new Error(
      `Linux rejected the unchanged corpus, so the control is inconclusive (${baseline.code})`,
    );
  const rejected = await runContainer(
    {
      name: containerName(),
      image,
      source: tree,
      evidence: join(root, "planted"),
      steps: corpusTest,
    },
    paths,
  );
  if (
    checkOutcome(rejected.code, rejected.oomKilled) !== "failed" ||
    !rejected.output.includes("AssertionError") ||
    !rejected.output.includes(corpusTestName) ||
    !rejected.output.includes(plantedArchive)
  )
    throw new Error(
      `Linux didn't reject the planted gzip byte with the corpus assertion (${rejected.code})`,
    );
  const receipt = {
    operation: "check-linux-control",
    planted: `${plantedFixture} keeps the host gzip operating system byte, and macOS rewrote the corpus`,
    macos: "accepted",
    linuxBaseline: "accepted",
    linuxPlanted: "rejected",
    image,
    platform: containerPlatform,
  };
  await writeFile(
    join(root, "receipt.json"),
    JSON.stringify(receipt, null, jsonIndentation),
  );
  console.info(JSON.stringify(receipt));
}

async function host(mode: "verify" | "control"): Promise<void> {
  await mkdir(".local", { recursive: true });
  const lock = await open(runLock, "wx");
  try {
    const problems = imageParity(
      await readFile(imageDefinition, "utf8"),
      await readFile(toolchainAction, "utf8"),
      await lockedPlaywright(),
    );
    if (problems.length > 0) throw new Error(problems.join("\n"));
    const listing = await requireOutput("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const paths = inventoryPaths(listing.stdout);
    const build = await buildImage();
    if (mode === "verify") await verify(build, paths);
    else await control(build.image, paths);
  } finally {
    await lock.close();
    await rm(runLock);
  }
}

if (import.meta.main) {
  const [mode, ...rest] = process.argv.slice(commandArgumentOffset);
  if (mode === "--inside") await inside(rest);
  else if (mode === undefined) await host("verify");
  else if (mode === "--control" && rest.length === 0) await host("control");
  else throw new Error("Usage: just check-linux [--control]");
}
