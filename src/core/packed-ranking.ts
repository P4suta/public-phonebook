import * as v from "valibot";
import { packedMidpoint } from "./forgiving-search-policy.ts";
import { DigestSchema } from "./models.ts";
import {
  packedSectionFits,
  packedShortCount,
} from "./packed-ranking-policy.ts";
import type { SearchIndex } from "./search-index.ts";
import type {
  RankingArtifact,
  RankingPosting,
} from "./search-ranking-artifact.ts";
import {
  compactSearchText,
  rankingName,
  searchGrams,
} from "./search-ranking-text.ts";

export const packedRankingSignature = "public-phonebook-search-ranking\t2\n";
const wordBytes = 4;
const entryWords = 3;
const rowWords = 3;
const countColumn = 2;
const statsColumn = 2;
const varintBase = 128;
const maximumVarintMultiplier = varintBase ** 3;
const lineFeedByte = 10;
const stringCacheEntries = 8192;
const maximumCachedCodeUnits = 256;
const maximumPostingWeight = 100_000;
const maximumReadingChoices = 8;
const maximumReadingPoints = 8192;
const halfWordMask = 0xffff;
const halfWordBits = 16;
const halfWordRange = 65_536;
const maximumWord = 0xffff_ffff;
const wordBits = 32;
const byteBits = 8;
const byteMask = 255;
const bigramWidth = 2;
const trigramWidth = 3;
const limit = 256 * 1_048_576;
const Natural = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(0),
  v.maxValue(limit),
);
const Metadata = v.strictObject({
  snapshot: DigestSchema,
  contacts: v.pipe(Natural, v.maxValue(2_000_000)),
  sourceSha256: DigestSchema,
  analyzer: v.strictObject({ engine: v.string(), dictionary: DigestSchema }),
  variants: v.array(v.tuple([v.string(), v.string()])),
  aliases: v.array(v.tuple([Natural, v.string()])),
  unknownWeight: v.pipe(Natural, v.minValue(1), v.maxValue(100_000)),
  literalUsesFolded: v.boolean(),
  sections: v.array(v.tuple([v.string(), Natural])),
});
const dictionaryNames = [
  "original",
  "written",
  "folded",
  "short",
  "literal",
  "reading",
  "lexicon",
  "lexical",
  "phonetic",
] as const;
type DictionaryName = (typeof dictionaryNames)[number];
type ExactKind = "original" | "written" | "folded" | "literal" | "reading";

export function lazyArray<T>(
  length: number,
  read: (index: number) => T,
): readonly T[] {
  const target: T[] = [];
  function ordinal(key: string | symbol): number | null {
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key))
      return null;
    const value = Number(key);
    return value < length ? value : null;
  }
  return new Proxy(target, {
    get: (array, key, receiver) => {
      if (key === "length") return length;
      const index = ordinal(key);
      const value: unknown =
        index === null ? Reflect.get(array, key, receiver) : read(index);
      return value;
    },
    has: (array, key) => ordinal(key) !== null || Reflect.has(array, key),
  });
}

function aligned(value: number): number {
  return Math.ceil(value / wordBytes) * wordBytes;
}

export interface PackedPosting {
  readonly weight: number;
  readonly rows: ArrayLike<number> & Iterable<number>;
}

function visitPosting(
  bytes: Uint8Array,
  fixed: boolean,
  count: number,
  maximum: number,
  visit?: (row: number) => void,
  start = 0,
  end = bytes.length,
): void {
  let seen = 0;
  if (fixed) {
    if (end - start !== count * wordBytes)
      throw new Error("Packed fixed posting length mismatch");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = start; at < end; at += wordBytes) {
      const row = view.getUint32(at, true);
      if (row >= maximum) throw new Error("Packed posting outside table");
      visit?.(row);
      seen += 1;
    }
  } else {
    let previous = -1;
    let delta = 0;
    let multiplier = 1;
    for (let at = start; at < end; at += 1) {
      const byte = bytes[at];
      if (byte === undefined) throw new Error("Truncated packed posting");
      delta += (byte % varintBase) * multiplier;
      if (byte < varintBase) {
        if (delta === 0 || (multiplier > 1 && byte === 0))
          throw new Error("Noncanonical packed posting");
        previous += delta;
        if (previous >= maximum)
          throw new Error("Packed posting outside snapshot");
        visit?.(previous);
        seen += 1;
        delta = 0;
        multiplier = 1;
      } else {
        multiplier *= varintBase;
        if (multiplier > maximumVarintMultiplier)
          throw new Error("Overflowing packed posting");
      }
    }
    if (multiplier !== 1) throw new Error("Truncated packed posting");
  }
  if (seen !== count) throw new Error("Packed posting count mismatch");
}

export class PackedDictionary {
  private readonly table: DataView;
  private readonly values: Uint8Array;
  private readonly text: (id: number) => string;
  private readonly fixed: boolean;
  private readonly weights: DataView | undefined;
  private readonly maximum: number;

  constructor(
    table: DataView,
    values: Uint8Array,
    text: (id: number) => string,
    fixed: boolean,
    maximum: number,
    weights?: DataView,
  ) {
    this.table = table;
    this.values = values;
    this.text = text;
    this.fixed = fixed;
    this.weights = weights;
    this.maximum = maximum;
  }

  get length(): number {
    return this.table.byteLength / (entryWords * wordBytes);
  }

  private visitAt(
    at: number,
    visit: (row: number, weight: number) => void,
  ): number {
    const offset = at * entryWords * wordBytes;
    const start = this.table.getUint32(offset + wordBytes, true);
    const count = this.table.getUint32(offset + countColumn * wordBytes, true);
    const weight = this.weights?.getUint32(at * wordBytes, true) ?? 0;
    const end =
      at + 1 === this.length
        ? this.values.length
        : this.table.getUint32(offset + (entryWords + 1) * wordBytes, true);
    visitPosting(
      this.values,
      this.fixed,
      count,
      this.maximum,
      (row) => visit(row, weight),
      start,
      end,
    );
    return weight;
  }

  entry(at: number): readonly [string, PackedPosting] {
    const offset = at * entryWords * wordBytes;
    const rows = new Uint32Array(
      this.table.getUint32(offset + countColumn * wordBytes, true),
    );
    let position = 0;
    const weight = this.visitAt(at, (row) => {
      rows[position++] = row;
    });
    return [this.text(this.table.getUint32(offset, true)), { weight, rows }];
  }

  visit(
    key: string,
    visit: (row: number, weight: number) => void,
  ): number | undefined {
    const at = this.find(key);
    return at < 0 ? undefined : this.visitAt(at, visit);
  }

  lowerBound(key: string): number {
    let low = 0;
    let high = this.length;
    while (low < high) {
      const middle = packedMidpoint(low, high);
      const value = this.text(
        this.table.getUint32(middle * entryWords * wordBytes, true),
      );
      if (value < key) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  find(key: string): number {
    const low = this.lowerBound(key);
    return low < this.length &&
      this.text(this.table.getUint32(low * entryWords * wordBytes, true)) ===
        key
      ? low
      : -1;
  }

  count(key: string): number {
    const at = this.find(key);
    return at < 0
      ? 0
      : this.table.getUint32((at * entryWords + countColumn) * wordBytes, true);
  }

  get(key: string): PackedPosting | undefined {
    const at = this.find(key);
    if (at < 0) return undefined;
    return this.entry(at)[1];
  }

  prefix(key: string): PackedPosting | undefined {
    const at = this.lowerBound(key);
    if (at === this.length) return undefined;
    const text = this.text(
      this.table.getUint32(at * entryWords * wordBytes, true),
    );
    if (!text.startsWith(key)) return undefined;
    return text === key ? this.entry(at)[1] : { weight: 0, rows: [] };
  }
}

export interface PackedRanking {
  readonly sourceSha256: string;
  readonly names: readonly string[];
  readonly literals: readonly string[];
  readonly lengths: readonly number[];
  readonly characters: readonly number[];
  name(this: void, row: number): string;
  literal(this: void, row: number): string;
  reading(this: void, row: number): string;
  characterCount(row: number): number;
  length(row: number): number;
  norm(row: number): number;
  trigramCount(row: number, reading: boolean): number;
  exact(
    kind: ExactKind,
    key: string,
    keyOf: (row: number) => string,
  ): readonly number[] | undefined;
  readonly dictionaries: Readonly<Record<DictionaryName, PackedDictionary>>;
  choices(surface: string): readonly string[] | undefined;
}

export function decodePackedRanking(
  bytes: Uint8Array,
  snapshot: string,
  contacts: number,
): RankingArtifact {
  if (bytes.length > limit)
    throw new Error("Packed ranking exceeds its byte limit");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const first = bytes.indexOf(lineFeedByte);
  if (
    first < 0 ||
    decoder.decode(bytes.subarray(0, first + 1)) !== packedRankingSignature
  )
    throw new Error("Unsupported packed ranking format");
  const second = bytes.indexOf(lineFeedByte, first + 1);
  if (second < 0) throw new Error("Missing packed metadata");
  const parsed = v.safeParse(
    Metadata,
    JSON.parse(decoder.decode(bytes.subarray(first + 1, second))),
  );
  if (!parsed.success)
    throw new Error("Invalid packed ranking format metadata");
  const metadata = parsed.output;
  if (metadata.snapshot !== snapshot || metadata.contacts !== contacts)
    throw new Error("Packed ranking snapshot or count mismatch");
  const variants = new Map(metadata.variants);
  if (
    variants.size !== metadata.variants.length ||
    metadata.variants.some(
      ([from, to]) =>
        Array.from(from).length !== 1 ||
        Array.from(to).length !== 1 ||
        variants.has(to),
    ) ||
    metadata.aliases.some(([row, kana]) => row >= contacts || !kana)
  )
    throw new Error("Invalid packed variants or aliases");
  const sections = new Map<string, Uint8Array>();
  let offset = aligned(second + 1);
  for (const [name, length] of metadata.sections) {
    if (sections.has(name) || !packedSectionFits(offset, length, bytes.length))
      throw new Error("Invalid packed section");
    sections.set(name, bytes.subarray(offset, offset + length));
    offset = aligned(offset + length);
  }
  if (offset !== bytes.length)
    throw new Error("Trailing or truncated packed ranking bytes");
  function section(name: string, width: number): DataView {
    const value = sections.get(name);
    if (!value || value.byteLength % width !== 0)
      throw new Error("Missing or misaligned packed section");
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
  }
  const strings = sections.get("strings");
  if (!strings) throw new Error("Missing packed strings");
  const offsets = section("offsets", wordBytes);
  const stringCount = offsets.byteLength / wordBytes - 1;
  let previous = 0;
  for (let at = 0; at <= stringCount; at += 1) {
    const end = offsets.getUint32(at * wordBytes, true);
    if (end < previous || end > strings.length || (at === 0 && end !== 0))
      throw new Error("Invalid packed string offset");
    previous = end;
  }
  if (previous !== strings.length)
    throw new Error("Packed string length mismatch");
  const stringCache = new Map<number, string>();
  const stringRing = new Uint32Array(stringCacheEntries);
  let stringCursor = 0;
  const text = (id: number): string => {
    if (id >= stringCount) throw new Error("Packed string outside table");
    const previous = stringCache.get(id);
    if (previous !== undefined) return previous;
    const decoded = decoder.decode(
      strings.subarray(
        offsets.getUint32(id * wordBytes, true),
        offsets.getUint32((id + 1) * wordBytes, true),
      ),
    );
    if (decoded.length <= maximumCachedCodeUnits) {
      if (stringCache.size === stringRing.length)
        stringCache.delete(stringRing[stringCursor] ?? 0);
      stringCache.set(id, decoded);
      stringRing[stringCursor] = id;
      stringCursor = (stringCursor + 1) % stringRing.length;
    }
    return decoded;
  };
  const rows = section("rows", rowWords * wordBytes);
  const norms = section("norms", wordBytes);
  const trigrams = section("trigrams", wordBytes);
  if (
    rows.byteLength !== contacts * rowWords * wordBytes ||
    norms.byteLength !== contacts * wordBytes ||
    trigrams.byteLength !== contacts * wordBytes
  )
    throw new Error("Packed row count mismatch");
  const value = (row: number, column: number): number =>
    rows.getUint32((row * rowWords + column) * wordBytes, true);
  for (let row = 0; row < contacts; row += 1) {
    if (value(row, 0) >= stringCount || value(row, 1) >= stringCount)
      throw new Error("Invalid packed row");
  }
  function dictionary(name: DictionaryName): PackedDictionary {
    const table = section(name, entryWords * wordBytes);
    const values = sections.get(`${name}:values`);
    if (!values) throw new Error("Missing packed dictionary values");
    const fixed = name === "short" || name === "lexicon";
    let previous = 0;
    for (let at = 0; at < table.byteLength; at += entryWords * wordBytes) {
      const start = table.getUint32(at + wordBytes, true);
      const count = table.getUint32(at + countColumn * wordBytes, true);
      if (
        table.getUint32(at, true) >= stringCount ||
        start < previous ||
        start > values.length ||
        (at === 0 && start !== 0) ||
        count === 0 ||
        count > (name === "lexicon" ? maximumReadingChoices : contacts) ||
        (fixed && start + count * wordBytes > values.length)
      )
        throw new Error("Invalid packed dictionary entry");
      previous = start;
      const end =
        at + entryWords * wordBytes === table.byteLength
          ? values.length
          : table.getUint32(at + (entryWords + 1) * wordBytes, true);
      if (end < start || end > values.length)
        throw new Error("Invalid packed posting offset");
      visitPosting(
        values,
        fixed,
        count,
        name === "lexicon" ? stringCount : contacts,
        undefined,
        start,
        end,
      );
    }
    const weights =
      name === "lexical" ? section("weights", wordBytes) : undefined;
    if (weights && weights.byteLength !== table.byteLength / entryWords)
      throw new Error("Packed weight count mismatch");
    if (weights)
      for (let at = 0; at < weights.byteLength; at += wordBytes)
        if (
          weights.getUint32(at, true) < 1 ||
          weights.getUint32(at, true) > maximumPostingWeight
        )
          throw new Error("Invalid packed lexical weight");
    return new PackedDictionary(
      table,
      values,
      text,
      fixed,
      name === "lexicon" ? stringCount : contacts,
      weights,
    );
  }
  const folded = dictionary("folded");
  const exactOrders = {
    original: section("original:order", wordBytes),
    written: section("written:order", wordBytes),
    folded: section("folded:order", wordBytes),
    literal: metadata.literalUsesFolded
      ? section("folded:order", wordBytes)
      : section("literal:order", wordBytes),
    reading: section("reading:order", wordBytes),
  };
  for (const order of Object.values(exactOrders)) {
    if (order.byteLength !== contacts * wordBytes)
      throw new Error("Packed exact count mismatch");
    const seen = new Uint8Array(contacts);
    for (let at = 0; at < contacts; at += 1) {
      const row = order.getUint32(at * wordBytes, true);
      if (row >= contacts || seen[row])
        throw new Error("Invalid packed exact permutation");
      seen[row] = 1;
    }
  }
  const dictionaries = {
    original: dictionary("original"),
    written: dictionary("written"),
    folded,
    short: dictionary("short"),
    literal: metadata.literalUsesFolded ? folded : dictionary("literal"),
    reading: dictionary("reading"),
    lexicon: dictionary("lexicon"),
    lexical: dictionary("lexical"),
    phonetic: dictionary("phonetic"),
  };
  const packed: PackedRanking = {
    sourceSha256: metadata.sourceSha256,
    name: (row) => text(value(row, 0)),
    literal: (row) =>
      metadata.literalUsesFolded
        ? text(value(row, 0))
        : compactSearchText(text(value(row, 0))),
    reading: (row) => text(value(row, 1)),
    characterCount: (row) => value(row, statsColumn) & halfWordMask,
    length: (row) => value(row, statsColumn) >>> halfWordBits,
    names: lazyArray(contacts, (row) => text(value(row, 0))),
    literals: lazyArray(contacts, (row) =>
      metadata.literalUsesFolded
        ? text(value(row, 0))
        : compactSearchText(text(value(row, 0))),
    ),
    lengths: lazyArray(
      contacts,
      (row) => value(row, statsColumn) >>> halfWordBits,
    ),
    characters: lazyArray(
      contacts,
      (row) => value(row, statsColumn) & halfWordMask,
    ),
    norm: (row) => norms.getUint32(row * wordBytes, true),
    trigramCount: (row, reading) =>
      reading
        ? trigrams.getUint32(row * wordBytes, true) >>> halfWordBits
        : trigrams.getUint32(row * wordBytes, true) & halfWordMask,
    exact: (kind, key, keyOf) => {
      const order = exactOrders[kind];
      let low = 0;
      let high = contacts;
      while (low < high) {
        const middle = packedMidpoint(low, high);
        if (keyOf(order.getUint32(middle * wordBytes, true)) < key)
          low = middle + 1;
        else high = middle;
      }
      const result: number[] = [];
      while (low < contacts) {
        const row = order.getUint32(low * wordBytes, true);
        if (keyOf(row) !== key) break;
        result.push(row);
        low += 1;
      }
      return result.length ? result : undefined;
    },
    dictionaries,
    choices: (surface) => {
      const entry = dictionaries.lexicon.prefix(surface);
      return entry ? Array.from(entry.rows, text) : undefined;
    },
  };
  const postings = (name: "lexical" | "phonetic"): readonly RankingPosting[] =>
    lazyArray(dictionaries[name].length, (at) => {
      const [key, entry] = dictionaries[name].entry(at);
      return [key, entry.weight, Array.from(entry.rows)];
    });
  return {
    ...metadata,
    readings: lazyArray(contacts, (row) => text(value(row, 1))),
    lexicon: [],
    lexical: postings("lexical"),
    phonetic: postings("phonetic"),
    packed,
  };
}

export function encodePackedRanking(
  index: SearchIndex,
  artifact: RankingArtifact,
  sourceSha256: string,
): Uint8Array {
  if (
    index.header.snapshot !== artifact.snapshot ||
    index.rows.length !== artifact.contacts
  )
    throw new Error("Packed source identity mismatch");
  const encoder = new TextEncoder();
  const strings: Uint8Array[] = [];
  const offsets = [0];
  const ids = new Map<string, number>();
  function intern(text: string): number {
    const previous = ids.get(text);
    if (previous !== undefined) return previous;
    const id = strings.length;
    const bytes = encoder.encode(text);
    strings.push(bytes);
    offsets.push((offsets.at(-1) ?? 0) + bytes.length);
    ids.set(text, id);
    return id;
  }
  const sections: [string, Uint8Array][] = [];
  function words(name: string, values: readonly number[]): void {
    const bytes = new Uint8Array(values.length * wordBytes);
    const view = new DataView(bytes.buffer);
    for (const [at, value] of values.entries()) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximumWord)
        throw new Error("Packed word out of range");
      view.setUint32(at * wordBytes, value, true);
    }
    sections.push([name, bytes]);
  }
  const maps = new Map<DictionaryName, Map<string, number[]>>(
    dictionaryNames.map((key) => [key, new Map()]),
  );
  function append(name: DictionaryName, key: string, row: number): void {
    const map = maps.get(name);
    if (!map) throw new Error("Missing packed builder dictionary");
    const values = map.get(key) ?? [];
    values.push(row);
    map.set(key, values);
  }
  const variants = new Map(artifact.variants);
  const lengths: number[] = [];
  const rows: number[] = [];
  const trigrams: number[] = [];
  let literalUsesFolded = true;
  for (const [row, entry] of index.rows.entries()) {
    const name = rankingName(entry.name, variants);
    const literal = compactSearchText(name);
    const reading = compactSearchText(artifact.readings[row] ?? "");
    const length = Array.from(name).length;
    lengths.push(length);
    const characters = searchGrams(name, 1).length;
    if (length > halfWordMask || characters > halfWordMask)
      throw new Error("Packed name length exceeds its format");
    rows.push(
      intern(name),
      intern(reading),
      length * halfWordRange + characters,
    );
    const literalTrigrams = searchGrams(literal, trigramWidth).length;
    const readingTrigrams = searchGrams(reading, trigramWidth).length;
    if (literalTrigrams > halfWordMask || readingTrigrams > halfWordMask)
      throw new Error("Packed trigram count exceeds its format");
    trigrams.push(literalTrigrams + readingTrigrams * halfWordRange);
    if (literal !== name) literalUsesFolded = false;
    append(
      "original",
      entry.name
        .normalize("NFKC")
        .toLowerCase()
        .replace(/\p{White_Space}+/gu, "")
        .normalize("NFC"),
      row,
    );
    append("written", compactSearchText(entry.name).normalize("NFC"), row);
    append("folded", name, row);
    append("literal", literal, row);
    append("reading", reading, row);
    for (const key of new Set([
      ...Array.from(name),
      ...searchGrams(name, bigramWidth),
    ]))
      append("short", key, row);
  }
  for (const values of maps.get("short")?.values() ?? []) {
    values.sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0) || a - b);
    values.length = packedShortCount(values.length);
  }
  const choices = new Map<string, Map<string, number>>();
  for (const [surface, value, count] of artifact.lexicon) {
    const key = compactSearchText(surface);
    const reading = compactSearchText(value);
    if (!key || !reading) continue;
    const own = choices.get(key) ?? new Map<string, number>();
    const total = (own.get(reading) ?? 0) + count;
    if (
      !Number.isSafeInteger(total) ||
      count < 1 ||
      Array.from(reading).length > maximumReadingPoints
    )
      throw new Error("Invalid packed lexicon count or reading");
    own.set(reading, total);
    choices.set(key, own);
  }
  for (const [key, own] of choices) {
    for (const [reading] of [...own]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, maximumReadingChoices))
      append("lexicon", key, intern(reading));
  }
  const norms = new Float64Array(artifact.contacts);
  const weights = new Map<string, number>();
  for (const [key, weight, values] of artifact.lexical) {
    maps.get("lexical")?.set(key, [...values]);
    weights.set(key, weight);
    for (const row of values) norms[row] = (norms[row] ?? 0) + weight;
  }
  for (const [key, , values] of artifact.phonetic)
    maps.get("phonetic")?.set(key, [...values]);
  words("rows", rows);
  words("norms", [...norms]);
  words("trigrams", trigrams);
  const lexicalWeights: number[] = [];
  for (const name of dictionaryNames) {
    const table: number[] = [];
    const values: number[] = [];
    const sorted = [...(maps.get(name) ?? [])].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    if (
      name === "original" ||
      name === "written" ||
      name === "folded" ||
      name === "literal" ||
      name === "reading"
    )
      words(
        `${name}:order`,
        name === "literal" && literalUsesFolded
          ? []
          : sorted.flatMap(([, list]) => list),
      );
    for (const [key, list] of [
      ...((name === "original" ||
      name === "written" ||
      name === "folded" ||
      name === "literal" ||
      name === "reading"
        ? undefined
        : maps.get(name)) ?? []),
    ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      table.push(intern(key), values.length, list.length);
      if (name === "lexical") lexicalWeights.push(weights.get(key) ?? 0);
      if (name === "short" || name === "lexicon") {
        for (const row of list)
          for (let shift = 0; shift < wordBits; shift += byteBits)
            values.push((row >>> shift) & byteMask);
      } else {
        let previous = -1;
        for (const row of list) {
          let delta = row - previous;
          if (
            !Number.isSafeInteger(delta) ||
            delta <= 0 ||
            row >= artifact.contacts
          )
            throw new Error("Invalid packed source posting");
          while (delta >= varintBase) {
            values.push((delta % varintBase) + varintBase);
            delta = Math.floor(delta / varintBase);
          }
          values.push(delta);
          previous = row;
        }
      }
    }
    words(name, table);
    sections.push([`${name}:values`, Uint8Array.from(values)]);
  }
  words("weights", lexicalWeights);
  words("offsets", offsets);
  const blob = new Uint8Array(offsets.at(-1) ?? 0);
  let at = 0;
  for (const bytes of strings) {
    blob.set(bytes, at);
    at += bytes.length;
  }
  sections.push(["strings", blob]);
  const metadata = v.parse(Metadata, {
    snapshot: artifact.snapshot,
    contacts: artifact.contacts,
    sourceSha256,
    analyzer: artifact.analyzer,
    variants: artifact.variants,
    aliases: artifact.aliases,
    unknownWeight: artifact.unknownWeight,
    literalUsesFolded,
    sections: sections.map(([name, bytes]) => [name, bytes.length]),
  });
  const prefix = encoder.encode(
    `${packedRankingSignature}${JSON.stringify(metadata)}\n`,
  );
  const size = sections.reduce(
    (sum, [, bytes]) => aligned(sum + bytes.length),
    aligned(prefix.length),
  );
  if (size > limit)
    throw new Error(
      `Packed ranking exceeds its byte limit: ${size}; ${JSON.stringify(metadata.sections)}`,
    );
  const output = new Uint8Array(size);
  output.set(prefix);
  at = aligned(prefix.length);
  for (const [, bytes] of sections) {
    output.set(bytes, at);
    at = aligned(at + bytes.length);
  }
  return output;
}
