import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AccessConfiguration,
  createAccessVerifier,
} from "../../src/server/staging-access.ts";

const configuration: AccessConfiguration = {
  PUBLIC_ORIGIN: "https://staging.dial.page",
  ACCESS_ISSUER: "https://fixture.cloudflareaccess.com",
  ACCESS_AUDIENCE: "fixture",
  ACCESS_REVIEWERS: ["reviewer@example.com"],
  ACCESS_SERVICE_CLIENT_ID: "fixture.access",
};
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: string;
beforeAll(async () => {
  key = await generateKeyPair("RS256", { extractable: true });
  jwks = JSON.stringify({
    keys: [
      { ...(await exportJWK(key.publicKey)), kid: "fixture", alg: "RS256" },
    ],
  });
});

describe("Cloudflare Access assertion verification", () => {
  it("validates the signature and claims against only the configured public key endpoint", async () => {
    let calls = 0;
    const verify = createAccessVerifier(
      async (input, init): Promise<Response> => {
        expect(input instanceof Request ? input.url : input.toString()).toBe(
          `${configuration.ACCESS_ISSUER}/cdn-cgi/access/certs`,
        );
        expect(new Headers(init?.headers).has("cf-access-client-secret")).toBe(
          false,
        );
        calls += 1;
        return new Response(jwks, {
          headers: { "content-type": "application/json" },
        });
      },
    );
    const token = await new SignJWT({
      type: "app",
      email: configuration.ACCESS_REVIEWERS[0],
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "fixture",
        jku: "https://attacker.invalid/keys",
      })
      .setIssuer(configuration.ACCESS_ISSUER)
      .setAudience(configuration.ACCESS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key.privateKey);
    expect((await verify(token, configuration)).email).toBe(
      configuration.ACCESS_REVIEWERS[0],
    );
    await verify(token, configuration);
    expect(calls).toBe(1);
  });

  it("rejects expired, future, missing, mismatched and tampered assertions", async () => {
    const verify = createAccessVerifier(
      async (): Promise<Response> => new Response(jwks),
    );
    const now = Math.floor(Date.now() / 1000);
    const valid = {
      type: "app",
      iss: configuration.ACCESS_ISSUER,
      aud: configuration.ACCESS_AUDIENCE,
      iat: now,
      exp: now + 3600,
    };
    const { exp: _expiration, ...missingExpiration } = valid;
    const { iat: _issued, ...missingIssued } = valid;
    for (const payload of [
      { ...valid, exp: now - 1 },
      { ...valid, iat: now + 60 },
      missingExpiration,
      missingIssued,
      { ...valid, iss: "https://attacker.invalid" },
      { ...valid, aud: "other" },
      { ...valid, iat: now - 18000 },
    ]) {
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .sign(key.privateKey);
      await expect(verify(token, configuration)).rejects.toThrow();
    }
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT(valid)
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .sign(other.privateKey);
    await expect(verify(forged, configuration)).rejects.toThrow();
    const wrongAlgorithm = await new SignJWT(valid)
      .setProtectedHeader({ alg: "HS256" })
      .sign(new Uint8Array(32));
    await expect(verify(wrongAlgorithm, configuration)).rejects.toThrow();
  });

  it("fails closed when the public key service is unavailable", async () => {
    const verify = createAccessVerifier(
      async (): Promise<Response> =>
        new Response("unavailable", { status: 503 }),
    );
    const token = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(configuration.ACCESS_ISSUER)
      .setAudience(configuration.ACCESS_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key.privateKey);
    await expect(verify(token, configuration)).rejects.toThrow();
  });
});
