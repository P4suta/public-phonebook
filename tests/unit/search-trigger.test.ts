import { describe, expect, it } from "vitest";
import {
  completeTelephone,
  inputScript,
  keystrokeIntervals,
  pauseDelay,
} from "../../src/core/search-input.ts";
import {
  type InputScript,
  type SearchEvent,
  type SearchTrigger,
  searchTrigger,
} from "../../src/core/search-trigger-policy.ts";

const scripts: readonly InputScript[] = [
  "empty",
  "japanese",
  "telephone",
  "latin",
];
const events: readonly SearchEvent[] = ["change", "space", "blur", "submit"];

function expectedTrigger(
  script: InputScript,
  event: SearchEvent,
  composing: boolean,
  complete: boolean,
  intervals: number,
): SearchTrigger {
  if (event === "submit") return "search";
  if (composing) return "wait";
  switch (script) {
    case "empty":
    case "japanese":
      return "settle";
    case "telephone":
      return complete ? "settle" : "wait";
    case "latin":
      if (event !== "change") return "search";
      return intervals < 2 ? "wait" : "pause";
  }
}

describe("search trigger", () => {
  it("classifies input by the scripts it contains", () => {
    for (const text of ["", "  ", "　"])
      expect(inputScript(text), text).toBe("empty");
    for (const text of [
      "東京",
      "とうきょう",
      "トウキョウ",
      "ﾄｳｷｮｳ",
      "東京tokyo",
      "tokyo東",
      "ー",
      "03-東",
    ])
      expect(inputScript(text), text).toBe("japanese");
    for (const text of [
      "0",
      "03",
      "03-3581-2331",
      "０３－３５８１－２３３１",
      "(03) 3581 2331",
      "（03）3581-2331",
      "+81 3 3581 2331",
      " 0335812331 ",
    ])
      expect(inputScript(text), text).toBe("telephone");
    for (const text of [
      "tokyo",
      "Tokyo University",
      "café",
      "abc123",
      "123abc",
      "03-3581-2331 x",
      "-",
      "()",
      "#1",
    ])
      expect(inputScript(text), text).toBe("latin");
  });

  it("accepts only complete Japanese telephone numbers", () => {
    for (const text of [
      "03-3581-2331",
      "0335812331",
      "088-844-0111",
      "090-1234-5678",
      "09012345678",
      "+81 3 3581 2331",
      "０３－３５８１－２３３１",
    ])
      expect(completeTelephone(text), text).toBe(true);
    for (const text of [
      "0",
      "03-3581-233",
      "033581233",
      "090-1234-56789",
      "13-3581-2331",
      "+81",
      "03-3581-2331-12",
    ])
      expect(completeTelephone(text), text).toBe(false);
  });

  it("decides every script, event, composition, completeness, and pace", () => {
    for (const script of scripts)
      for (const event of events)
        for (const composing of [false, true])
          for (const complete of [false, true])
            for (let intervals = 0; intervals <= 4; intervals += 1)
              expect(
                searchTrigger(script, event, composing, complete, intervals),
                JSON.stringify({
                  script,
                  event,
                  composing,
                  complete,
                  intervals,
                }),
              ).toBe(
                expectedTrigger(script, event, composing, complete, intervals),
              );
  });

  it("waits three median keystroke intervals once two intervals exist", () => {
    expect(keystrokeIntervals([])).toEqual([]);
    expect(keystrokeIntervals([10])).toEqual([]);
    expect(keystrokeIntervals([0, 100, 250, 300])).toEqual([100, 150, 50]);
    expect(pauseDelay([100, 150, 50])).toBe(300);
    expect(pauseDelay([100, 200])).toBe(450);
    expect(pauseDelay([400, 100, 200, 120])).toBe(480);
    expect(searchTrigger("latin", "change", false, false, 1)).toBe("wait");
    expect(searchTrigger("latin", "change", false, false, 2)).toBe("pause");
  });
});
