import { describe, expect, it } from "vitest";
import { parseBuildArguments } from "../../tools/build.ts";

describe("build arguments", () => {
  it("keeps every ordinary build literal", () => {
    for (const args of [[], ["development"], ["production"]])
      expect(parseBuildArguments(args).localForgivingSearch).toBe(false);
  });

  it("admits forgiving search only through the explicit local development flag", () => {
    expect(
      parseBuildArguments(["development", "--local-forgiving-search"]),
    ).toEqual({
      mode: "development",
      localForgivingSearch: true,
    });
    expect(() =>
      parseBuildArguments(["production", "--local-forgiving-search"]),
    ).toThrow("requires development mode");
  });

  it("rejects unknown, duplicated, and misplaced options", () => {
    for (const args of [
      ["development", "--forgiving"],
      ["development", "--local-forgiving-search", "--local-forgiving-search"],
      ["--local-forgiving-search"],
    ])
      expect(() => parseBuildArguments(args)).toThrow();
  });
});
