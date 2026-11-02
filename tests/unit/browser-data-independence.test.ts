import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import gate from "../../playwright.config.ts";
import { checkFixtureContacts } from "../../tools/check-fixture.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureIdentities = checkFixtureContacts().flatMap(({ id }) => [
  id,
  encodeURIComponent(id),
]);

function namedFixtureIdentities(text: string): readonly string[] {
  return fixtureIdentities.filter((identity) => text.includes(identity));
}

// The release gate runs the whole browser suite on national data, which holds none of the check fixture's contacts.
describe("the national browser suite", () => {
  it("recognizes a fixture contact in its raw and URL forms", () => {
    const [first] = checkFixtureContacts();
    if (!first) throw new Error("The check fixture has no contact");
    expect(namedFixtureIdentities(`fill("${first.id}")`)).toEqual([first.id]);
    expect(
      namedFixtureIdentities(`/id=${encodeURIComponent(first.id)}#/u`),
    ).toEqual([encodeURIComponent(first.id)]);
  });

  it("names no contact that only the check fixture holds", async () => {
    if (!gate.testDir)
      throw new Error("The e2e config names no test directory");
    const directory = resolve(repositoryRoot, gate.testDir);
    const files = (await readdir(directory, { recursive: true })).filter(
      (file) => file.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const named: string[] = [];
    for (const file of files)
      for (const identity of namedFixtureIdentities(
        await readFile(join(directory, file), "utf8"),
      ))
        named.push(`${file}: ${identity}`);
    expect(named).toEqual([]);
  });
});
