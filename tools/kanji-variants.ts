import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inflateRawSync } from "node:zlib";
import { readPdfTables } from "./collection/read-pdf.ts";
import type { SourceTable } from "./collection/read-tables.ts";

interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly archive: string;
}

/** The pinned Unihan release that the kanji variant table comes from, fetched into `target/` and never committed. */
export const unihan = {
  name: "Unihan",
  version: "18.0.0",
  url: "https://www.unicode.org/Public/18.0.0/ucd/Unihan.zip",
  sha256: "4c93ea9c1f636451729a840978f1667a53886af37ba854fdcce109721c63d43e",
  archive: "target/unihan/Unihan-18.0.0.zip",
} as const;

/**
 * The pinned Joyo Kanji Table of the Cabinet notice of 2010-11-30, as the Agency for Cultural Affairs publishes it, fetched into `target/` and never committed.
 * The notice states its 2136 characters, and the extraction pins how many of them carry a traditional form in round brackets.
 */
export const joyoKanjiTable = {
  name: "the Joyo Kanji Table notice of 2010-11-30",
  url: "https://www.bunka.go.jp/kokugo_nihongo/sisaku/joho/joho/kijun/naikaku/pdf/joyokanjihyo_20101130.pdf",
  sha256: "d9f28aeb4ce8250dbde07de20ac66cca71805ba09d94e4942c752dffa84d8d42",
  archive: "target/joyo-kanji-table/joyokanjihyo_20101130.pdf",
  characters: 2136,
  bracketedCharacters: 362,
  traditionalForms: 364,
} as const;

export const generatedTypeScript = "src/core/kanji-variants.ts";
export const generatedSwift = "ios/Sources/PhonebookCore/KanjiVariants.swift";
export const generatedTraditionalForms = "tools/joyo-traditional-forms.ts";

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
const hanCharacter = /^\p{Script=Han}$/u;
const roundBrackets = /^（([^）]*)）/u;
const squareBracket = "［";
const tableTitle = "本表";
const appendixTitle = "付表";
const columnHeadings = "漢字音訓例備考";
/** Each page heads its first row with the readings it spans, such as イ or カイ－ガイ. */
const runningHead = /^[\p{Script=Hiragana}\p{Script=Katakana}ー－]+$/u;
/**
 * The pinned notice sets each character left of this x coordinate and its bracketed form before `readingColumn`.
 * These coordinates hold only for the bytes that `joyoKanjiTable.sha256` pins.
 */
const characterColumnEnd = 110;
const readingColumn = 165;
const exampleColumn = 240;
/** The notice draws the traditional form beside U+4E80 as outlines, so its round brackets hold no text and the tool supplies U+9F9C. */
const drawnForms: ReadonlyMap<number, number> = new Map([[0x4e80, 0x9f9c]]);
/** The notice stacks the three traditional forms of U+5F01 in the bracket column inside one pair of drawn brackets. */
const stackedForms: ReadonlySet<number> = new Set([0x5f01]);

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

function hanPoint(text: string): number | null {
  if (!hanCharacter.test(text)) return null;
  return text.codePointAt(0) ?? null;
}

function hex(point: number): string {
  return `U+${point.toString(hexadecimalRadix).toUpperCase()}`;
}

interface PlacedText {
  readonly x: number;
  readonly text: string;
}

function placedTexts(row: readonly string[]): PlacedText[] {
  return row.map((cell) => {
    const colon = cell.indexOf(":");
    const x = Number(cell.slice(0, colon));
    if (colon < 0 || !Number.isFinite(x))
      throw new Error(`Unreadable notice text: ${cell}`);
    return { x, text: cell.slice(colon + 1) };
  });
}

/** Each standard character of the notice's main table, and each traditional form beside one as the form and its standard character. */
export interface TraditionalForms {
  readonly characters: readonly number[];
  readonly pairs: readonly (readonly [number, number])[];
}

/**
 * Reads the traditional forms that the notice prints in round brackets beside its standard characters.
 * It reads the main table between its title and the appendix title, and it refuses any text in the bracket column that isn't a bracketed form.
 * The forms in square brackets are the permitted printed forms of five characters, which the notice gives the same code points, so they stay out.
 */
export function traditionalFormsOf(
  tables: readonly SourceTable[],
): TraditionalForms {
  const characters: number[] = [];
  const pairs: [number, number][] = [];
  let state: "before" | "table" | "after" = "before";
  let current: number | null = null;
  for (const table of tables)
    for (const row of table.rows) {
      if (state === "after") break;
      const texts = placedTexts(row);
      const joined = texts
        .map((item) => item.text.replaceAll(" ", ""))
        .join("");
      if (joined === tableTitle && state === "before") state = "table";
      else if (joined === appendixTitle && state === "table") state = "after";
      if (state !== "table" || joined === tableTitle) continue;
      if (joined === columnHeadings || runningHead.test(joined)) continue;
      const [first, ...rest] = texts;
      const starts = first !== undefined && first.x < characterColumnEnd;
      if (starts) {
        const character = hanPoint(first.text);
        if (character === null)
          throw new Error(
            `Unexpected text in the character column: ${row.join(" ")}`,
          );
        current = character;
        characters.push(character);
      }
      const column = (starts ? rest : texts).filter(
        (item) => item.x < exampleColumn,
      );
      const following = column.map((item) => item.text).join("");
      const bracketed = roundBrackets.exec(following)?.[1];
      if (current === null) {
        if (column.some((item) => item.x < readingColumn))
          throw new Error(`Text before the first character: ${row.join(" ")}`);
        continue;
      }
      if (following.startsWith(squareBracket)) continue;
      if (bracketed === "") {
        const drawn = drawnForms.get(current);
        if (drawn === undefined)
          throw new Error(`Empty round brackets beside ${hex(current)}`);
        pairs.push([drawn, current]);
        continue;
      }
      if (bracketed !== undefined) {
        const form = hanPoint(bracketed);
        if (form === null)
          throw new Error(
            `Unreadable form beside ${hex(current)}: ${bracketed}`,
          );
        pairs.push([form, current]);
        continue;
      }
      for (const item of column.filter((text) => text.x < readingColumn)) {
        const form = hanPoint(item.text);
        if (form === null || !stackedForms.has(current))
          throw new Error(
            `Unexpected text in the bracket column: ${row.join(" ")}`,
          );
        pairs.push([form, current]);
      }
    }
  if (state !== "after")
    throw new Error("The notice lacks its main table or its appendix title");
  return { characters, pairs };
}

/** Reads the notice's traditional forms and requires the pinned numbers of characters and forms. */
export function readTraditionalForms(
  tables: readonly SourceTable[],
): TraditionalForms {
  const { characters, pairs } = traditionalFormsOf(tables);
  const bracketed = new Set(pairs.map(([, character]) => character));
  const forms = new Set(pairs.map(([form]) => form));
  if (
    characters.length !== joyoKanjiTable.characters ||
    new Set(characters).size !== characters.length ||
    bracketed.size !== joyoKanjiTable.bracketedCharacters ||
    pairs.length !== joyoKanjiTable.traditionalForms ||
    forms.size !== pairs.length
  )
    throw new Error(
      `The notice gives ${characters.length} characters and ${pairs.length} traditional forms beside ${bracketed.size} of them`,
    );
  return { characters, pairs };
}

function requireSameSet(
  left: readonly string[],
  right: readonly string[],
  what: string,
): void {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const differences = [
    ...left.filter((item) => !rightSet.has(item)),
    ...right.filter((item) => !leftSet.has(item)),
  ];
  if (differences.length > 0 || leftSet.size !== left.length)
    throw new Error(`${what} differ: ${differences.join(" ")}`);
}

/**
 * Requires Unihan to corroborate the reading of the notice.
 * The notice's characters must be exactly the ones that kJoyoKanji lists with a year.
 * Its traditional forms must be exactly the kJapaneseNewVariant pairs and the kJapaneseOldVariant pairs read backward, so a form that the layout hides fails the generation.
 */
export function requireUnihanAgreement(
  notice: TraditionalForms,
  mappings: string,
  variants: string,
): void {
  requireSameSet(
    notice.characters.map(hex),
    fields(mappings, ["kJoyoKanji"])
      .filter((item) => listYear.test(item.value))
      .map((item) => hex(item.point)),
    "The notice's characters and kJoyoKanji",
  );
  const forms = notice.pairs.map(([form, character]) =>
    [form, character].map(hex).join(">"),
  );
  const japanese = fields(variants, [
    "kJapaneseNewVariant",
    "kJapaneseOldVariant",
  ]);
  for (const field of ["kJapaneseNewVariant", "kJapaneseOldVariant"])
    requireSameSet(
      forms,
      japanese
        .filter((item) => item.field === field)
        .flatMap((item) =>
          item.value.split(" ").map((target) => {
            const other = hex(pointOf(target));
            return field === "kJapaneseNewVariant"
              ? `${hex(item.point)}>${other}`
              : `${other}>${hex(item.point)}`;
          }),
        ),
      `The notice's traditional forms and ${field}`,
    );
}

/**
 * Builds the map from each kanji variant to its group's representative.
 * Edges join in a fixed order: the traditional forms that the Joyo Kanji Table brackets, then the Japanese lists' pointers from a variant to its standard form, then z-variants, then semantic variants that a source marks as z-variants, then a nonstandard character's only standard semantic variant.
 * No edge joins two groups that each hold a 常用漢字 or 人名用漢字 standard form, so two standard characters never compare equal.
 * The representative is the group's standard form, or else its lowest code point.
 * Every traditional form must reach its standard character, so an edge that a standard form refuses stops the generation.
 */
export function kanjiVariantTable(
  mappings: string,
  variants: string,
  traditional: readonly (readonly [number, number])[],
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
    ...ordered(traditional.map(([form, character]) => [form, character])),
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
  requireFolds(table, traditional);
  return new Map([...table].toSorted((left, right) => left[0] - right[0]));
}

function requireFolds(
  table: ReadonlyMap<number, number>,
  traditional: readonly (readonly [number, number])[],
): void {
  for (const [form, character] of traditional) {
    const point = composed(form) ?? form;
    if ((table.get(point) ?? point) !== character)
      throw new Error(`${hex(form)} doesn't fold into ${hex(character)}`);
  }
}

/** Spells each pair as hexadecimal code points, so the source shows no glyph that a reader could confuse with another. */
function pairs(table: Iterable<readonly [number, number]>): string {
  return Array.from(
    table,
    ([from, to]) =>
      `${from.toString(hexadecimalRadix)}:${to.toString(hexadecimalRadix)}`,
  ).join(" ");
}

function provenance(table: ReadonlyMap<number, number>): string[] {
  return [
    `Generated by tools/kanji-variants.ts from ${joyoKanjiTable.name} (${joyoKanjiTable.url}, SHA-256 ${joyoKanjiTable.sha256}) and Unihan ${unihan.version} (${unihan.url}, SHA-256 ${unihan.sha256}).`,
    `It first joins the traditional forms that the notice prints in round brackets, which ${generatedTraditionalForms} lists.`,
    "It then reads kJoyoKanji and kJinmeiyoKanji from Unihan_OtherMappings.txt and kZVariant and kSemanticVariant from Unihan_Variants.txt.",
    `Each of the ${table.size} pairs maps a kanji variant to its group's representative; regenerate the file instead of editing it.`,
  ];
}

export function traditionalFormsSource(
  traditional: readonly (readonly [number, number])[],
): string {
  const characters = new Set(traditional.map(([, character]) => character));
  return [
    `// Generated by tools/kanji-variants.ts from ${joyoKanjiTable.name} (${joyoKanjiTable.url}, SHA-256 ${joyoKanjiTable.sha256}).`,
    `// Each of the ${traditional.length} pairs maps a traditional form that the notice prints in round brackets to the standard character beside it, ${characters.size} characters in all; regenerate the file instead of editing it.`,
    "",
    "/** Each traditional form and its standard character as hexadecimal code points joined by a colon, one pair per space, in the notice's order. */",
    "export const joyoTraditionalForms =",
    `  ${JSON.stringify(pairs(traditional))};`,
    "",
  ].join("\n");
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

/** Reads a pinned file, downloading it into `target/` first when it is missing, and refuses any other bytes. */
export async function pinnedFile(source: PinnedFile): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(source.archive));
  } catch {
    const response = await fetch(source.url);
    if (!response.ok)
      throw new Error(
        `The download of ${source.name} failed with ${response.status}`,
      );
    bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(dirname(source.archive), { recursive: true });
    await writeFile(source.archive, bytes);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== source.sha256)
    throw new Error(
      `The digest of ${source.name} is ${digest}, not the pinned one`,
    );
  return bytes;
}

export async function generatedSources(): Promise<{
  readonly typeScript: string;
  readonly swift: string;
  readonly traditionalForms: string;
}> {
  const files = zipEntries(await pinnedFile(unihan), [
    otherMappings,
    variantsFile,
  ]);
  const mappings = files.get(otherMappings) ?? "";
  const variants = files.get(variantsFile) ?? "";
  const notice = readTraditionalForms(
    await readPdfTables(await pinnedFile(joyoKanjiTable)),
  );
  requireUnihanAgreement(notice, mappings, variants);
  const table = kanjiVariantTable(mappings, variants, notice.pairs);
  return {
    typeScript: typeScriptSource(table),
    swift: swiftSource(table),
    traditionalForms: traditionalFormsSource(notice.pairs),
  };
}

/** Requires the committed tables and traditional forms to equal a fresh generation from the pinned sources. */
export async function checkKanjiVariants(): Promise<void> {
  const fresh = await generatedSources();
  for (const [path, text] of [
    [generatedTypeScript, fresh.typeScript],
    [generatedSwift, fresh.swift],
    [generatedTraditionalForms, fresh.traditionalForms],
  ] as const)
    if ((await readFile(path, "utf8")) !== text)
      throw new Error(
        `${path} differs from its generation; run node tools/kanji-variants.ts write`,
      );
  console.info(
    JSON.stringify({
      operation: "kanji-variants",
      unihan: unihan.version,
      joyoKanjiTable: joyoKanjiTable.sha256,
    }),
  );
}

function committedPairs(text: string, name: string): [number, number][] {
  const pairs = new RegExp(
    `^export const ${name} =\\n {2}"([0-9a-f: ]*)";$`,
    "mu",
  ).exec(text)?.[1];
  if (pairs === undefined) throw new Error(`${name} has no committed pairs`);
  return pairs.split(" ").map((pair): [number, number] => {
    const [from = "", to = ""] = pair.split(":");
    return [
      Number.parseInt(from, hexadecimalRadix),
      Number.parseInt(to, hexadecimalRadix),
    ];
  });
}

/** Requires every traditional form to fold into its standard character through the table. */
export function requireTraditionalForms(
  table: ReadonlyMap<number, number>,
  traditional: readonly (readonly [number, number])[],
): void {
  const characters = new Set(traditional.map(([, character]) => character));
  if (
    traditional.length !== joyoKanjiTable.traditionalForms ||
    characters.size !== joyoKanjiTable.bracketedCharacters
  )
    throw new Error(
      `${generatedTraditionalForms} holds ${traditional.length} forms beside ${characters.size} characters`,
    );
  requireFolds(table, traditional);
}

/**
 * Requires, without the network, that both committed tables carry the same pairs and fold every committed traditional form under the pinned provenance.
 * The fast gate runs this, and the build gate regenerates the files from the pinned sources with `checkKanjiVariants`.
 */
export async function checkKanjiVariantProvenance(): Promise<void> {
  const typeScript = await readFile(generatedTypeScript, "utf8");
  const table = new Map(committedPairs(typeScript, "kanjiVariantPairs"));
  if (typeScript !== typeScriptSource(table))
    throw new Error(`${generatedTypeScript} lacks the pinned provenance`);
  if ((await readFile(generatedSwift, "utf8")) !== swiftSource(table))
    throw new Error(`${generatedSwift} differs from ${generatedTypeScript}`);
  const forms = await readFile(generatedTraditionalForms, "utf8");
  const traditional = committedPairs(forms, "joyoTraditionalForms");
  if (forms !== traditionalFormsSource(traditional))
    throw new Error(`${generatedTraditionalForms} lacks the pinned provenance`);
  requireTraditionalForms(table, traditional);
  console.info(
    JSON.stringify({
      operation: "kanji-variant-provenance",
      unihan: unihan.version,
      joyoKanjiTable: joyoKanjiTable.sha256,
      pairs: table.size,
      traditionalForms: traditional.length,
    }),
  );
}

if (import.meta.main) {
  if (process.argv.includes("write")) {
    const fresh = await generatedSources();
    await writeFile(generatedTypeScript, fresh.typeScript);
    await writeFile(generatedSwift, fresh.swift);
    await writeFile(generatedTraditionalForms, fresh.traditionalForms);
  } else await checkKanjiVariants();
}
