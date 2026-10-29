import assert from "node:assert/strict";
import { test } from "node:test";
import { feedPayload } from "../../web/app.ts";

const valid = {
  snapshot: "a".repeat(64),
  total: 101,
  page: 2,
  pages: 3,
  shown: 100,
  html: "<article></article>",
};

test("feed input accepts valid empty, complete and partial pages", () => {
  for (const value of [
    valid,
    { ...valid, total: 0, page: 1, pages: 1, shown: 0, html: "" },
    { ...valid, page: 3, shown: 101 },
  ]) {
    assert.deepEqual(feedPayload(value).toJSON(), value);
  }
});

test("feed input rejects malformed shapes and unsafe numeric domains", () => {
  for (const value of [null, undefined, [], "", 3, true, {}]) {
    assert.throws(() => feedPayload(value), /Invalid feed response/);
  }
  for (const field of ["total", "page", "pages", "shown"] as const) {
    for (const value of [-1, 0.5, Number.NaN, Infinity, 2 ** 53, "2", null]) {
      assert.throws(() => feedPayload({ ...valid, [field]: value }));
    }
  }
  for (const value of [
    { ...valid, snapshot: "a".repeat(63) },
    { ...valid, snapshot: "g".repeat(64) },
    { ...valid, html: {} },
    { ...valid, page: 0 },
    { ...valid, page: 4 },
    { ...valid, pages: 4 },
    { ...valid, shown: 102 },
  ]) {
    assert.throws(() => feedPayload(value), /Invalid feed response/);
  }
});
