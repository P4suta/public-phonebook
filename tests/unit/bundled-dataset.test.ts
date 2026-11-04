import { expect, it } from "vitest";
import {
  checkBundledDeclaration,
  readBundledDeclaration,
  requireShippedDeclaration,
} from "../../tools/bundled-dataset.ts";
import { readShippedSnapshots } from "../../tools/collection-store.ts";

it("finds the iPhone app's bundled dataset in the shipped list", async () => {
  await expect(checkBundledDeclaration()).resolves.toBeUndefined();
});

it("refuses a bundled dataset outside the shipped list and a snapshot that differs from its entry", async () => {
  const declaration = await readBundledDeclaration();
  const shipped = await readShippedSnapshots();
  expect(() =>
    requireShippedDeclaration(
      { ...declaration, manifestSha256: "f".repeat(64) },
      shipped,
    ),
  ).toThrow(/lacks/u);
  expect(() =>
    requireShippedDeclaration(declaration, { datasets: [] }),
  ).toThrow(/lacks/u);
  expect(() =>
    requireShippedDeclaration(
      { ...declaration, snapshot: "e".repeat(64) },
      shipped,
    ),
  ).toThrow(/lists/u);
});
