import * as fc from "fast-check";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { ContactSchema } from "../../src/core/models.ts";
import {
  cleanAddress,
  nameTokens,
  normalizeName,
  parseSearch,
  rankName,
  searchKey,
} from "../../src/core/search.ts";
import {
  parseSearchString,
  parseWebSearch,
} from "../../src/core/web-search.ts";

describe("search contract", () => {
  it("binds cursors to telephone identities without conflating number-like names", async () => {
    const keys = new Map<string, string>();
    for (const q of [
      "03-3581-2331",
      "０３－３５８１－２３３１",
      "+81 3 3581 2331",
      "⓪③-3581-2331",
      "03\n35812331",
    ]) {
      const parsed = parseSearch(new URLSearchParams({ q }));
      if (!parsed.ok) throw new Error("Query fixture rejected");
      keys.set(q, await searchKey(parsed.value));
    }
    expect(keys.get("03-3581-2331")).toBe(keys.get("０３－３５８１－２３３１"));
    expect(keys.get("03-3581-2331")).toBe(keys.get("+81 3 3581 2331"));
    expect(keys.get("03-3581-2331")).not.toBe(keys.get("⓪③-3581-2331"));
    expect(keys.get("03-3581-2331")).not.toBe(keys.get("03\n35812331"));
  });
  it("uses fixed-size normalized query identities", async () => {
    const first = parseSearch(new URLSearchParams({ q: "ＡＢＣ" }));
    const second = parseSearch(new URLSearchParams({ q: "abc" }));
    const expanded = parseSearch(
      new URLSearchParams({ q: "\uFDFA".repeat(170) }),
    );
    if (!first.ok || !second.ok || !expanded.ok)
      throw new Error("Valid query rejected");
    expect(await searchKey(first.value)).toMatch(/^[a-f0-9]{64}$/);
    expect(await searchKey(first.value)).toBe(await searchKey(second.value));
    expect(await searchKey(expanded.value)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("bounds sortable names and stable IDs before creating a page cursor", () => {
    expect(
      v.safeParse(ContactSchema.entries.name, "a".repeat(385)).success,
    ).toBe(false);
    expect(v.safeParse(ContactSchema.entries.id, "a".repeat(257)).success).toBe(
      false,
    );
  });
  it("rejects ambiguous, unknown, oversized, or conflicting input", () => {
    for (const query of [
      "q=a&q=b",
      "debug=1",
      "__proto__=x",
      "constructor=x",
      "toString=x",
      "prefecture=00",
      "prefecture=48",
      "municipality=99999",
      "prefecture=13&municipality=14100",
      "limit=0",
      "limit=101",
      "limit=1.5",
      "cursor=%7B",
      `q=${"あ".repeat(171)}`,
    ]) {
      expect(parseSearch(new URLSearchParams(query)).ok, query).toBe(false);
    }
  });
  it("preserves unknown and duplicate website keys for rejection", () => {
    for (const query of [
      "?__proto__=x",
      "?constructor=x",
      "?toString=x",
      "?q=a&q=b",
    ]) {
      expect(parseWebSearch(parseSearchString(query)).ok, query).toBe(false);
    }
  });
  it("normalizes width and case and treats SQL metacharacters literally", () => {
    expect(normalizeName(" ＡＢＣ図書館 ")).toBe("abc図書館");
    expect(parseSearch(new URLSearchParams("q=%25_%27OR+1%3D1"))).toMatchObject(
      { ok: true },
    );
  });
  it("admits all prefectures and municipality-only API searches", () => {
    for (let code = 1; code <= 47; code += 1) {
      expect(
        parseSearch(
          new URLSearchParams({ prefecture: String(code).padStart(2, "0") }),
        ).ok,
      ).toBe(true);
    }
    expect(
      parseSearch(new URLSearchParams("municipality=13101")),
    ).toMatchObject({
      ok: true,
      value: { prefecture: "13", municipality: "13101", limit: 30 },
    });
  });
  it("ranks exact names before prefixes and substrings", () => {
    expect(rankName("図書館", "図書館")).toBe(0);
    expect(rankName("図書館分室", "図書館")).toBe(1);
    expect(rankName("国会図書館", "図書館")).toBe(2);
  });
  it("indexes every one- and two-codepoint substring without token collisions", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (name: string) => {
        const normalized = normalizeName(name);
        const points = Array.from(normalized);
        const tokens = nameTokens(normalized);
        for (let index = 0; index < points.length; index += 1) {
          expect(tokens).toEqual(
            expect.arrayContaining([
              ...nameTokens(points.slice(index, index + 1).join("")),
            ]),
          );
          if (index + 1 < points.length)
            expect(tokens).toEqual(
              expect.arrayContaining([
                ...nameTokens(points.slice(index, index + 2).join("")),
              ]),
            );
        }
        expect(new Set(tokens).size).toBe(tokens.length);
      }),
      { seed: 783201, numRuns: 300 },
    );
  });
  it("removes only known terminal navigation annotations", () => {
    expect(cleanAddress("愛媛県松山市六軒家町3-27（案内図）")).toBe(
      "愛媛県松山市六軒家町3-27",
    );
    expect(cleanAddress("東京都千代田区1-1（本館）")).toBe(
      "東京都千代田区1-1（本館）",
    );
    expect(cleanAddress("東京都千代田区（案内図）ビル1階")).toBe(
      "東京都千代田区（案内図）ビル1階",
    );
  });
});
