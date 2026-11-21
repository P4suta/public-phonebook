import * as v from "valibot";
import { expect, it } from "vitest";
import {
  type AuditPage,
  mergeCapture,
  NativeAppearanceSchema,
} from "../../tools/figma-audit.ts";

const page: AuditPage = {
  id: "14:2",
  observedNodes: 10,
  references: { instances: 2, resolved: 2 },
  placements: [
    ["1:1", "14:2", "SECTION", 0, 0, 100, 100, "NONE", null, null],
    ["1:2", "1:1", "FRAME", 0, 0, 50, 50, "VERTICAL", 0, 0],
  ],
  texts: [
    ["I5:1;9:1", 10, 20, 20, 0, 1],
    ["I5:1;9:2", 10, 20, 20, 0, 1],
    ["I5:10;9:1", 10, 20, 20, 0, 1],
    ["7:1", 30, 24, 24, 0, 1],
  ],
};

it("replaces a whole page from a page-scope capture", () => {
  const merged = mergeCapture(page, {
    page: "14:2",
    observedNodes: 3,
    references: { instances: 0, resolved: 0 },
    texts: {},
    singles: [["8:1", 10, 24, 24, 0, 1]],
    placements: [["1:1", "14:2", "SECTION", 0, 0, 90, 90, "NONE", null, null]],
    scope: "page",
  });
  expect(merged.texts).toEqual([["8:1", 10, 24, 24, 0, 1]]);
  expect(merged.placements.map((entry) => entry[0])).toEqual(["1:1"]);
});

it("replaces every text under a recaptured instance and keeps other instances", () => {
  const merged = mergeCapture(page, {
    page: "14:2",
    observedNodes: 12,
    references: { instances: 2, resolved: 2 },
    texts: { "5:1": [["I5:1;9:3", 12, 24, 24, 0, 1]] },
    singles: [["7:1", 40, 48, 48, 0, 1]],
    placements: [
      ["1:2", "1:1", "FRAME", 0, 0, 50, 80, "VERTICAL", 0, 0],
      ["1:3", "1:1", "COMPONENT", 60, 0, 20, 20, "NONE", 0, 0],
    ],
  });
  expect(merged.texts.map((entry) => entry[0])).toEqual([
    "I5:10;9:1",
    "7:1",
    "I5:1;9:3",
  ]);
  expect(merged.texts.find((entry) => entry[0] === "7:1")?.[2]).toBe(48);
  expect(merged.placements.map((entry) => [entry[0], entry[6]])).toEqual([
    ["1:1", 100],
    ["1:2", 80],
    ["1:3", 20],
  ]);
  expect(merged.observedNodes).toBe(12);
});

it("accepts an Apple toolbar material and rejects an authored paint or toolbar override", () => {
  const appearance = {
    id: "470:1490",
    components: ["5a5c7f4643552b05f680c5ee9b1c085a942881cc"],
    paints: ["variable:f53b56d4ed0520da1fb2c8586d67d82113ae1dcb"],
    toolbarOverrides: [],
  };
  expect(v.is(NativeAppearanceSchema, appearance)).toBe(true);
  for (const change of [
    { components: ["local-toolbar"] },
    { components: [] },
    { paints: ["#ff0000ff"] },
    { paints: ["#000000ff"] },
    { paints: ["variable:app-gray"] },
    { paints: ["effect:Drop shadow"] },
    { toolbarOverrides: ["I1:2;3:4"] },
  ]) {
    expect(v.is(NativeAppearanceSchema, { ...appearance, ...change })).toBe(
      false,
    );
  }
});
