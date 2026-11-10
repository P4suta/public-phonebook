import {
  admitsContentCoding,
  matchesEntityTag,
} from "@public-phonebook/directory/content-negotiation";
import { describe, expect, it } from "vitest";

describe("content coding negotiation", () => {
  it("admits Brotli only when Accept-Encoding names it or a wildcard with a nonzero weight", () => {
    for (const [header, admitted] of [
      [null, false],
      [undefined, false],
      ["", false],
      ["identity", false],
      ["gzip, deflate", false],
      ["br", true],
      ["BR", true],
      ["gzip, deflate, br, zstd", true],
      ["br;q=0.001", true],
      ["br; q=1.000", true],
      ["br;q=0", false],
      ["br;q=0.000", false],
      ["*", true],
      ["gzip;q=1, *;q=0.1", true],
      ["*;q=0", false],
      ["*, br;q=0", false],
      ["br;q=0, *", false],
      ["br;q=2", false],
      ["br;q=abc", false],
      ["br;level=1", false],
      ["brotli", false],
      [" , ,br", true],
    ] as const)
      expect(admitsContentCoding(header, "br"), String(header)).toBe(admitted);
  });
});

describe("entity tag revalidation", () => {
  const tag = `"${"a".repeat(64)}"`;

  it("compares If-None-Match weakly and accepts lists and the wildcard", () => {
    for (const [header, matched] of [
      [null, false],
      [undefined, false],
      ["", false],
      [tag, true],
      [`W/${tag}`, true],
      [`"other", ${tag}`, true],
      [`"x,y", W/${tag}`, true],
      ["*", true],
      [" * ", true],
      [`"${"b".repeat(64)}"`, false],
      ["a".repeat(64), false],
      [`${tag.slice(0, -1)}`, false],
    ] as const)
      expect(matchesEntityTag(header, tag), String(header)).toBe(matched);
    expect(matchesEntityTag(tag, `W/${tag}`)).toBe(true);
  });
});
