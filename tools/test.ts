import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { checkDataBundle } from "./check-data.ts";
import { requireCommand } from "./process.ts";
import { releaseLock } from "./release-store.ts";
import { fileDigest } from "./snapshot.ts";
import { cleanTree, saveVerificationReceipt } from "./verification-receipt.ts";

const bundle = resolve(".local/phonebook");
const manifestPath = resolve(bundle, "manifest.ready.json");
const unlock = await releaseLock("build");
try {
  const tree = await cleanTree();
  const manifest = await fileDigest(manifestPath);
  await rm(resolve(".local/test-receipt.json"), { force: true });
  await requireCommand("npm", ["run", "check"]);
  await checkDataBundle(bundle);
  await requireCommand("npm", [
    "run",
    "data:phones",
    "--",
    bundle,
    ".local/phone-quality.json",
  ]);
  await requireCommand("npm", ["run", "prove"]);
  await requireCommand("npm", ["run", "e2e"]);
  if (manifest !== (await fileDigest(manifestPath)))
    throw new Error("The verification dataset changed during testing");
  if (tree && tree === (await cleanTree()))
    await saveVerificationReceipt(tree, manifest);
  else if (tree) throw new Error("The committed source changed during testing");
  console.info(
    JSON.stringify({
      operation: "test",
      sourceTree: tree,
      manifestSha256: manifest,
      receipt: tree ? "recorded" : "dirty-source",
      result: "passed",
    }),
  );
} finally {
  await unlock();
}
