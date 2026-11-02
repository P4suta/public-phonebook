import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  cacheVolumes,
  checkOutcome,
  containerArguments,
  containerLimits,
  containerPlatform,
  imageParity,
  inventoryPaths,
  lockedPlaywright,
} from "../../tools/check-linux.ts";

const repository = "/checkout/public-phonebook";
const evidence = `${repository}/.local/check-linux/verify`;
const run = {
  name: "public-phonebook-check-linux-test",
  image: `sha256:${"a".repeat(64)}`,
  source: repository,
  evidence,
  steps: ["just", "check"],
};

function option(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
}

function mounts(args: readonly string[]): readonly string[] {
  return args.flatMap((arg, index) =>
    args[index - 1] === "--mount" ? [arg] : [],
  );
}

describe("Linux check container arguments", () => {
  const args = containerArguments(run);

  it("mounts the checkout read-only and keeps every writable path separate", () => {
    expect(mounts(args)).toEqual([
      `type=bind,src=${repository},dst=/src,readonly`,
      `type=bind,src=${evidence},dst=/evidence`,
      ...cacheVolumes.map(
        (volume) => `type=volume,src=${volume.name},dst=${volume.target}`,
      ),
    ]);
    for (const output of [
      "node_modules",
      "tools/ios-check/target",
      "test-results",
      "dist",
    ])
      expect(args.some((arg) => arg.includes(`${repository}/${output}`))).toBe(
        false,
      );
    expect(cacheVolumes.map((volume) => volume.target)).toContain(
      "/work/tools/ios-check/target",
    );
    expect(option(args, "workdir")).toBe("/src");
  });

  it("bounds processors, memory, swap, processes, and time", () => {
    expect(option(args, "platform")).toBe(containerPlatform);
    expect(containerPlatform).toBe("linux/arm64");
    expect(option(args, "cpus")).toBe(String(containerLimits.cpus));
    expect(option(args, "memory")).toBe(`${containerLimits.memoryMib}m`);
    expect(option(args, "memory-swap")).toBe(option(args, "memory"));
    expect(containerLimits.swapMib).toBe(0);
    expect(option(args, "pids-limit")).toBe(String(containerLimits.processes));
    expect(option(args, "shm-size")).toBe(
      `${containerLimits.sharedMemoryMib}m`,
    );
    expect(option(args, "entrypoint")).toBe("/usr/bin/timeout");
    const image = args.indexOf(run.image);
    expect(args[image + 1]).toBe(String(containerLimits.safetyStopSeconds));
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--rm");
  });

  it("runs the Verify environment and the requested command after the image", () => {
    expect(args).toContain("--env=CI=true");
    expect(args).toContain("--env=CARGO_BUILD_JOBS=2");
    expect(args).toContain("--env=MISE_TRUSTED_CONFIG_PATHS=/src:/work");
    const image = args.indexOf(run.image);
    expect(args.slice(image + 2)).toEqual([
      "mise",
      "x",
      "--",
      "node",
      "/src/tools/check-linux.ts",
      "--inside",
      "just",
      "check",
    ]);
    expect(args.slice(0, image).every((arg) => !arg.includes("just"))).toBe(
      true,
    );
  });

  it("refuses a run without a command", () => {
    expect(() => containerArguments({ ...run, steps: [] })).toThrow(
      "needs a command",
    );
  });
});

describe("Linux check inventory and outcome", () => {
  it("deduplicates relative publishable paths", () => {
    expect(inventoryPaths("a.ts\0src/b.ts\0a.ts\0")).toEqual([
      "a.ts",
      "src/b.ts",
    ]);
  });

  it("refuses paths that escape the copy", () => {
    for (const path of ["/etc/passwd", "../outside", "src/../../x", "./a"])
      expect(() => inventoryPaths(`ok.ts\0${path}`)).toThrow(
        "Unsafe inventory path",
      );
  });

  it("separates limit stops from failures", () => {
    expect(checkOutcome(0, false)).toBe("passed");
    expect(checkOutcome(1, false)).toBe("failed");
    expect(checkOutcome(124, false)).toBe("inconclusive");
    expect(checkOutcome(137, true)).toBe("inconclusive");
  });
});

describe("Linux check image parity", () => {
  it("pins the locked Playwright release and the CI mise version", async () => {
    const dockerfile = await readFile("verification/linux/Dockerfile", "utf8");
    const action = await readFile(
      ".github/actions/toolchain/action.yml",
      "utf8",
    );
    const playwright = await lockedPlaywright();
    expect(imageParity(dockerfile, action, playwright)).toEqual([]);
    expect(imageParity(dockerfile, action, "0.0.1")).toEqual([
      `The image's Playwright ${playwright} differs from the locked 0.0.1`,
    ]);
    expect(
      imageParity(
        dockerfile,
        action.replace(/version: "[^"]+"/u, 'version: "0.0.1"'),
        playwright,
      ),
    ).toHaveLength(1);
    expect(
      imageParity(
        dockerfile.replace(/@sha256:[0-9a-f]{64}$/mu, ""),
        action,
        playwright,
      ),
    ).toHaveLength(1);
  });
});
