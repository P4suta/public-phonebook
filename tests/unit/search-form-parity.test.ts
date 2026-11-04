import { brotliCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { searchFormLines } from "../../tools/search-form-parity.ts";

describe("search form parity file", () => {
  it("writes each archive name beside its comparison form", () => {
    const archive = brotliCompressSync(
      new TextEncoder().encode(
        [
          "signature",
          "{}",
          "0\t13101\t山\u{fa11}センター\taddress",
          "1\t13\tＡＢＣ　図書館\taddress",
          "",
        ].join("\n"),
      ),
    );
    expect(searchFormLines(new Uint8Array(archive))).toBe(
      "山\u{fa11}センター\t山崎せんた-\nＡＢＣ　図書館\tabc 図書館\n",
    );
  });
});
