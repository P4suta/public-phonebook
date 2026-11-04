import * as v from "valibot";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "./catalog.ts";
import { compareUtf8 } from "./directory-archive.ts";
import { normalizeName } from "./identity.ts";
import {
  type Catalog,
  CountSchema,
  DigestSchema,
  TextSchema,
} from "./models.ts";

export const searchIndexFile = "search-index.br";
const indexSignature = "public-phonebook-search-index\t1";
const lineTerminator = "\n";
const lineFeedByte = 0x0a;
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
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
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

export function decodeSearchIndex(bytes: Uint8Array): SearchIndex {
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
  const nameLines = textLines(take(parts.names), "name part", contacts);
  const categoryPart = take(parts.categories);
  const regionPart = take(parts.regions);
  const phoneLines = textLines(take(parts.phones), "telephone part", contacts);
  const regionView = new DataView(
    regionPart.buffer,
    regionPart.byteOffset,
    regionPart.byteLength,
  );
  const usedRegions = new Set<number>();
  const rowsWithoutAddress = new Set(header.rowsWithoutAddress);
  let previous: string | undefined;
  const rows = nameLines.map((line, index): SearchIndexRow => {
    const fields = line.split(nameSeparator);
    if (fields.length > nameFieldLimit)
      fail("A search index name line has too many fields");
    const [normalizedName = "", display] = fields;
    if (display === normalizedName)
      fail("A search index name repeats its normalized form");
    const name = display ?? normalizedName;
    checkName(normalizedName, name, previous);
    previous = normalizedName;
    const categoryIndex = categoryPart[index];
    const category =
      (categoryIndex === undefined
        ? undefined
        : header.categories[categoryIndex]) ??
      fail("A search index category index is out of range");
    const regionIndex = regionView.getUint16(
      index * regionWidth,
      regionLittleEndian,
    );
    const region =
      header.regions[regionIndex] ??
      fail("A search index region index is out of range");
    usedRegions.add(regionIndex);
    const phones = (phoneLines[index] ?? "").split(phoneSeparator);
    checkPhones(phones);
    return {
      normalizedName,
      name,
      category: category.id,
      region,
      phones,
      hasAddress: !rowsWithoutAddress.has(index),
    };
  });
  if (usedRegions.size !== header.regions.length)
    fail("Every search index region must be referenced");
  return { header, rows };
}
