import * as v from "valibot";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "./catalog.ts";
import { compareUtf8 } from "./directory-archive.ts";
import { packedMidpoint } from "./forgiving-search-policy.ts";
import { normalizeName } from "./identity.ts";
import {
  type Catalog,
  CountSchema,
  DigestSchema,
  TextSchema,
} from "./models.ts";
import { lazyArray } from "./packed-ranking.ts";
import { searchForm } from "./search-text.ts";

export const searchIndexFile = "search-index.br";
const indexSignature = "public-phonebook-search-index\t1";
const lineTerminator = "\n";
const lineFeedByte = 0x0a;
const spaceByte = 0x20;
const firstDigitByte = 0x30;
const lastDigitByte = 0x39;
const nameSeparator = "\t";
const phoneSeparator = " ";
const reservedCharacters = ["\t", "\n", "\r"];
const nameFieldLimit = 2;
const categoryWidth = 1;
const regionWidth = 2;
const regionLittleEndian = true;
const prefectureCount = 47;
const prefectureCodeWidth = 2;
const countryPrefix = "+81";
const trunkPrefix = "0";
const bytesPerMebibyte = 1_048_576;
const compressedMebibytes = 8;
const loneSurrogate = /\p{Surrogate}/u;
const nationalNumber = /^0[1-9][0-9]{8,9}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const searchIndexLimits = {
  categories: 256,
  municipalities: 8192,
  regions: 65_536,
  rowsWithoutAddress: 65_536,
  compressedBytes: compressedMebibytes * bytesPerMebibyte,
} as const;

const RegionCodeSchema = v.union([
  PrefectureCodeSchema,
  MunicipalityCodeSchema,
]);

export const SearchIndexHeaderSchema = v.strictObject({
  snapshot: DigestSchema,
  contacts: CountSchema,
  categories: v.pipe(
    v.array(v.strictObject({ id: CategorySchema, label: TextSchema })),
    v.maxLength(searchIndexLimits.categories),
  ),
  prefectures: v.pipe(
    v.array(v.strictObject({ code: PrefectureCodeSchema, name: TextSchema })),
    v.length(prefectureCount),
  ),
  municipalities: v.pipe(
    v.array(
      v.strictObject({
        code: MunicipalityCodeSchema,
        prefectureCode: PrefectureCodeSchema,
        name: TextSchema,
      }),
    ),
    v.maxLength(searchIndexLimits.municipalities),
  ),
  regions: v.pipe(
    v.array(RegionCodeSchema),
    v.maxLength(searchIndexLimits.regions),
  ),
  /** The ascending positions of rows whose details show no address; an older header without it marks every row as having one. */
  rowsWithoutAddress: v.optional(
    v.pipe(
      v.array(CountSchema),
      v.maxLength(searchIndexLimits.rowsWithoutAddress),
    ),
  ),
  parts: v.strictObject({
    names: CountSchema,
    categories: CountSchema,
    regions: CountSchema,
    phones: CountSchema,
  }),
});
export type SearchIndexHeader = v.InferOutput<typeof SearchIndexHeaderSchema>;

export interface SearchIndexRow {
  readonly normalizedName: string;
  /** The comparison form that search matches, which the index derives from the name instead of storing. */
  readonly searchName: string;
  readonly name: string;
  readonly category: string;
  readonly region: string;
  readonly phones: readonly string[];
  readonly hasAddress: boolean;
}

export interface SearchIndexContact {
  readonly name: string;
  readonly category: string;
  readonly prefectureCode: string;
  readonly municipalityCode: string | null;
  readonly phones: readonly { readonly e164: string }[];
  readonly hasAddress: boolean;
}

export interface SearchIndexInput {
  readonly snapshot: string;
  readonly catalog: Pick<
    Catalog,
    "categories" | "prefectures" | "municipalities"
  >;
}

export interface SearchIndex {
  readonly header: SearchIndexHeader;
  readonly rows: readonly SearchIndexRow[];
  readonly columns?: SearchIndexColumns;
  readonly telephoneRows?: (number: string) => readonly number[];
  readonly nameAt?: (row: number) => string;
  readonly placeAt?: (row: number) => Pick<SearchIndexRow, "name" | "region">;
}

export interface SearchIndexColumns {
  readonly comparisonNames: readonly string[];
  readonly categoryAt: (row: number) => string;
  readonly regionAt: (row: number) => string;
}

export interface RowKey {
  readonly normalizedName: string;
  readonly id: string;
}

function fail(message: string): never {
  throw new Error(message);
}

export function compareRowOrder(left: RowKey, right: RowKey): number {
  return (
    compareUtf8(left.normalizedName, right.normalizedName) ||
    compareUtf8(left.id, right.id)
  );
}

export function searchIndexRow(
  contact: SearchIndexContact,
  normalizedName: string = normalizeName(contact.name),
): SearchIndexRow {
  return {
    normalizedName,
    searchName: searchForm(contact.name),
    name: contact.name,
    category: contact.category,
    region: contact.municipalityCode ?? contact.prefectureCode,
    phones: contact.phones.map((phone) =>
      phone.e164.startsWith(countryPrefix)
        ? `${trunkPrefix}${phone.e164.slice(countryPrefix.length)}`
        : fail("A search index telephone isn't a Japanese number"),
    ),
    hasAddress: contact.hasAddress,
  };
}

function carriedText(value: string): boolean {
  return (
    !reservedCharacters.some((character) => value.includes(character)) &&
    !loneSurrogate.test(value)
  );
}

function checkName(
  normalizedName: string,
  name: string,
  previous: string | undefined,
): void {
  if (!carriedText(normalizedName) || !carriedText(name))
    fail("A search index name contains a reserved character");
  if (normalizedName === "" || normalizeName(name) !== normalizedName)
    fail("A search index name must be the normalized form of its display name");
  if (previous !== undefined && compareUtf8(previous, normalizedName) > 0)
    fail("Search index rows must follow normalized name order");
}

function checkPhones(phones: readonly string[]): void {
  if (
    phones.length === 0 ||
    new Set(phones).size !== phones.length ||
    !phones.every((phone) => nationalNumber.test(phone))
  )
    fail("A search index row needs distinct national telephone numbers");
}

function checkAscending(items: readonly string[], label: string): void {
  for (const [index, item] of items.entries()) {
    const previous = items[index - 1];
    if (previous !== undefined && compareUtf8(previous, item) >= 0)
      fail(`Search index ${label} must be unique and ascending`);
  }
}

function checkHeader(header: SearchIndexHeader): void {
  if (
    new Set(header.categories.map((category) => category.id)).size !==
    header.categories.length
  )
    fail("Search index categories must be unique");
  for (const [index, prefecture] of header.prefectures.entries())
    if (
      prefecture.code !== String(index + 1).padStart(prefectureCodeWidth, "0")
    )
      fail("Search index prefectures must follow code order");
  for (const municipality of header.municipalities)
    if (!municipality.code.startsWith(municipality.prefectureCode))
      fail("A search index municipality has a conflicting prefecture");
  checkAscending(
    header.municipalities.map((municipality) => municipality.code),
    "municipalities",
  );
  checkAscending(header.regions, "regions");
  const withoutAddress = header.rowsWithoutAddress ?? [];
  for (const [index, position] of withoutAddress.entries()) {
    const previous = withoutAddress[index - 1];
    if (
      position >= header.contacts ||
      (previous !== undefined && previous >= position)
    )
      fail(
        "Search index rows without an address must be unique, ascending row positions",
      );
  }
}

function lines(items: readonly string[]): string {
  return items.map((item) => `${item}${lineTerminator}`).join("");
}

export function encodeSearchIndex(
  rows: Iterable<SearchIndexRow>,
  input: SearchIndexInput,
): Uint8Array {
  const categoryIndexes = new Map<string, number>(
    input.catalog.categories.map((category, index) => [category.id, index]),
  );
  const names: string[] = [];
  const phones: string[] = [];
  const categories: number[] = [];
  const regions: string[] = [];
  const rowsWithoutAddress: number[] = [];
  let previous: string | undefined;
  for (const row of rows) {
    checkName(row.normalizedName, row.name, previous);
    previous = row.normalizedName;
    if (!row.hasAddress) rowsWithoutAddress.push(names.length);
    if (!v.is(RegionCodeSchema, row.region))
      fail("A search index region isn't a region code");
    checkPhones(row.phones);
    categories.push(
      categoryIndexes.get(row.category) ??
        fail(`Unknown search index category: ${row.category}`),
    );
    regions.push(row.region);
    names.push(
      row.name === row.normalizedName
        ? row.normalizedName
        : `${row.normalizedName}${nameSeparator}${row.name}`,
    );
    phones.push(row.phones.join(phoneSeparator));
  }
  const regionList = Array.from(new Set(regions)).sort(compareUtf8);
  if (regionList.length > searchIndexLimits.regions)
    fail("The search index region list exceeds its limit");
  const regionIndexes = new Map(regionList.map((code, index) => [code, index]));
  const encoder = new TextEncoder();
  const namePart = encoder.encode(lines(names));
  const phonePart = encoder.encode(lines(phones));
  const categoryPart = Uint8Array.from(categories);
  const regionPart = new Uint8Array(regions.length * regionWidth);
  const regionView = new DataView(regionPart.buffer);
  for (const [index, code] of regions.entries())
    regionView.setUint16(
      index * regionWidth,
      regionIndexes.get(code) ?? fail("A search index region is missing"),
      regionLittleEndian,
    );
  const header = v.parse(SearchIndexHeaderSchema, {
    snapshot: input.snapshot,
    contacts: names.length,
    categories: input.catalog.categories.map((category) => ({
      id: category.id,
      label: category.label,
    })),
    prefectures: input.catalog.prefectures.map((prefecture) => ({
      code: prefecture.code,
      name: prefecture.name,
    })),
    municipalities: input.catalog.municipalities.map((municipality) => ({
      code: municipality.code,
      prefectureCode: municipality.prefectureCode,
      name: municipality.name,
    })),
    regions: regionList,
    rowsWithoutAddress,
    parts: {
      names: namePart.byteLength,
      categories: categoryPart.byteLength,
      regions: regionPart.byteLength,
      phones: phonePart.byteLength,
    },
  });
  checkHeader(header);
  const prefix = encoder.encode(
    lines([indexSignature, JSON.stringify(header)]),
  );
  const parts = [prefix, namePart, categoryPart, regionPart, phonePart];
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function utf8(bytes: Uint8Array, label: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new Error(`The search index ${label} isn't UTF-8`, { cause: error });
  }
}

function textLines(bytes: Uint8Array, label: string, count: number): string[] {
  const text = utf8(bytes, label);
  if (count === 0) {
    if (text !== "") fail(`The search index ${label} has extra lines`);
    return [];
  }
  if (!text.endsWith(lineTerminator))
    fail(`The search index ${label} must end with a line feed`);
  const result = text.slice(0, -lineTerminator.length).split(lineTerminator);
  if (result.length !== count)
    fail(`The search index ${label} differs from its contact count`);
  return result;
}

const signatureLine = new TextEncoder().encode(
  `${indexSignature}${lineTerminator}`,
);

export function hasSearchIndexSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= signatureLine.byteLength &&
    signatureLine.every((byte, index) => bytes[index] === byte)
  );
}

export function decodeLiteralSearchIndex(bytes: Uint8Array): SearchIndex {
  return decodeIndex(bytes, "columns");
}

export function decodeSearchIndex(
  bytes: Uint8Array,
  lazy = false,
): SearchIndex {
  return decodeIndex(bytes, lazy ? "views" : "rows");
}

type IndexStorage = "rows" | "views" | "columns";

function decodeIndex(bytes: Uint8Array, storage: IndexStorage): SearchIndex {
  const lazy = storage !== "rows";
  const signature = signatureLine;
  if (!hasSearchIndexSignature(bytes)) fail("Unsupported search index format");
  const headerEnd = bytes.indexOf(lineFeedByte, signature.byteLength);
  if (headerEnd < 0) fail("A search index needs a header");
  const decoded: unknown = JSON.parse(
    utf8(bytes.subarray(signature.byteLength, headerEnd), "header"),
  );
  const header = v.parse(SearchIndexHeaderSchema, decoded);
  checkHeader(header);
  const { contacts, parts } = header;
  if (
    parts.categories !== contacts * categoryWidth ||
    parts.regions !== contacts * regionWidth
  )
    fail("The search index part lengths differ from its contact count");
  let offset = headerEnd + lineTerminator.length;
  if (
    bytes.byteLength - offset !==
    parts.names + parts.categories + parts.regions + parts.phones
  )
    fail("The search index length differs from its header");
  function take(length: number): Uint8Array {
    const part = bytes.subarray(offset, offset + length);
    offset += length;
    return part;
  }
  let phoneOffsets: Uint32Array | null = null;
  function viewedLines(part: Uint8Array, label: string): readonly string[] {
    if (!lazy) return textLines(part, label, contacts);
    if (contacts === 0 && part.length !== 0)
      fail(`The search index ${label} has extra lines`);
    if (contacts > 0 && part.at(-1) !== lineFeedByte)
      fail(`The search index ${label} must end with a line feed`);
    const offsets = new Uint32Array(contacts + 1);
    let row = 0;
    const telephone = label === "telephone part";
    for (let at = 0; at < part.length; at += 1) {
      const byte = part[at] ?? -1;
      if (
        telephone &&
        storage === "views" &&
        byte !== lineFeedByte &&
        byte !== spaceByte &&
        (byte < firstDigitByte || byte > lastDigitByte)
      )
        fail("Search telephone bytes must be ASCII digits and separators");
      if (part[at] !== lineFeedByte) continue;
      row += 1;
      if (row > contacts)
        fail(`The search index ${label} differs from its contact count`);
      offsets[row] = at + 1;
    }
    if (row !== contacts || offsets[row] !== part.length)
      fail(`The search index ${label} differs from its contact count`);
    if (telephone) phoneOffsets = offsets;
    return lazyArray(contacts, (position) =>
      utf8(
        part.subarray(offsets[position] ?? 0, (offsets[position + 1] ?? 0) - 1),
        label,
      ),
    );
  }
  const nameLines = viewedLines(take(parts.names), "name part");
  const categoryPart = take(parts.categories);
  const regionPart = take(parts.regions);
  const phonePart = take(parts.phones);
  const phoneLines = viewedLines(phonePart, "telephone part");
  const regionView = new DataView(
    regionPart.buffer,
    regionPart.byteOffset,
    regionPart.byteLength,
  );
  const usedRegions = new Set<number>();
  const rowsWithoutAddress = new Set(header.rowsWithoutAddress);
  const categoryAt = (row: number): string =>
    header.categories[categoryPart[row] ?? -1]?.id ??
    fail("A search index category index is out of range");
  const regionAt = (row: number): string =>
    header.regions[
      regionView.getUint16(row * regionWidth, regionLittleEndian)
    ] ?? fail("A search index region index is out of range");
  const readRow = (
    line: string,
    index: number,
    previous?: string,
  ): SearchIndexRow => {
    const fields = line.split(nameSeparator);
    if (fields.length > nameFieldLimit)
      fail("A search index name line has too many fields");
    const [normalizedName = "", display] = fields;
    if (display === normalizedName)
      fail("A search index name repeats its normalized form");
    const name = display ?? normalizedName;
    checkName(normalizedName, name, previous);
    const category = categoryAt(index);
    const regionIndex = regionView.getUint16(
      index * regionWidth,
      regionLittleEndian,
    );
    const region = regionAt(index);
    usedRegions.add(regionIndex);
    const phones = (phoneLines[index] ?? "").split(phoneSeparator);
    checkPhones(phones);
    return {
      normalizedName,
      searchName: searchForm(name),
      name,
      category,
      region,
      phones,
      hasAddress: !rowsWithoutAddress.has(index),
    };
  };
  const comparisonNames: string[] = [];
  let previous: string | undefined;
  if (storage === "columns") {
    for (let row = 0; row < contacts; row += 1) {
      const validated = readRow(nameLines[row] ?? "", row, previous);
      previous = validated.normalizedName;
      comparisonNames.push(validated.searchName);
    }
  } else if (lazy) {
    for (let row = 0; row < contacts; row += 1) {
      const category = categoryPart[row];
      const region = regionView.getUint16(
        row * regionWidth,
        regionLittleEndian,
      );
      if (
        category === undefined ||
        !header.categories[category] ||
        !header.regions[region]
      )
        fail("Search index row reference out of range");
      usedRegions.add(region);
    }
  }
  const rows = lazy
    ? lazyArray(contacts, (position) =>
        readRow(nameLines[position] ?? "", position),
      )
    : nameLines.map((line, row) => {
        const validated = readRow(line, row, previous);
        previous = validated.normalizedName;
        return validated;
      });
  if (usedRegions.size !== header.regions.length)
    fail("Every search index region must be referenced");
  let phoneText: string | undefined;
  const telephoneRows = (number: string): readonly number[] => {
    if (!nationalNumber.test(number)) return [];
    const offsets =
      phoneOffsets ?? fail("Search telephone offsets are missing");
    phoneText ??= utf8(phonePart, "telephone part");
    const result: number[] = [];
    let position = phoneText.indexOf(number);
    while (position >= 0) {
      const before =
        position === 0 ? lineFeedByte : phoneText.charCodeAt(position - 1);
      const after = phoneText.charCodeAt(position + number.length);
      if (
        (before === lineFeedByte || before === spaceByte) &&
        (after === lineFeedByte || after === spaceByte)
      ) {
        let low = 0;
        let high = contacts;
        while (low < high) {
          const middle = packedMidpoint(low, high);
          if ((offsets[middle + 1] ?? 0) <= position) low = middle + 1;
          else high = middle;
        }
        if (result.at(-1) !== low) result.push(low);
      }
      position = phoneText.indexOf(number, position + 1);
    }
    return result;
  };
  const nameAt = (row: number): string => {
    const line = nameLines[row];
    if (line === undefined) fail("Search name outside snapshot");
    return line.slice(line.indexOf(nameSeparator) + 1);
  };
  const placeAt = (row: number): Pick<SearchIndexRow, "name" | "region"> => ({
    name: nameAt(row),
    region: regionAt(row),
  });
  return storage === "columns"
    ? {
        header,
        rows,
        telephoneRows,
        nameAt,
        placeAt,
        columns: { comparisonNames, categoryAt, regionAt },
      }
    : lazy
      ? { header, rows, telephoneRows, nameAt, placeAt }
      : { header, rows };
}
