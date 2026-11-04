import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inflateRawSync } from "node:zlib";

/** The pinned Unihan release that the kanji variant table comes from, fetched into `target/` and never committed. */
export const unihan = {
  version: "18.0.0",
  url: "https://www.unicode.org/Public/18.0.0/ucd/Unihan.zip",
  sha256: "4c93ea9c1f636451729a840978f1667a53886af37ba854fdcce109721c63d43e",
  archive: "target/unihan/Unihan-18.0.0.zip",
} as const;

export const generatedTypeScript = "src/core/kanji-variants.ts";
export const generatedSwift = "ios/Sources/PhonebookCore/KanjiVariants.swift";

const otherMappings = "Unihan_OtherMappings.txt";
const variantsFile = "Unihan_Variants.txt";
const endOfDirectory = 0x06054b50;
const directoryEntry = 0x02014b50;
const localHeader = 0x04034b50;
const endRecordLength = 22;
const directoryOffsetField = 16;
const entryCountField = 10;
const entryHeaderLength = 46;
const localHeaderLength = 30;
const methodField = 10;
const compressedSizeField = 20;
const nameLengthField = 28;
const extraLengthField = 30;
const commentLengthField = 32;
const localOffsetField = 42;
const localNameLengthField = 26;
const localExtraLengthField = 28;
const deflated = 8;
const stored = 0;
const hexadecimalRadix = 16;
const listYear = /^\d{4}$/u;
const codePoint = /^U\+([0-9A-F]{4,6})$/u;
const jinmeiyoPointer = /^\d{4}:U\+([0-9A-F]{4,6})$/u;
const zVariantSource = /:[A-Z]*Z/u;

/** Reads the named files from a ZIP archive's central directory, which is all that Unihan's archive needs. */
export function zipEntries(
  bytes: Uint8Array,
  names: readonly string[],
): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.byteLength - endRecordLength;
  while (end >= 0 && view.getUint32(end, true) !== endOfDirectory) end -= 1;
  if (end < 0) throw new Error("The Unihan archive has no central directory");
  const entries = view.getUint16(end + entryCountField, true);
  let offset = view.getUint32(end + directoryOffsetField, true);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const found = new Map<string, string>();
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== directoryEntry)
      throw new Error("The Unihan archive's directory is malformed");
    const method = view.getUint16(offset + methodField, true);
    const size = view.getUint32(offset + compressedSizeField, true);
    const nameLength = view.getUint16(offset + nameLengthField, true);
    const name = decoder.decode(
      bytes.subarray(
        offset + entryHeaderLength,
        offset + entryHeaderLength + nameLength,
      ),
    );
    const local = view.getUint32(offset + localOffsetField, true);
    offset +=
      entryHeaderLength +
      nameLength +
      view.getUint16(offset + extraLengthField, true) +
      view.getUint16(offset + commentLengthField, true);
    if (!names.includes(name)) continue;
    if (view.getUint32(local, true) !== localHeader)
      throw new Error("The Unihan archive's file header is malformed");
    const start =
      local +
      localHeaderLength +
      view.getUint16(local + localNameLengthField, true) +
      view.getUint16(local + localExtraLengthField, true);
    const data = bytes.subarray(start, start + size);
    if (method !== deflated && method !== stored)
      throw new Error("The Unihan archive uses an unknown compression");
    found.set(
      name,
      decoder.decode(method === deflated ? inflateRawSync(data) : data),
    );
  }
  for (const name of names)
    if (!found.has(name)) throw new Error(`The Unihan archive lacks ${name}`);
  return found;
}

interface Field {
  readonly point: number;
  readonly field: string;
  readonly value: string;
}

function fields(text: string, wanted: readonly string[]): Field[] {
  const result: Field[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const [character = "", field = "", value = ""] = line.split("\t");
    if (!wanted.includes(field)) continue;
    const point = codePoint.exec(character)?.[1];
    if (point === undefined) throw new Error(`Unreadable Unihan line: ${line}`);
    result.push({
      point: Number.parseInt(point, hexadecimalRadix),
      field,
      value,
    });
  }
  return result;
}

function pointOf(text: string): number {
  const point = codePoint.exec(text)?.[1];
  if (point === undefined) throw new Error(`Unreadable code point: ${text}`);
  return Number.parseInt(point, hexadecimalRadix);
}

/** The code point that compatibility composition leaves, or null when it becomes more than one character. */
function composed(point: number): number | null {
  const text = String.fromCodePoint(point).normalize("NFKC");
  const points = Array.from(text, (character) => character.codePointAt(0) ?? 0);
  return points.length === 1 ? (points[0] ?? null) : null;
}

/**
 * Builds the map from each kanji variant to its group's representative.
 * Edges join in a fixed order: the Japanese lists' pointers from a variant to its standard form, then z-variants, then semantic variants that a source marks as z-variants, then a nonstandard character's only standard semantic variant.
 * No edge joins two groups that each hold a 常用漢字 or 人名用漢字 standard form, so two standard characters never compare equal.
 * The representative is the group's standard form, or else its lowest code point.
 */
export function kanjiVariantTable(
  mappings: string,
  variants: string,
): Map<number, number> {
  const lists = fields(mappings, ["kJoyoKanji", "kJinmeiyoKanji"]);
  const standard = new Set(
    lists.filter((item) => listYear.test(item.value)).map((item) => item.point),
  );
  const official: [number, number][] = [];
  for (const item of lists) {
    if (item.field === "kJoyoKanji" && codePoint.test(item.value))
      official.push([item.point, pointOf(item.value)]);
    const pointer = jinmeiyoPointer.exec(item.value)?.[1];
    if (item.field === "kJinmeiyoKanji" && pointer !== undefined)
      official.push([item.point, Number.parseInt(pointer, hexadecimalRadix)]);
  }
  const zEdges: [number, number][] = [];
  const zSemantic: [number, number][] = [];
  const semantic: [number, number][] = [];
  for (const item of fields(variants, ["kZVariant", "kSemanticVariant"])) {
    const targets = item.value.split(" ").map((entry) => {
      const [target = "", sources = ""] = entry.split("<");
      return { point: pointOf(target), z: zVariantSource.test(sources) };
    });
    if (item.field === "kZVariant")
      for (const target of targets) zEdges.push([item.point, target.point]);
    else {
      for (const target of targets.filter((entry) => entry.z))
        zSemantic.push([item.point, target.point]);
      const standards = targets.filter((entry) => standard.has(entry.point));
      const [only] = standards;
      if (!standard.has(item.point) && standards.length === 1 && only)
        semantic.push([item.point, only.point]);
    }
  }
  const parent = new Map<number, number>();
  const find = (point: number): number => {
    let root = point;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    parent.set(point, root);
    return root;
  };
  const standardOf = new Map<number, number>();
  for (const point of standard) standardOf.set(point, point);
  const ordered = (edges: [number, number][]): [number, number][] =>
    edges.toSorted((left, right) => left[0] - right[0] || left[1] - right[1]);
  for (const [from, to] of [
    ...ordered(official),
    ...ordered(zEdges),
    ...ordered(zSemantic),
    ...ordered(semantic),
  ]) {
    const left = composed(from);
    const right = composed(to);
    if (left === null || right === null || left === right) continue;
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) continue;
    const leftStandard = standardOf.get(leftRoot);
    const rightStandard = standardOf.get(rightRoot);
    if (leftStandard !== undefined && rightStandard !== undefined) continue;
    const root = Math.min(leftRoot, rightRoot);
    const other = root === leftRoot ? rightRoot : leftRoot;
    parent.set(other, root);
    const groupStandard = leftStandard ?? rightStandard;
    if (groupStandard !== undefined) standardOf.set(root, groupStandard);
  }
  const table = new Map<number, number>();
  for (const point of parent.keys()) {
    const root = find(point);
    const representative = standardOf.get(root) ?? root;
    if (point !== representative) table.set(point, representative);
  }
  return new Map([...table].toSorted((left, right) => left[0] - right[0]));
}

/** Spells each pair as hexadecimal code points, so the source shows no glyph that a reader could confuse with another. */
function pairs(table: ReadonlyMap<number, number>): string {
  return Array.from(
    table,
    ([from, to]) =>
      `${from.toString(hexadecimalRadix)}:${to.toString(hexadecimalRadix)}`,
  ).join(" ");
}

function provenance(table: ReadonlyMap<number, number>): string[] {
  return [
    `Generated by tools/kanji-variants.ts from Unihan ${unihan.version} (${unihan.url}, SHA-256 ${unihan.sha256}).`,
    "It reads kJoyoKanji and kJinmeiyoKanji from Unihan_OtherMappings.txt and kZVariant and kSemanticVariant from Unihan_Variants.txt.",
    `Each of the ${table.size} pairs maps a kanji variant to its group's representative; regenerate the file instead of editing it.`,
  ];
}

export function typeScriptSource(table: ReadonlyMap<number, number>): string {
  return [
    ...provenance(table).map((line) => `// ${line}`),
    "",
    "/** Each variant and its representative as hexadecimal code points joined by a colon, one pair per space. */",
    "export const kanjiVariantPairs =",
    `  ${JSON.stringify(pairs(table))};`,
    "",
  ].join("\n");
}

export function swiftSource(table: ReadonlyMap<number, number>): string {
  return [
    ...provenance(table).map((line) => `// ${line}`),
    "",
    "enum KanjiVariants {",
    "  /// Each variant and its representative as hexadecimal code points joined by a colon, one pair per space.",
    "  static let pairs =",
    `    ${JSON.stringify(pairs(table))}`,
    "}",
    "",
  ].join("\n");
}

/** Reads the pinned archive, downloading it into `target/` first when it is missing, and refuses any other bytes. */
export async function pinnedArchive(): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(unihan.archive));
  } catch {
    const response = await fetch(unihan.url);
    if (!response.ok)
      throw new Error(`Unihan download failed with ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(dirname(unihan.archive), { recursive: true });
    await writeFile(unihan.archive, bytes);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== unihan.sha256)
    throw new Error(
      `The Unihan archive's digest is ${digest}, not the pinned one`,
    );
  return bytes;
}

export async function generatedSources(): Promise<{
  readonly typeScript: string;
  readonly swift: string;
}> {
  const files = zipEntries(await pinnedArchive(), [
    otherMappings,
    variantsFile,
  ]);
  const table = kanjiVariantTable(
    files.get(otherMappings) ?? "",
    files.get(variantsFile) ?? "",
  );
  return { typeScript: typeScriptSource(table), swift: swiftSource(table) };
}

/** Requires the committed tables to equal a fresh generation from the pinned archive. */
export async function checkKanjiVariants(): Promise<void> {
  const fresh = await generatedSources();
  for (const [path, text] of [
    [generatedTypeScript, fresh.typeScript],
    [generatedSwift, fresh.swift],
  ] as const)
    if ((await readFile(path, "utf8")) !== text)
      throw new Error(
        `${path} differs from its generation; run node tools/kanji-variants.ts write`,
      );
  console.info(
    JSON.stringify({ operation: "kanji-variants", unihan: unihan.version }),
  );
}

const committedPairs =
  /^export const kanjiVariantPairs =\n {2}"([0-9a-f: ]*)";$/mu;

/**
 * Requires, without the network, that both committed tables carry the same pairs under the pinned Unihan provenance.
 * The fast gate runs this, and the build gate regenerates the tables from the archive with `checkKanjiVariants`.
 */
export async function checkKanjiVariantProvenance(): Promise<void> {
  const typeScript = await readFile(generatedTypeScript, "utf8");
  const pairs = committedPairs.exec(typeScript)?.[1];
  if (pairs === undefined)
    throw new Error(`${generatedTypeScript} has no variant pairs`);
  const table = new Map(
    pairs.split(" ").map((pair): [number, number] => {
      const [from = "", to = ""] = pair.split(":");
      return [
        Number.parseInt(from, hexadecimalRadix),
        Number.parseInt(to, hexadecimalRadix),
      ];
    }),
  );
  if (typeScript !== typeScriptSource(table))
    throw new Error(`${generatedTypeScript} lacks the pinned provenance`);
  if ((await readFile(generatedSwift, "utf8")) !== swiftSource(table))
    throw new Error(`${generatedSwift} differs from ${generatedTypeScript}`);
  console.info(
    JSON.stringify({
      operation: "kanji-variant-provenance",
      unihan: unihan.version,
      pairs: table.size,
    }),
  );
}

if (import.meta.main) {
  if (process.argv.includes("write")) {
    const fresh = await generatedSources();
    await writeFile(generatedTypeScript, fresh.typeScript);
    await writeFile(generatedSwift, fresh.swift);
  } else await checkKanjiVariants();
}
