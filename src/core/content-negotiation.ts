const wildcard = "*";
const qualityParameter = /^q=(?<weight>0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/iu;
const entityTags = /(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/gu;
const weakPrefix = "W/";

function codingWeights(header: string): ReadonlyMap<string, number> {
  const weights = new Map<string, number>();
  for (const element of header.split(",")) {
    const [name = "", ...parameters] = element
      .split(";")
      .map((part) => part.trim());
    if (name === "") continue;
    let weight = 1;
    let valid = true;
    for (const parameter of parameters) {
      const quality = qualityParameter.exec(parameter.replaceAll(" ", ""));
      if (quality?.groups?.weight === undefined) valid = false;
      else weight = Number(quality.groups.weight);
    }
    if (valid) weights.set(name.toLowerCase(), weight);
  }
  return weights;
}

/** Admits a coding that Accept-Encoding names, or covers with `*`, at a nonzero weight; an absent header admits nothing because no identity alternative exists. */
export function admitsContentCoding(
  header: string | null | undefined,
  coding: string,
): boolean {
  if (header === null || header === undefined) return false;
  const weights = codingWeights(header);
  const weight = weights.get(coding.toLowerCase()) ?? weights.get(wildcard);
  return weight !== undefined && weight > 0;
}

function opaqueTag(tag: string): string {
  return tag.startsWith(weakPrefix) ? tag.slice(weakPrefix.length) : tag;
}

/** Compares If-None-Match with the weak comparison that RFC 9110 requires for it. */
export function matchesEntityTag(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (header === null || header === undefined) return false;
  if (header.trim() === wildcard) return true;
  const current = opaqueTag(etag);
  return [...header.matchAll(entityTags)].some(
    (match) => opaqueTag(match[0]) === current,
  );
}
