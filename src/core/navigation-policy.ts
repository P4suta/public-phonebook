export function confirmsNavigation(
  newTab: boolean,
  otherSite: boolean,
  primaryButton: boolean,
  modified: boolean,
  prevented: boolean,
): boolean {
  return newTab && otherSite && primaryButton && !modified && !prevented;
}
