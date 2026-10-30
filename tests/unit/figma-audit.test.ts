import { expect, it } from "vitest";
import { type AuditPage, mergeCapture } from "../../tools/figma-audit.ts";

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
