import { normalizePhone, telephoneSpelling } from "./phone.ts";
import type { InputScript } from "./search-trigger-policy.ts";

const japaneseText = /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}]/u;
const digit = /[0-9０-９]/u;
const pauseIntervalMultiple = 3;
const medianHalves = 2;

export function inputScript(text: string): InputScript {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  if (japaneseText.test(trimmed)) return "japanese";
  if (telephoneSpelling.test(trimmed) && digit.test(trimmed))
    return "telephone";
  return "latin";
}

export function completeTelephone(text: string): boolean {
  return normalizePhone(text).ok;
}

export function keystrokeIntervals(
  times: readonly number[],
): readonly number[] {
  return times.slice(1).map((time, index) => time - (times[index] ?? time));
}

export function pauseDelay(intervals: readonly number[]): number {
  const sorted = intervals.toSorted((left, right) => left - right);
  const upper = sorted[Math.floor(sorted.length / medianHalves)] ?? 0;
  const lower = sorted[Math.ceil(sorted.length / medianHalves) - 1] ?? upper;
  return (pauseIntervalMultiple * (lower + upper)) / medianHalves;
}
