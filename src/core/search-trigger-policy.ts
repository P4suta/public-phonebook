const minimumPauseIntervals = 2;

export type InputScript = "empty" | "japanese" | "telephone" | "latin";
export type SearchEvent = "change" | "boundary" | "blur" | "submit";
export type SearchTrigger = "search" | "settle" | "pause" | "wait";

export function searchTrigger(
  script: InputScript,
  event: SearchEvent,
  composing: boolean,
  completeTelephone: boolean,
  intervals: number,
): SearchTrigger {
  //@ verify
  //@ ensures event === "submit" ==> \result === "search"
  //@ ensures event !== "submit" && composing ==> \result === "wait"
  //@ ensures event !== "submit" && !composing && (script === "empty" || script === "japanese") ==> \result === "settle"
  //@ ensures event !== "submit" && !composing && script === "telephone" ==> \result === (completeTelephone ? "settle" : "wait")
  //@ ensures event !== "submit" && event !== "change" && !composing && script === "latin" ==> \result === "search"
  //@ ensures event === "change" && !composing && script === "latin" ==> \result === (intervals >= 2 ? "pause" : "wait")
  if (event === "submit") return "search";
  if (composing) return "wait";
  if (script === "empty" || script === "japanese") return "settle";
  if (script === "telephone") return completeTelephone ? "settle" : "wait";
  if (event !== "change") return "search";
  return intervals >= minimumPauseIntervals ? "pause" : "wait";
}
