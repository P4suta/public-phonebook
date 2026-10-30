export type CopyCompletion = "copied" | "failed" | "superseded";

export type CopyMethod = "clipboard" | "selection" | "blocked";

export function copyMethod(
  trusted: boolean,
  active: boolean,
  supported: boolean,
): CopyMethod {
  //@ verify
  //@ ensures (\result === "blocked") === !trusted
  //@ ensures (\result === "clipboard") === (trusted && active && supported)
  //@ ensures (\result === "selection") === (trusted && (!active || !supported))
  if (!trusted) return "blocked";
  if (active && supported) return "clipboard";
  return "selection";
}

export function copyCompletion(
  current: boolean,
  succeeded: boolean,
): CopyCompletion {
  //@ verify
  //@ ensures (\result === "superseded") === !current
  //@ ensures (\result === "copied") === (current && succeeded)
  //@ ensures (\result === "failed") === (current && !succeeded)
  if (!current) return "superseded";
  return succeeded ? "copied" : "failed";
}
