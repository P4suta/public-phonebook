import { readShippedSnapshots } from "@public-phonebook/cloudflare/collection-store";
import {
  checkBundledDeclaration,
  readBundledDeclaration,
  requireShippedDeclaration,
} from "@public-phonebook/data/bundled-dataset";
import { expect, it } from "vitest";

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
