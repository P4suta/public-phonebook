import { inspect } from "node:util";
import { expect, it } from "vitest";
import { parseAccessConfiguration } from "../../src/server/staging-access.ts";
import { parseServiceTokenCreation } from "../../tools/staging-access.ts";

it("reports malformed public configuration without dumping surrounding private inputs", () => {
  try {
    parseAccessConfiguration({
      ACCESS_REVIEWERS: "invalid",
      ACCESS_SERVICE_CLIENT_SECRET: "fixture-sensitive-value",
    });
    throw new Error("Invalid configuration was accepted");
  } catch (error) {
    expect(inspect(error)).not.toContain("fixture-sensitive-value");
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error)
      expect(error.message).toBe("Staging access configuration is invalid");
  }
});
it("validates one-time provider credentials without retaining private error payloads", () => {
  const valid = {
    id: "11111111-1111-4111-8111-111111111111",
    client_id: "fixture.access",
    client_secret: "fixture-sensitive-value",
    expires_at: "2027-01-01T00:00:00Z",
  };
  expect(parseServiceTokenCreation(JSON.stringify(valid)).client_id).toBe(
    valid.client_id,
  );
  for (const input of [
    JSON.stringify({ ...valid, id: null }),
    JSON.stringify({ ...valid, expires_at: "invalid" }),
    '{"client_secret":"fixture-sensitive-value",',
  ]) {
    try {
      parseServiceTokenCreation(input);
      throw new Error("Malformed provider credentials were accepted");
    } catch (error) {
      expect(inspect(error)).not.toContain("fixture-sensitive-value");
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error)
        expect(error.message).toBe(
          "Cloudflare did not return a valid staging service identity",
        );
    }
  }
});
