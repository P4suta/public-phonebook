export type ReferenceRequestDecision =
  | "idle"
  | "send"
  | "unknown_operation"
  | "incomplete_path";

export function referenceRequestDecision(
  requested: boolean,
  documented: boolean,
  pathComplete: boolean,
): ReferenceRequestDecision {
  //@ verify
  //@ ensures (\result === "idle") === !requested
  //@ ensures (\result === "unknown_operation") === (requested && !documented)
  //@ ensures (\result === "incomplete_path") === (requested && documented && !pathComplete)
  //@ ensures (\result === "send") === (requested && documented && pathComplete)
  if (!requested) return "idle";
  if (!documented) return "unknown_operation";
  if (!pathComplete) return "incomplete_path";
  return "send";
}
