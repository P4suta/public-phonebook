/**
 * A plain restatement of the search rule that the tests compare every path with.
 * It spells out the Unicode White_Space list and the folded characters instead of reusing the production tables.
 */

const whiteSpace = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
const dashes = new Set([
  0x2d, 0x30fc, 0xff70, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212,
  0xfe63, 0xff0d,
]);

function referenceCharacter(point: number): string {
  let folded = point;
  if (
    (folded >= 0x30a1 && folded <= 0x30f6) ||
    folded === 0x30fd ||
    folded === 0x30fe
  )
    folded -= 0x60;
  if (folded === 0x3095) return "か";
  if (folded === 0x3096) return "け";
  if (dashes.has(folded)) return "-";
  return String.fromCodePoint(folded);
}

export function referenceWords(text: string): string[] {
  let folded = "";
  for (const character of text.normalize("NFKC").toLowerCase())
    folded += referenceCharacter(character.codePointAt(0) ?? 0);
  const words: string[] = [];
  let current = "";
  for (const character of folded.normalize("NFC")) {
    if (whiteSpace.has(character.codePointAt(0) ?? 0)) {
      if (current !== "") words.push(current);
      current = "";
    } else current += character;
  }
  if (current !== "") words.push(current);
  return words;
}

export function referenceForm(text: string): string {
  return referenceWords(text).join(" ");
}

/**
 * Ranks a row by the decided rule, or returns -1 when it doesn't match.
 * `places` are the row's prefecture name, municipality name, and category label.
 */
export function referenceRank(
  name: string,
  places: readonly string[],
  words: readonly string[],
): number {
  if (words.length === 0) return -1;
  const form = referenceForm(name);
  const placeForms = places.map(referenceForm);
  const named = words.filter((word) => form.includes(word));
  const matched = words.every(
    (word) =>
      form.includes(word) || placeForms.some((place) => place.includes(word)),
  );
  if (!matched) return -1;
  if (named.length < words.length) return 3;
  if (words.length > 1) return 2;
  const [word = ""] = words;
  if (form === word) return 0;
  return form.startsWith(word) ? 1 : 2;
}
