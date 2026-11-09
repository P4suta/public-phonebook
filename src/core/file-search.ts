import * as v from "valibot";
import { normalizeNameLines } from "./identity.ts";
import {
  type LocalPage,
  type LocalResults,
  localPreviewSize,
  localQuery,
} from "./local-search.ts";
import { groupPrecedes, nextVisible } from "./local-search-policy.ts";
import type { LocalRow } from "./local-search-protocol.ts";
import type { Result } from "./result.ts";
import {
  checkHeader,
  checkName,
  checkPhoneBytes,
  hasSearchIndexSignature,
  type SearchIndexHeader,
  SearchIndexHeaderSchema,
  splitNameLine,
} from "./search-index.ts";
import { searchNameLines } from "./search-text.ts";
import { wordPlaces } from "./word-match.ts";

const lineFeed = 10;
const offsetWidth = 4;
const scanBytes = 262_144;
const admissionBytes = 65_536;
const headerBytes = 1_048_576;
export const maximumSearchBufferBytes = 8 * 1_048_576;
const workspaceBytes =
  scanBytes * 7 + offsetWidth + admissionBytes * 4 + 256 * 8;
const rankCount = 4;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const surrogate = /\p{Surrogate}/u;

export interface SearchFile {
  getSize(): number;
  read(buffer: Uint8Array, at: number): number;
  write(buffer: Uint8Array, at: number): number;
}

export interface SearchFiles {
  readonly raw: SearchFile;
  readonly folded: SearchFile;
  readonly names: SearchFile;
  readonly phones: SearchFile;
}

export interface FileSearch {
  readonly header: SearchIndexHeader;
  readonly retainedBufferBytes: number;
  search(query: string): Result<LocalResults, "invalid_query">;
  continue(
    query: string,
    category: string,
    visible: number,
  ): Result<LocalPage, "invalid_query" | "invalid_continuation">;
  row(position: number): LocalRow;
}

function fail(message: string): never {
  throw new Error(message);
}

export function readSearchFile(
  file: SearchFile,
  buffer: Uint8Array,
  at: number,
): void {
  let offset = 0;
  while (offset < buffer.length) {
    const count = file.read(buffer.subarray(offset), at + offset);
    if (
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > buffer.length - offset
    )
      fail("The search file returned a short read");
    offset += count;
  }
}

export function writeSearchFile(
  file: SearchFile,
  buffer: Uint8Array,
  at: number,
): void {
  let offset = 0;
  while (offset < buffer.length) {
    const count = file.write(buffer.subarray(offset), at + offset);
    if (
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > buffer.length - offset
    )
      fail("The search file returned a short write");
    offset += count;
  }
}

interface Block {
  readonly at: number;
  readonly bytes: Uint8Array;
}

function* blocks(
  file: SearchFile,
  start: number,
  end: number,
  buffer: Uint8Array,
): Generator<Block> {
  for (let at = start; at < end; ) {
    let length = Math.min(end - at, buffer.length);
    readSearchFile(file, buffer.subarray(0, length), at);
    length = buffer.lastIndexOf(lineFeed, length - 1) + 1;
    if (length === 0) fail("A search file line exceeds the read buffer");
    yield { at, bytes: buffer.subarray(0, length) };
    at += length;
  }
}

function offsets(bytes: Uint8Array, at: number): Uint8Array {
  const count = bytes.reduce(
    (sum, byte) => sum + (byte === lineFeed ? 1 : 0),
    0,
  );
  const output = new Uint8Array(count * offsetWidth);
  const view = new DataView(output.buffer);
  let row = 0;
  view.setUint32(0, at, true);
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== lineFeed) continue;
    row += 1;
    if (row < count) view.setUint32(row * offsetWidth, at + index + 1, true);
  }
  return output;
}

function lastOffset(file: SearchFile, rows: number, at: number): void {
  const bytes = new Uint8Array(offsetWidth);
  new DataView(bytes.buffer).setUint32(0, at, true);
  writeSearchFile(file, bytes, rows * offsetWidth);
}

function headerFrom(file: SearchFile): {
  readonly header: SearchIndexHeader;
  readonly start: number;
} {
  const prefix = new Uint8Array(Math.min(headerBytes, file.getSize()));
  readSearchFile(file, prefix, 0);
  if (!hasSearchIndexSignature(prefix)) fail("Unsupported search index format");
  const first = prefix.indexOf(lineFeed) + 1;
  const end = prefix.indexOf(lineFeed, first);
  if (end < 0) fail("The search index header exceeds its read buffer");
  const parsed: unknown = JSON.parse(
    decoder.decode(prefix.subarray(first, end)),
  );
  const header = v.parse(SearchIndexHeaderSchema, parsed);
  checkHeader(header);
  const { contacts, parts } = header;
  if (contacts * 4 + workspaceBytes > maximumSearchBufferBytes)
    fail("The search index exceeds its resident buffer budget");
  if (
    parts.categories !== contacts ||
    parts.regions !== contacts * 2 ||
    file.getSize() !==
      end + 1 + parts.names + parts.categories + parts.regions + parts.phones ||
    file.getSize() > 0xffff_ffff
  )
    fail("The search index length differs from its header");
  return { header, start: end + 1 };
}

class FileReader {
  readonly file: SearchFile;
  readonly buffer = new Uint8Array(admissionBytes);
  #start = -1;
  #length = 0;

  constructor(file: SearchFile) {
    this.file = file;
  }

  read(at: number, length: number): Uint8Array {
    if (at < 0 || length < 0 || at + length > this.file.getSize())
      fail("Search data outside the file");
    const output = new Uint8Array(length);
    let copied = 0;
    while (copied < length) {
      const position = at + copied;
      if (position < this.#start || position >= this.#start + this.#length) {
        this.#start =
          Math.floor(position / this.buffer.length) * this.buffer.length;
        this.#length = Math.min(
          this.buffer.length,
          this.file.getSize() - this.#start,
        );
        readSearchFile(
          this.file,
          this.buffer.subarray(0, this.#length),
          this.#start,
        );
      }
      const local = position - this.#start;
      const count = Math.min(length - copied, this.#length - local);
      output.set(this.buffer.subarray(local, local + count), copied);
      copied += count;
    }
    return output;
  }
}

function lineFrom(
  file: FileReader,
  positions: FileReader,
  row: number,
): string {
  const bytes = positions.read(row * offsetWidth, offsetWidth * 2);
  const view = new DataView(bytes.buffer);
  const start = view.getUint32(0, true);
  const end = view.getUint32(offsetWidth, true);
  return decoder.decode(file.read(start, end - start - 1));
}

interface Bucket {
  total: number;
  readonly rows: number[];
}
interface Summary {
  readonly groups: readonly {
    readonly category: string;
    readonly buckets: readonly Bucket[];
  }[];
  readonly total: number;
}

function containsAt(bytes: Uint8Array, word: Uint8Array, at: number): boolean {
  if (at + word.length > bytes.length) return false;
  for (let index = 0; index < word.length; index += 1)
    if (bytes[at + index] !== word[index]) return false;
  return true;
}

function rowAt(ends: Uint32Array, count: number, at: number): number {
  let low = 0;
  let high = count;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((ends[middle] ?? 0) <= at) low = middle;
    else high = middle;
  }
  return low;
}

export async function admitFileSearch(
  files: SearchFiles,
  yieldBatch: () => Promise<void>,
): Promise<FileSearch> {
  const { header, start } = headerFrom(files.raw);
  const { contacts, parts } = header;
  const namesEnd = start + parts.names;
  const regionsStart = namesEnd + parts.categories;
  const phonesStart = regionsStart + parts.regions;
  const categories = new Uint8Array(parts.categories);
  const regions = new Uint8Array(parts.regions);
  readSearchFile(files.raw, categories, namesEnd);
  readSearchFile(files.raw, regions, regionsStart);
  const regionView = new DataView(regions.buffer);
  const usedRegions = new Set<number>();
  for (let row = 0; row < contacts; row += 1) {
    const region = regionView.getUint16(row * 2, true);
    if (!header.categories[categories[row] ?? -1] || !header.regions[region])
      fail("Search index row reference out of range");
    usedRegions.add(region);
  }
  if (usedRegions.size !== header.regions.length)
    fail("Every search index region must be referenced");
  const admissionBuffer = new Uint8Array(admissionBytes);
  const frequencies = new Float64Array(256);
  let previous: string | undefined;
  let nameRows = 0;
  let foldedBytes = 0;
  for (const block of blocks(files.raw, start, namesEnd, admissionBuffer)) {
    const lines = decoder
      .decode(block.bytes)
      .slice(0, -1)
      .split("\n")
      .map(splitNameLine);
    const display = lines.map((line) => line.name).join("\n");
    const normalized = normalizeNameLines(display);
    for (const [index, line] of lines.entries()) {
      checkName(line.normalizedName, line.name, previous, normalized[index]);
      previous = line.normalizedName;
    }
    const folded = encoder.encode(`${searchNameLines(display).join("\n")}\n`);
    for (const byte of folded) frequencies[byte] = (frequencies[byte] ?? 0) + 1;
    writeSearchFile(files.folded, folded, foldedBytes);
    foldedBytes += folded.length;
    writeSearchFile(
      files.names,
      offsets(block.bytes, block.at),
      nameRows * offsetWidth,
    );
    nameRows += lines.length;
    if (nameRows > contacts) fail("The search index name count differs");
    await yieldBatch();
  }
  if (nameRows !== contacts) fail("The search index name count differs");
  lastOffset(files.names, contacts, namesEnd);
  let phoneRows = 0;
  for (const block of blocks(
    files.raw,
    phonesStart,
    files.raw.getSize(),
    admissionBuffer,
  )) {
    checkPhoneBytes(block.bytes);
    const positions = offsets(block.bytes, block.at);
    writeSearchFile(files.phones, positions, phoneRows * offsetWidth);
    phoneRows += positions.length / offsetWidth;
    if (phoneRows > contacts) fail("The search index telephone count differs");
    await yieldBatch();
  }
  if (phoneRows !== contacts) fail("The search index telephone count differs");
  lastOffset(files.phones, contacts, files.raw.getSize());

  const ranks = new Uint8Array(contacts);
  const scanBuffer = new Uint8Array(scanBytes);
  const ends = new Uint32Array(scanBytes + 1);
  const masks = new Uint8Array(scanBytes);
  const singleRanks = new Uint8Array(scanBytes);
  let cached: { readonly query: string; readonly summary: Summary } | null =
    null;
  const nameReader = new FileReader(files.raw);
  const phoneReader = new FileReader(files.raw);
  const namePositions = new FileReader(files.names);
  const phonePositions = new FileReader(files.phones);

  function matches(input: string): Result<Summary, "invalid_query"> {
    if (cached?.query === input) return { ok: true, value: cached.summary };
    const parsed = localQuery(input);
    if (!parsed.ok) return parsed;
    ranks.fill(0);
    const query = parsed.value;
    if (
      query.kind === "words" &&
      !query.words.some((word) => surrogate.test(word))
    ) {
      const words = query.words.map((word) => {
        const bytes = encoder.encode(word);
        let anchor = 0;
        for (let index = 1; index < bytes.length; index += 1)
          if (
            (frequencies[bytes[index] ?? 0] ?? 0) <
            (frequencies[bytes[anchor] ?? 0] ?? 0)
          )
            anchor = index;
        return { bytes, anchor };
      });
      const categoryMasks = new Uint8Array(header.categories.length);
      const regionMasks = new Uint8Array(header.regions.length);
      for (const [word, text] of query.words.entries()) {
        const places = wordPlaces(header, text, "with-readings");
        for (const [index, category] of header.categories.entries())
          if (places.categories.includes(category.id))
            categoryMasks[index] = (categoryMasks[index] ?? 0) | (1 << word);
        for (const [index, region] of header.regions.entries())
          if (
            places.prefectures.includes(region.slice(0, 2)) ||
            places.municipalities.includes(region)
          )
            regionMasks[index] = (regionMasks[index] ?? 0) | (1 << word);
      }
      let firstRow = 0;
      const all = (1 << words.length) - 1;
      const hasPlaces =
        categoryMasks.some((mask) => mask !== 0) ||
        regionMasks.some((mask) => mask !== 0);
      for (const block of blocks(files.folded, 0, foldedBytes, scanBuffer)) {
        const bytes = block.bytes;
        let count = 0;
        ends[0] = 0;
        for (let at = 0; at < bytes.length; at += 1)
          if (bytes[at] === lineFeed) ends[++count] = at + 1;
        if (count >= ends.length) fail("Too many search names in a block");
        masks.fill(0, 0, count);
        for (const [wordIndex, pattern] of words.entries()) {
          const word = pattern.bytes;
          const anchorOffset = pattern.anchor;
          const anchor =
            word[anchorOffset] ?? fail("An empty search word was admitted");
          for (let found = bytes.indexOf(anchor, anchorOffset); found >= 0; ) {
            const at = found - anchorOffset;
            if (!containsAt(bytes, word, at)) {
              found = bytes.indexOf(anchor, found + 1);
              continue;
            }
            const local = rowAt(ends, count, at);
            const end = (ends[local + 1] ?? 0) - 1;
            if (at + word.length > end) {
              found = bytes.indexOf(anchor, found + 1);
              continue;
            }
            masks[local] = (masks[local] ?? 0) | (1 << wordIndex);
            singleRanks[local] =
              at === ends[local] ? (word.length === end - at ? 0 : 1) : 2;
            found = bytes.indexOf(anchor, end + 1 + anchorOffset);
          }
        }
        for (let local = 0; local < count; local += 1) {
          const row = firstRow + local;
          const mask = masks[local] ?? 0;
          if (mask === all) {
            ranks[row] = words.length === 1 ? (singleRanks[local] ?? 0) + 1 : 3;
            continue;
          }
          if (!hasPlaces) continue;
          const places =
            (categoryMasks[categories[row] ?? -1] ?? 0) |
            (regionMasks[regionView.getUint16(row * 2, true)] ?? 0);
          if ((mask | places) !== all) continue;
          ranks[row] =
            mask === all
              ? words.length === 1
                ? (singleRanks[local] ?? 0) + 1
                : 3
              : 4;
        }
        firstRow += count;
      }
    } else if (query.kind === "telephone") {
      const word = encoder.encode(query.number);
      let row = 0;
      for (const block of blocks(
        files.raw,
        phonesStart,
        files.raw.getSize(),
        scanBuffer,
      )) {
        let start = 0;
        for (let at = 0; at < block.bytes.length; at += 1) {
          if (block.bytes[at] !== lineFeed) continue;
          const bytes = block.bytes;
          for (let phone = start; phone <= at - word.length; phone += 1) {
            if (
              (phone === start || bytes[phone - 1] === 32) &&
              bytes[phone] === word[0] &&
              containsAt(bytes, word, phone) &&
              (bytes[phone + word.length] === 32 || phone + word.length === at)
            ) {
              ranks[row] = 1;
              break;
            }
          }
          row += 1;
          start = at + 1;
        }
      }
    }
    const groups = header.categories.map((category) => ({
      category: category.id,
      buckets: Array.from(
        { length: rankCount },
        (): Bucket => ({ total: 0, rows: [] }),
      ),
    }));
    let total = 0;
    for (let row = 0; row < contacts; row += 1) {
      const rank = (ranks[row] ?? 0) - 1;
      if (rank < 0) continue;
      const bucket =
        groups[categories[row] ?? -1]?.buckets[rank] ??
        fail("A search rank is outside its category");
      bucket.total += 1;
      total += 1;
      if (bucket.rows.length < localPreviewSize) bucket.rows.push(row);
    }
    const matched = groups.filter((group) =>
      group.buckets.some((bucket) => bucket.total > 0),
    );
    matched.sort((left, right) => {
      const a = left.buckets.findIndex((bucket) => bucket.total > 0);
      const b = right.buckets.findIndex((bucket) => bucket.total > 0);
      const firstA =
        left.buckets[a]?.rows[0] ?? fail("A search group is empty");
      const firstB =
        right.buckets[b]?.rows[0] ?? fail("A search group is empty");
      return groupPrecedes(a, firstA, b, firstB)
        ? -1
        : groupPrecedes(b, firstB, a, firstA)
          ? 1
          : 0;
    });
    const summary: Summary = { groups: matched, total };
    cached = { query: input, summary };
    return { ok: true, value: summary };
  }

  return {
    header,
    retainedBufferBytes:
      categories.byteLength +
      regions.byteLength +
      ranks.byteLength +
      scanBuffer.byteLength +
      ends.byteLength +
      masks.byteLength +
      singleRanks.byteLength +
      frequencies.byteLength +
      nameReader.buffer.byteLength +
      phoneReader.buffer.byteLength +
      namePositions.buffer.byteLength +
      phonePositions.buffer.byteLength,
    search: (input) => {
      const result = matches(input);
      return result.ok
        ? {
            ok: true,
            value: {
              total: result.value.total,
              groups: result.value.groups.map((group) => ({
                category: group.category,
                total: group.buckets.reduce(
                  (sum, bucket) => sum + bucket.total,
                  0,
                ),
                rows: group.buckets
                  .flatMap((bucket) => bucket.rows)
                  .slice(0, localPreviewSize),
              })),
            },
          }
        : result;
    },
    continue: (input, category, visible) => {
      const result = matches(input);
      if (!result.ok) return result;
      const group = result.value.groups.find(
        (item) => item.category === category,
      );
      const total =
        group?.buckets.reduce((sum, bucket) => sum + bucket.total, 0) ?? 0;
      if (!Number.isSafeInteger(visible) || visible < 0 || visible > total)
        return { ok: false, error: "invalid_continuation" };
      const next = nextVisible(visible, total);
      const selected: number[] = [];
      let skip = visible;
      for (
        let rank = 0;
        rank < rankCount && selected.length < next - visible;
        rank += 1
      ) {
        const count = group?.buckets[rank]?.total ?? 0;
        if (skip >= count) {
          skip -= count;
          continue;
        }
        const code = header.categories.findIndex(
          (item) => item.id === category,
        );
        for (
          let row = 0;
          row < contacts && selected.length < next - visible;
          row += 1
        ) {
          if (categories[row] !== code || ranks[row] !== rank + 1) continue;
          if (skip > 0) skip -= 1;
          else selected.push(row);
        }
      }
      return {
        ok: true,
        value: { category, total, visible: next, rows: selected },
      };
    },
    row: (position) => {
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        position >= contacts
      )
        fail("Search row outside snapshot");
      const name = splitNameLine(
        lineFrom(nameReader, namePositions, position),
      ).name;
      const category =
        header.categories[categories[position] ?? -1]?.id ??
        fail("Search category outside snapshot");
      const region =
        header.regions[regionView.getUint16(position * 2, true)] ??
        fail("Search region outside snapshot");
      const without = header.rowsWithoutAddress ?? [];
      let low = 0;
      let high = without.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((without[middle] ?? contacts) < position) low = middle + 1;
        else high = middle;
      }
      return {
        row: position,
        name,
        category,
        region,
        phones: lineFrom(phoneReader, phonePositions, position).split(" "),
        hasAddress: without[low] !== position,
      };
    },
  };
}
