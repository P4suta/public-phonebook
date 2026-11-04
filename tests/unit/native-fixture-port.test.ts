import { describe, expect, it } from "vitest";
import { fixturePort } from "../../tools/directory-fixture.ts";
import { servePort } from "../../tools/native-fixture.ts";

const gatePort = 51_234;
const highestPort = 65_535;

describe("native fixture port", () => {
  it("serves on the development port unless the iOS gate names one", () => {
    expect(servePort({})).toBe(fixturePort);
    expect(servePort({ PHONEBOOK_FIXTURE_PORT: String(gatePort) })).toBe(
      gatePort,
    );
    expect(servePort({ PHONEBOOK_FIXTURE_PORT: String(highestPort) })).toBe(
      highestPort,
    );
  });

  it("refuses a port that isn't a whole number from 1 through 65535", () => {
    for (const port of ["0", "65536", "-1", "3100.5", "", "port", " 3100"])
      expect(() => servePort({ PHONEBOOK_FIXTURE_PORT: port }), port).toThrow();
  });
});
