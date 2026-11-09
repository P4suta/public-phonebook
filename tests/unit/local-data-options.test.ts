import { describe, expect, it } from "vitest";
import { localDataOptions } from "../../tools/local-data.ts";

describe("local data options", () => {
  it("keeps ordinary preparation and supports an isolated namespace and port", () => {
    expect(localDataOptions(["bundle"])).toEqual({
      bundle: "bundle",
      state: ".local/state",
      port: 8787,
    });
    expect(
      localDataOptions([
        "bundle",
        "--state",
        ".local/measurement",
        "--port",
        "8791",
      ]),
    ).toEqual({ bundle: "bundle", state: ".local/measurement", port: 8791 });
  });

  it("rejects missing directories, unknown arguments, and invalid listening ports", () => {
    for (const args of [
      [],
      ["one", "two"],
      ["bundle", "--unknown"],
      ["bundle", "--state", ""],
      ...["0", "-1", "65536", "1.5", "1x", "Infinity", ""].map((port) => [
        "bundle",
        "--port",
        port,
      ]),
    ])
      expect(() => localDataOptions(args), JSON.stringify(args)).toThrow();
  });
});
