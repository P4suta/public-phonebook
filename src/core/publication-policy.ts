export type ImportDecision = "start" | "resume" | "conflict";

export function importDecision(
  current: string,
  requested: string,
): ImportDecision {
  //@ verify
  //@ ensures (\result === "start") === (current === "")
  //@ ensures (\result === "resume") === (current !== "" && current === requested)
  //@ ensures (\result === "conflict") === (current !== "" && current !== requested)
  if (current === "") return "start";
  if (current === requested) return "resume";
  return "conflict";
}

export function canPromote(
  candidate: string,
  checkedCandidate: string,
  snapshot: string,
  checkedSnapshot: string,
  stagingPassed: boolean,
): boolean {
  //@ verify
  //@ ensures \result === (stagingPassed && candidate === checkedCandidate && snapshot === checkedSnapshot)
  return (
    stagingPassed &&
    candidate === checkedCandidate &&
    snapshot === checkedSnapshot
  );
}
