const stagingOrigin = "https://staging.dial.page";

export function stagingAdmission(
  staging: boolean,
  configured: boolean,
  canonicalOrigin: boolean,
  verified: boolean,
  identityAllowed: boolean,
): boolean {
  //@ verify
  //@ ensures \result === (!staging || (configured && canonicalOrigin && verified && identityAllowed))
  return (
    !staging || (configured && canonicalOrigin && verified && identityAllowed)
  );
}

export function browserCredentials(origin: string): "same-origin" | "omit" {
  return origin === stagingOrigin ? "same-origin" : "omit";
}
