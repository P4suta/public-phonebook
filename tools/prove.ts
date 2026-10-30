import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as v from "valibot";
import type { Result } from "../src/core/result.ts";
import { type CommandResult, command, requireCommand } from "./process.ts";
import { fileDigest } from "./snapshot.ts";

const immutableFileMode = 0o444;
const writableFileMode = 0o644;
const lineFeedByte = 10;
const verifiedUnitCount = 13;
const declaredPostconditionCount = 20;
const commandArgumentOffset = 2;
const jsonIndentation = 2;
const verifierExecutable = "/opt/dafny/dafny";

const expected = [
  "canFetchNext",
  "cursorDecision",
  "compatibleRegion",
  "boundedLimit",
  "previewLimit",
  "copyCompletion",
  "copyMethod",
  "stripReferenceStyle",
  "importDecision",
  "canPromote",
];
const boundFiles = [
  "src/core/search-policy.ts",
  "src/core/search.ts",
  "src/core/copy-policy.ts",
  "src/core/reference-style-policy.ts",
  "src/core/publication-policy.ts",
  "tools/cloudflare.ts",
  "tools/remote-statements.ts",
  "tools/seed-database.ts",
  "tools/remote-data.ts",
  "tools/publish.ts",
  "tests/public/playwright.config.ts",
  "tests/public/site.spec.ts",
  "tests/public/api.spec.ts",
  "tests/unit/publication.test.ts",
  "justfile",
  "src/ui/api-reference.tsx",
  "src/ui/api-reference.css.ts",
  "src/ui/reference-accessibility.ts",
  "src/routes/developers.tsx",
  "src/server.ts",
  "tools/reference-styles.ts",
  "vite.config.ts",
  "src/ui/components.tsx",
  "src/ui/clipboard.ts",
  "src/ui/group-results.tsx",
  "src/ui/search-page.tsx",
  "src/server/database.ts",
  "src/core/models.ts",
  "src/core/http-status.ts",
  "src/core/environment.ts",
  "src/server/api.ts",
  "cloudflare.config.ts",
  "tools/prove.ts",
  "tools/process.ts",
  "tools/snapshot.ts",
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
  "src/core/search-policy.ts",
  "src/core/copy-policy.ts",
  "src/core/reference-style-policy.ts",
  "src/core/publication-policy.ts",
];
const modelPaths = proofSources.map(
  (path) => `${proofRoot}/proof/generated/${path.replace(/\.ts$/u, ".dfy")}`,
);

async function generateModel(path: string): Promise<void> {
  const metadata: unknown = JSON.parse(
    await readFile("node_modules/lemmascript/package.json", "utf8"),
  );
  const { bin } = v.parse(
    v.object({ bin: v.object({ lsc: v.string() }) }),
    metadata,
  );
  await requireCommand(
    process.execPath,
    [
      resolve("node_modules/lemmascript", bin.lsc),
      "gen",
      "--backend=dafny",
      path,
    ],
    resolve(proofRoot),
  );
}

async function verifyModel(
  image: string,
  models: readonly string[],
): Promise<CommandResult> {
  const name = `dial-proof-${randomUUID()}`;
  let result: Result<CommandResult, unknown>;
  try {
    result = {
      ok: true,
      value: await command(
        "docker",
        [
          "run",
          "--rm",
          "--platform=linux/amd64",
          "--name",
          name,
          "--network=none",
          "--read-only",
          "--memory=2048m",
          "--memory-swap=2048m",
          "--cpus=2",
          "--pids-limit=256",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs=/tmp:rw,nosuid,size=128m",
          "--mount",
          `type=bind,src=${process.cwd()},dst=/work,readonly`,
          "--workdir=/work",
          "--entrypoint=/usr/bin/timeout",
          image,
          "900",
          verifierExecutable,
          "verify",
          ...models,
          "--resource-limit=5000000",
          "--verification-time-limit=30",
          "--unicode-char=false",
          "--allow-deprecation",
        ],
        true,
      ),
    };
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

async function main(): Promise<void> {
  await mkdir(".local", { recursive: true });
  const lock = await open(".local/proof.lock", "wx");
  try {
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
      ) !== declaredPostconditionCount
    )
      throw new Error("The declared postcondition inventory changed");
    for (const path of proofSources) await generateModel(path);
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
    const build = await command(
      "docker",
      [
        "build",
        "--platform=linux/amd64",
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
    const positive = await verifyModel(image, modelPaths);
    console.info(positive.output);
    if (positive.code !== 0 || !/13 verified, 0 errors/u.test(positive.output))
      throw new Error("The complete proof inventory did not pass");
    const source = await readFile(
      `${proofRoot}/src/core/search-policy.ts`,
      "utf8",
    );
    const broken = source.replace(
      "const maximumSearchLimit = 100;",
      "const maximumSearchLimit = 101;",
    );
    if (broken === source)
      throw new Error(
        "The proof negative control did not mutate the implementation",
      );
    await mkdir(`${proofRoot}/proof/negative`, { recursive: true });
    await writeFile(`${proofRoot}/proof/negative/search-policy.ts`, broken);
    await generateModel("proof/negative/search-policy.ts");
    const negative = await verifyModel(image, [
      `${proofRoot}/proof/generated/proof/negative/search-policy.dfy`,
    ]);
    if (
      negative.code === 0 ||
      !/[1-9][0-9]* error/u.test(negative.output) ||
      !/could not be proved|could not prove/u.test(negative.output)
    )
      throw new Error(
        `The negative control was inconclusive: ${negative.output}`,
      );
    const copySource = await readFile(
      `${proofRoot}/src/core/copy-policy.ts`,
      "utf8",
    );
    for (const control of [
      {
        name: "copy-completion",
        from: 'if (!current) return "superseded";',
        to: 'if (current) return "superseded";',
      },
      {
        name: "copy-trust",
        from: 'if (!trusted) return "blocked";',
        to: 'if (trusted) return "blocked";',
      },
    ]) {
      const brokenCopy = copySource.replace(control.from, control.to);
      if (brokenCopy === copySource)
        throw new Error(
          `The ${control.name} negative control did not mutate the implementation`,
        );
      const path = `proof/negative/${control.name}.ts`;
      await writeFile(`${proofRoot}/${path}`, brokenCopy);
      await generateModel(path);
      const rejected = await verifyModel(image, [
        `${proofRoot}/proof/generated/proof/negative/${control.name}.dfy`,
      ]);
      if (
        rejected.code === 0 ||
        !/[1-9][0-9]* error/u.test(rejected.output) ||
        !/could not be proved|could not prove/u.test(rejected.output)
      )
        throw new Error(
          `The ${control.name} negative control was inconclusive: ${rejected.output}`,
        );
    }
    const referenceSource = await readFile(
      `${proofRoot}/src/core/reference-style-policy.ts`,
      "utf8",
    );
    const brokenReference = referenceSource.replace(
      '    property === "opacity" ||',
      "    false ||",
    );
    if (brokenReference === referenceSource)
      throw new Error(
        "The reference-style negative control did not mutate the implementation",
      );
    await writeFile(
      `${proofRoot}/proof/negative/reference-style-policy.ts`,
      brokenReference,
    );
    await generateModel("proof/negative/reference-style-policy.ts");
    const referenceNegative = await verifyModel(image, [
      `${proofRoot}/proof/generated/proof/negative/reference-style-policy.dfy`,
    ]);
    if (
      referenceNegative.code === 0 ||
      !/[1-9][0-9]* error/u.test(referenceNegative.output) ||
      !/could not be proved|could not prove/u.test(referenceNegative.output)
    )
      throw new Error(
        `The reference-style negative control was inconclusive: ${referenceNegative.output}`,
      );
    const publicationSource = await readFile(
      `${proofRoot}/src/core/publication-policy.ts`,
      "utf8",
    );
    for (const control of [
      {
        name: "import-identity",
        from: 'if (current === "") return "start";',
        to: 'if (current !== "") return "start";',
      },
      {
        name: "promotion-identity",
        from: "    candidate === checkedCandidate &&",
        to: "    candidate !== checkedCandidate &&",
      },
    ]) {
      const brokenPublication = publicationSource.replace(
        control.from,
        control.to,
      );
      if (brokenPublication === publicationSource)
        throw new Error(
          `The ${control.name} negative control did not mutate the implementation`,
        );
      const path = `proof/negative/${control.name}.ts`;
      await writeFile(`${proofRoot}/${path}`, brokenPublication);
      await generateModel(path);
      const rejected = await verifyModel(image, [
        `${proofRoot}/proof/generated/proof/negative/${control.name}.dfy`,
      ]);
      if (
        rejected.code === 0 ||
        !/[1-9][0-9]* error/u.test(rejected.output) ||
        !/could not be proved|could not prove/u.test(rejected.output)
      )
        throw new Error(
          `The ${control.name} negative control was inconclusive: ${rejected.output}`,
        );
    }
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
    await writeFile(
      ".local/proof-receipt.json",
      JSON.stringify(
        {
          bindings,
          image,
          models: modelBindings,
          contracts: expected,
          verifiedUnits: verifiedUnitCount,
          postconditions: declaredPostconditionCount,
          semantics:
            "Dafny integers over validated finite integer limits; JavaScript UTF-16 strings",
          negativeControl:
            "limit 101, reversed copy completion and trust guards, retained reference opacity, import identity, and promotion identity rejected",
          result: "verified",
        },
        null,
        jsonIndentation,
      ),
    );
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
    await requireCommand(process.execPath, [
      "tools/prove.ts",
      "--check-receipt",
    ]);
    console.info(
      JSON.stringify({
        operation: "proof",
        verifiedUnits: verifiedUnitCount,
        postconditions: declaredPostconditionCount,
        negativeControl: "rejected",
        receiptControls: "rejected",
        result: "verified",
      }),
    );
  } finally {
    await lock.close();
    await rm(".local/proof.lock");
  }
}

if (process.argv[commandArgumentOffset] === "--check-receipt") {
  const receipt: unknown = JSON.parse(
    await readFile(".local/proof-receipt.json", "utf8"),
  );
  const parsed = v.parse(
    v.object({
      bindings: v.array(
        v.object({ file: v.string(), input: v.string(), sha256: v.string() }),
      ),
      models: v.array(v.object({ path: v.string(), sha256: v.string() })),
      contracts: v.array(v.string()),
      verifiedUnits: v.literal(verifiedUnitCount),
      postconditions: v.literal(declaredPostconditionCount),
      result: v.literal("verified"),
    }),
    receipt,
  );
  if (parsed.bindings.length !== boundFiles.length)
    throw new Error("Incomplete proof source binding");
  for (const file of boundFiles)
    if (
      parsed.bindings.find((item) => item.file === file)?.sha256 !==
      (await fileDigest(file))
    )
      throw new Error(`Stale proof: ${file}`);
  for (const file of boundFiles) {
    const binding = parsed.bindings.find((item) => item.file === file);
    if (
      !binding ||
      binding.input !== `${proofRoot}/${file}` ||
      (await fileDigest(binding.input)) !== binding.sha256
    )
      throw new Error(`Stale proof input: ${file}`);
  }
  if (
    parsed.models.length !== modelPaths.length ||
    JSON.stringify(parsed.contracts) !== JSON.stringify(expected)
  )
    throw new Error("Incomplete proof model inventory");
  for (const path of modelPaths)
    if (
      parsed.models.find((model) => model.path === path)?.sha256 !==
      (await fileDigest(path))
    )
      throw new Error(`Stale proof model: ${path}`);
} else {
  if (process.argv.length !== commandArgumentOffset)
    throw new Error("Usage: npm run prove [-- --check-receipt]");
  await main();
}
