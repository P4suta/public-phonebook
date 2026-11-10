const sitePageSize = 30;

export type SiteRequestAdmission = "admitted" | "cross_origin";

/** Admits a site-route request unless its fetch metadata names a sender other than this origin. */
export function siteRequestAdmission(
  siteRoute: boolean,
  metadataPresent: boolean,
  sameOrigin: boolean,
): SiteRequestAdmission {
  //@ verify
  //@ ensures (\result === "admitted") === (!siteRoute || !metadataPresent || sameOrigin)
  //@ ensures (\result === "cross_origin") === (siteRoute && metadataPresent && !sameOrigin)
  if (!siteRoute || !metadataPresent) return "admitted";
  if (!sameOrigin) return "cross_origin";
  return "admitted";
}

/** Admits a search page size no larger than the page the site requests. */
export function fitsSitePage(limit: number): boolean {
  //@ verify
  //@ ensures \result === (limit >= 1 && limit <= 30)
  return limit >= 1 && limit <= sitePageSize;
}
