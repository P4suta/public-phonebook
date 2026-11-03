import { describe, expect, it } from "vitest";
import { memoryBudget, type ProbeClock } from "../../tools/probe-budget.ts";
import {
  admittedOrigin,
  answersExpectedVersion,
  awaitExpectedVersion,
  checkedFetch,
  consecutiveVersionAnswers,
  type PublicAccess,
  publicAccess,
  rehearsalOrigin,
  rehearsalRequested,
  VersionMismatch,
  versionOverride,
  versionOverrideHeader,
} from "../../tools/public-request.ts";

const origin = "https://www.dial.page";
const candidate = "22222222-2222-4222-8222-222222222222";
const current = "11111111-1111-4111-8111-111111111111";
const clock: ProbeClock = {
  now: () => 0,
  sleep: async (): Promise<void> => {},
};

function access(version: PublicAccess["version"]): PublicAccess {
  return { origin, rehearsal: false, version, budget: memoryBudget(clock) };
}

function answering(version: string | null): typeof fetch {
  return async (): Promise<Response> =>
    new Response("{}", {
      headers: version ? { "x-dial-version": version } : {},
    });
}

describe("public verification requests", () => {
  it("sends the version override only for a candidate and never forwards credentials or follows redirects", async () => {
    let seen = new Headers();
    await checkedFetch(
      "/api",
      {
        headers: {
          cookie: "fixture",
          authorization: "fixture",
          [versionOverrideHeader]: 'dial-production="forged"',
        },
      },
      access({ id: candidate, mode: "override" }),
      async (url, init): Promise<Response> => {
        expect(url instanceof Request ? url.url : url.toString()).toBe(
          `${origin}/api`,
        );
        expect(init?.redirect).toBe("manual");
        seen = new Headers(init?.headers);
        return new Response(null, { headers: { "x-dial-version": candidate } });
      },
    );
    expect(seen.get(versionOverrideHeader)).toBe(
      `dial-production="${candidate}"`,
    );
    expect(seen.has("cookie")).toBe(false);
    expect(seen.has("authorization")).toBe(false);
    await checkedFetch(
      "/api",
      { headers: { [versionOverrideHeader]: "inherited" } },
      access({ id: current, mode: "required" }),
      async (_url, init): Promise<Response> => {
        seen = new Headers(init?.headers);
        return new Response(null, { headers: { "x-dial-version": current } });
      },
    );
    expect(seen.has(versionOverrideHeader)).toBe(false);
  });

  it("asks for identity unless the caller names the content codings it decodes", async () => {
    const codings: (string | null)[] = [];
    const recording: typeof fetch = async (_url, init): Promise<Response> => {
      codings.push(new Headers(init?.headers).get("accept-encoding"));
      return new Response(null);
    };
    await checkedFetch("/api", {}, access(null), recording);
    await checkedFetch(
      "/api",
      { headers: { "Accept-Encoding": "gzip, deflate, br" } },
      access(null),
      recording,
    );
    expect(codings).toEqual(["identity", "gzip, deflate, br"]);
  });

  it("refuses a response that a different or unlabeled version answered", async () => {
    const override = access({ id: candidate, mode: "override" });
    await expect(
      checkedFetch("/api", {}, override, answering(current)),
    ).rejects.toBeInstanceOf(VersionMismatch);
    await expect(
      checkedFetch("/api", {}, override, answering(null)),
    ).rejects.toBeInstanceOf(VersionMismatch);
    const error = await checkedFetch(
      "/api",
      {},
      override,
      answering(current),
    ).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(candidate);
    expect(answersExpectedVersion(null, null)).toBe(true);
    expect(
      answersExpectedVersion({ id: current, mode: "optional" }, null),
    ).toBe(true);
    expect(
      answersExpectedVersion({ id: current, mode: "optional" }, candidate),
    ).toBe(false);
    expect(
      answersExpectedVersion({ id: current, mode: "required" }, null),
    ).toBe(false);
  });

  it("refuses other origins and malformed versions before any request", async () => {
    let calls = 0;
    const transport: typeof fetch = async (): Promise<Response> => {
      calls += 1;
      return new Response();
    };
    await expect(
      checkedFetch("https://external.invalid/", {}, access(null), transport),
    ).rejects.toThrow("outside its configured origin");
    await expect(
      checkedFetch(
        "/api",
        {},
        { ...access(null), origin: origin.replace("https:", "http:") },
        transport,
      ),
    ).rejects.toThrow("exact configured public origin");
    expect(calls).toBe(0);
    expect(() => versionOverride("not-a-version")).toThrow();
    expect(() =>
      publicAccess({
        DIAL_PUBLIC_VERSION: candidate,
        DIAL_PUBLIC_VERSION_MODE: "any",
      }),
    ).toThrow();
    expect(
      publicAccess({
        DIAL_PUBLIC_ORIGIN: origin,
        DIAL_PUBLIC_VERSION: candidate,
        DIAL_PUBLIC_VERSION_MODE: "override",
      }).version,
    ).toEqual({ id: candidate, mode: "override" });
  });

  it("admits the loopback preview only in a rehearsal and the public site only outside one", async () => {
    let calls = 0;
    const transport: typeof fetch = async (): Promise<Response> => {
      calls += 1;
      return new Response();
    };
    expect(admittedOrigin(origin, false)).toBe(true);
    expect(admittedOrigin(rehearsalOrigin, true)).toBe(true);
    expect(admittedOrigin(rehearsalOrigin, false)).toBe(false);
    expect(admittedOrigin(origin, true)).toBe(false);
    expect(admittedOrigin("https://localhost:8791", true)).toBe(false);
    await expect(
      checkedFetch(
        "/api",
        {},
        { ...access(null), origin: rehearsalOrigin },
        transport,
      ),
    ).rejects.toThrow("exact configured public origin");
    await expect(
      checkedFetch("/api", {}, { ...access(null), rehearsal: true }, transport),
    ).rejects.toThrow("exact configured public origin");
    expect(calls).toBe(0);
    await checkedFetch(
      "/api",
      {},
      { ...access(null), origin: rehearsalOrigin, rehearsal: true },
      transport,
    );
    expect(calls).toBe(1);
    expect(rehearsalRequested({})).toBe(false);
    expect(rehearsalRequested({ DIAL_PUBLIC_REHEARSAL: "preview" })).toBe(true);
    expect(() => rehearsalRequested({ DIAL_PUBLIC_REHEARSAL: "1" })).toThrow();
    expect(
      publicAccess({
        DIAL_PUBLIC_ORIGIN: rehearsalOrigin,
        DIAL_PUBLIC_REHEARSAL: "preview",
      }).rehearsal,
    ).toBe(true);
  });

  it("waits for consecutive candidate answers before the checks start", async () => {
    const answers = [
      current,
      candidate,
      current,
      candidate,
      candidate,
      candidate,
    ];
    let index = 0;
    const transport: typeof fetch = async (): Promise<Response> =>
      answering(answers[index++] ?? null)("/");
    expect(
      await awaitExpectedVersion(
        access({ id: candidate, mode: "override" }),
        transport,
        clock,
      ),
    ).toBe(answers.length);
    expect(consecutiveVersionAnswers).toBe(3);
    await expect(
      awaitExpectedVersion(
        access({ id: candidate, mode: "override" }),
        answering(current),
        clock,
      ),
    ).rejects.toThrow("didn't answer consecutive requests");
  });
});
