import * as v from "valibot";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "./catalog.ts";
import {
  type Catalog,
  ContactSchema,
  CountSchema,
  DigestSchema,
  PublicUrlSchema,
  type Source,
  TextSchema,
} from "./models.ts";

export const directoryArchiveFile = "directory.tsv.br";
const archiveSignature = "public-phonebook-directory\t1";
/** The format that the dataset listing declares for the archive, which line 1 spells with a TAB for the slash. */
export const directoryArchiveFormat = archiveSignature.replace("\t", "/");
const fieldSeparator = "\t";
const lineTerminator = "\n";
const listSeparator = "\u001f";
const pairSeparator = "\u001e";
const reservedCharacters = ["\t", "\n", "\r", listSeparator, pairSeparator];
const confirmedWithoutLink = "*";
const rowFieldCount = 9;
const telephoneParts = 2;
const prefectureCount = 47;
const prefectureCodeWidth = 2;
const municipalityCodeWidth = 5;
const countryPrefix = "+81";
const trunkPrefix = "0";
const surrogateStart = 0xd800;
const surrogateEnd = 0xe000;
const surrogateLift = 0x2000;
const upperPlaneShift = 0x800;
const loneSurrogate = /\p{Surrogate}/u;
const decimalIndex = /^(?:0|[1-9][0-9]{0,8})$/u;
const regionCode = /^(?:[0-9]{2}|[0-9]{5})$/u;
const nationalNumber = /^0[1-9][0-9]{8,9}$/u;
const nonDigits = /[^0-9]/gu;

export const directoryArchiveLimits = {
  categories: 256,
  municipalities: 8192,
  sources: 16384,
  provenances: 65536,
  links: 65536,
} as const;

export const DirectoryArchiveContactSchema = v.omit(ContactSchema, [
  "id",
  "sourceRecordId",
]);
export type DirectoryArchiveContact = v.InferOutput<
  typeof DirectoryArchiveContactSchema
>;
type Phone = DirectoryArchiveContact["phones"][number];

const IndexSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const ProvenanceSchema = v.strictObject({
  source: IndexSchema,
  license: TextSchema,
  licenseUrl: PublicUrlSchema,
  dataAsOf: v.string(),
  retrievedAt: TextSchema,
});
type Provenance = v.InferOutput<typeof ProvenanceSchema>;

export const DirectoryArchiveHeaderSchema = v.strictObject({
  snapshot: DigestSchema,
  generatedAt: TextSchema,
  contacts: CountSchema,
  categories: v.pipe(
    v.array(
      v.strictObject({
        id: CategorySchema,
        label: TextSchema,
        publisher: TextSchema,
        license: TextSchema,
        licenseUrl: PublicUrlSchema,
      }),
    ),
    v.maxLength(directoryArchiveLimits.categories),
  ),
  prefectures: v.pipe(
    v.array(
      v.strictObject({
        code: PrefectureCodeSchema,
        name: TextSchema,
        contacts: CountSchema,
      }),
    ),
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
    v.maxLength(directoryArchiveLimits.municipalities),
  ),
  sources: v.pipe(
    v.array(
      v.strictObject({
        id: TextSchema,
        url: PublicUrlSchema,
        publisher: v.optional(TextSchema),
        title: v.optional(TextSchema),
      }),
    ),
    v.maxLength(directoryArchiveLimits.sources),
  ),
  provenances: v.pipe(
    v.array(ProvenanceSchema),
    v.maxLength(directoryArchiveLimits.provenances),
  ),
  links: v.pipe(
    v.array(PublicUrlSchema),
    v.maxLength(directoryArchiveLimits.links),
  ),
});
export type DirectoryArchiveHeader = v.InferOutput<
  typeof DirectoryArchiveHeaderSchema
>;

export type DirectoryArchiveSource = Pick<
  Source,
  "id" | "url" | "publisher" | "title"
>;

export interface DirectoryArchiveInput {
  readonly snapshot: string;
  readonly catalog: Pick<
    Catalog,
    "generatedAt" | "categories" | "prefectures" | "municipalities"
  >;
  readonly sources: readonly DirectoryArchiveSource[];
}

export interface DirectoryArchiveEncoder {
  readonly add: (contact: DirectoryArchiveContact) => void;
  readonly finish: (input: DirectoryArchiveInput) => string;
}

export interface DirectoryArchive {
  readonly header: DirectoryArchiveHeader;
  readonly rows: readonly DirectoryArchiveContact[];
}

interface PendingRow {
  readonly category: string;
  readonly prefectureCode: string;
  readonly region: string;
  readonly text: string;
  readonly provenance: number;
  readonly origin: readonly number[];
  readonly confirmed: boolean;
  readonly confirmationLink: number | null;
}

interface PendingProvenance {
  readonly sourceId: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly dataAsOf: string;
  readonly retrievedAt: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function codeUnitRank(unit: number): number {
  if (unit >= surrogateEnd) return unit - upperPlaneShift;
  if (unit >= surrogateStart) return unit + surrogateLift;
  return unit;
}

export function compareUtf8(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftUnit = left.charCodeAt(index);
    const rightUnit = right.charCodeAt(index);
    if (leftUnit !== rightUnit)
      return codeUnitRank(leftUnit) - codeUnitRank(rightUnit);
  }
  return left.length - right.length;
}

function compareProvenance(left: Provenance, right: Provenance): number {
  return (
    left.source - right.source ||
    compareUtf8(left.license, right.license) ||
    compareUtf8(left.licenseUrl, right.licenseUrl) ||
    compareUtf8(left.dataAsOf, right.dataAsOf) ||
    compareUtf8(left.retrievedAt, right.retrievedAt)
  );
}

function carriedText(value: string): boolean {
  return (
    !reservedCharacters.some((character) => value.includes(character)) &&
    !loneSurrogate.test(value)
  );
}

function asciiDigits(value: string): string {
  return value.replace(nonDigits, "");
}

function phoneEntry(phone: Phone): string {
  const national = `${trunkPrefix}${phone.e164.slice(countryPrefix.length)}`;
  return asciiDigits(phone.display) === national
    ? phone.display
    : `${national}${pairSeparator}${phone.display}`;
}

function prefectureCode(index: number): string {
  return String(index + 1).padStart(prefectureCodeWidth, "0");
}

function ranks(order: readonly { readonly pending: number }[]): Uint32Array {
  const result = new Uint32Array(order.length);
  for (const [rank, item] of order.entries()) result[item.pending] = rank;
  return result;
}

function rank(ranking: Uint32Array, pending: number): string {
  const value = ranking[pending];
  if (value === undefined) fail("A directory archive index is missing");
  return String(value);
}

export function directoryArchiveEncoder(): DirectoryArchiveEncoder {
  const rows: PendingRow[] = [];
  const provenances: PendingProvenance[] = [];
  const provenanceIds = new Map<string, number>();
  const links: string[] = [];
  const linkIds = new Map<string, number>();

  function link(url: string): number {
    const known = linkIds.get(url);
    if (known !== undefined) return known;
    if (links.length >= directoryArchiveLimits.links)
      fail("The directory archive link dictionary exceeds its limit");
    linkIds.set(url, links.length);
    links.push(url);
    return links.length - 1;
  }

  function provenance(contact: DirectoryArchiveContact): number {
    const value = {
      sourceId: contact.sourceId,
      license: contact.license,
      licenseUrl: contact.licenseUrl,
      dataAsOf: contact.dataAsOf,
      retrievedAt: contact.retrievedAt,
    };
    const key = JSON.stringify(Object.values(value));
    const known = provenanceIds.get(key);
    if (known !== undefined) return known;
    if (provenances.length >= directoryArchiveLimits.provenances)
      fail("The directory archive provenance dictionary exceeds its limit");
    provenanceIds.set(key, provenances.length);
    provenances.push(value);
    return provenances.length - 1;
  }

  function add(contact: DirectoryArchiveContact): void {
    const texts = [
      contact.name,
      contact.address,
      contact.website ?? "",
      contact.sourceId,
      contact.license,
      contact.licenseUrl,
      contact.dataAsOf,
      contact.retrievedAt,
      contact.phoneConfirmationUrl ?? "",
      ...contact.sourceUrls,
      ...contact.phones.map((phone) => phone.display),
    ];
    if (!texts.every(carriedText))
      fail("A directory archive field contains a reserved character");
    if (contact.phones.length === 0 || contact.sourceUrls.length === 0)
      fail("A directory archive contact needs a telephone and an origin");
    if (
      contact.municipalityCode !== null &&
      !contact.municipalityCode.startsWith(contact.prefectureCode)
    )
      fail("A directory archive contact has a conflicting region");
    if (!contact.phoneConfirmed && contact.phoneConfirmationUrl !== null)
      fail("A directory archive confirmation link needs a confirmed telephone");
    rows.push({
      category: contact.category,
      prefectureCode: contact.prefectureCode,
      region: contact.municipalityCode ?? contact.prefectureCode,
      text: [
        contact.name,
        contact.address,
        contact.phones.map(phoneEntry).join(listSeparator),
        contact.website ?? "",
      ].join(fieldSeparator),
      provenance: provenance(contact),
      origin: contact.sourceUrls.map(link),
      confirmed: contact.phoneConfirmed,
      confirmationLink:
        contact.phoneConfirmationUrl === null
          ? null
          : link(contact.phoneConfirmationUrl),
    });
  }

  function finish(input: DirectoryArchiveInput): string {
    const categoryIndexes = new Map<string, number>(
      input.catalog.categories.map((category, index) => [category.id, index]),
    );
    const knownSources = new Map(
      input.sources.map((source) => [source.id, source]),
    );
    const sourceIds = Array.from(
      new Set(provenances.map((item) => item.sourceId)),
    ).sort(compareUtf8);
    const sourceIndexes = new Map(sourceIds.map((id, index) => [id, index]));
    const sources = sourceIds.map((id) => {
      const source = knownSources.get(id);
      if (!source) fail(`Unknown directory archive source: ${id}`);
      return {
        id: source.id,
        url: source.url,
        ...(source.publisher === undefined
          ? {}
          : { publisher: source.publisher }),
        ...(source.title === undefined ? {} : { title: source.title }),
      };
    });
    const provenanceOrder = provenances
      .map((item, pending) => ({
        pending,
        value: {
          source:
            sourceIndexes.get(item.sourceId) ??
            fail(`Unknown directory archive source: ${item.sourceId}`),
          license: item.license,
          licenseUrl: item.licenseUrl,
          dataAsOf: item.dataAsOf,
          retrievedAt: item.retrievedAt,
        },
      }))
      .sort((left, right) => compareProvenance(left.value, right.value));
    const linkOrder = links
      .map((url, pending) => ({ pending, url }))
      .sort((left, right) => compareUtf8(left.url, right.url));
    const provenanceRanks = ranks(provenanceOrder);
    const linkRanks = ranks(linkOrder);
    const prefectureCounts = new Map<string, number>();
    const lines = rows.map((row) => {
      const category =
        categoryIndexes.get(row.category) ??
        fail(`Unknown directory archive category: ${row.category}`);
      prefectureCounts.set(
        row.prefectureCode,
        (prefectureCounts.get(row.prefectureCode) ?? 0) + 1,
      );
      const confirmation = !row.confirmed
        ? ""
        : row.confirmationLink === null
          ? confirmedWithoutLink
          : rank(linkRanks, row.confirmationLink);
      return [
        String(category),
        row.region,
        row.text,
        rank(provenanceRanks, row.provenance),
        row.origin.map((item) => rank(linkRanks, item)).join(listSeparator),
        confirmation,
      ].join(fieldSeparator);
    });
    lines.sort(compareUtf8);
    for (const prefecture of input.catalog.prefectures)
      if ((prefectureCounts.get(prefecture.code) ?? 0) !== prefecture.contacts)
        fail(`Directory archive prefecture count mismatch: ${prefecture.code}`);
    const header = v.parse(DirectoryArchiveHeaderSchema, {
      snapshot: input.snapshot,
      generatedAt: input.catalog.generatedAt,
      contacts: lines.length,
      categories: input.catalog.categories.map((category) => ({
        id: category.id,
        label: category.label,
        publisher: category.publisher,
        license: category.license,
        licenseUrl: category.licenseUrl,
      })),
      prefectures: input.catalog.prefectures.map((prefecture) => ({
        code: prefecture.code,
        name: prefecture.name,
        contacts: prefecture.contacts,
      })),
      municipalities: input.catalog.municipalities.map((municipality) => ({
        code: municipality.code,
        prefectureCode: municipality.prefectureCode,
        name: municipality.name,
      })),
      sources,
      provenances: provenanceOrder.map((item) => item.value),
      links: linkOrder.map((item) => item.url),
    });
    checkHeader(header);
    return `${[archiveSignature, JSON.stringify(header), ...lines].join(lineTerminator)}${lineTerminator}`;
  }

  return { add, finish };
}

export function encodeDirectoryArchive(
  contacts: Iterable<DirectoryArchiveContact>,
  input: DirectoryArchiveInput,
): string {
  const encoder = directoryArchiveEncoder();
  for (const contact of contacts) encoder.add(contact);
  return encoder.finish(input);
}

function checkAscending<T>(
  items: readonly T[],
  compare: (left: T, right: T) => number,
  label: string,
): void {
  for (const [index, item] of items.entries()) {
    const previous = items[index - 1];
    if (index > 0 && previous !== undefined && compare(previous, item) >= 0)
      fail(`Directory archive ${label} must be unique and ascending`);
  }
}

function checkHeader(header: DirectoryArchiveHeader): void {
  if (
    new Set(header.categories.map((category) => category.id)).size !==
    header.categories.length
  )
    fail("Directory archive categories must be unique");
  for (const [index, prefecture] of header.prefectures.entries())
    if (prefecture.code !== prefectureCode(index))
      fail("Directory archive prefectures must follow code order");
  const municipalities = new Set<string>();
  for (const municipality of header.municipalities) {
    if (
      !municipality.code.startsWith(municipality.prefectureCode) ||
      municipalities.has(municipality.code)
    )
      fail("Directory archive municipalities must be unique and regional");
    municipalities.add(municipality.code);
  }
  checkAscending(
    header.sources.map((source) => source.id),
    compareUtf8,
    "sources",
  );
  const referencedSources = new Set<number>();
  for (const provenance of header.provenances) {
    if (provenance.source >= header.sources.length)
      fail("A directory archive provenance names an unknown source");
    referencedSources.add(provenance.source);
  }
  if (referencedSources.size !== header.sources.length)
    fail("Every directory archive source must have a provenance");
  checkAscending(header.provenances, compareProvenance, "provenances");
  checkAscending(header.links, compareUtf8, "links");
}

function entry<T>(
  items: readonly T[],
  text: string,
  label: string,
): readonly [number, T] {
  if (!decimalIndex.test(text))
    fail(`A directory archive ${label} index is not canonical`);
  const index = Number(text);
  const value = items[index];
  if (value === undefined)
    fail(`A directory archive ${label} index is out of range`);
  return [index, value];
}

function decodePhone(text: string): Phone {
  const parts = text.split(pairSeparator);
  const [first = "", second] = parts;
  if (parts.length > telephoneParts)
    fail("A directory archive telephone has too many parts");
  if (second !== undefined && asciiDigits(second) === first)
    fail("A directory archive telephone repeats its spelling");
  const national = second === undefined ? asciiDigits(first) : first;
  if (!nationalNumber.test(national))
    fail("A directory archive telephone has no national number");
  return {
    display: second ?? first,
    e164: `${countryPrefix}${national.slice(trunkPrefix.length)}`,
  };
}

export function decodeDirectoryArchive(text: string): DirectoryArchive {
  if (!text.endsWith(lineTerminator))
    fail("A directory archive must end with a line feed");
  const [signature, headerLine, ...lines] = text
    .slice(0, -lineTerminator.length)
    .split(lineTerminator);
  if (signature !== archiveSignature)
    fail("Unsupported directory archive format");
  if (headerLine === undefined) fail("A directory archive needs a header");
  const decoded: unknown = JSON.parse(headerLine);
  const header = v.parse(DirectoryArchiveHeaderSchema, decoded);
  checkHeader(header);
  if (header.contacts !== lines.length)
    fail("The directory archive contact count differs from its rows");
  const usedProvenances = new Set<number>();
  const usedLinks = new Set<number>();
  const prefectureCounts = new Map<string, number>();
  const rows = lines.map((line, index) => {
    const previous = lines[index - 1];
    if (previous !== undefined && compareUtf8(previous, line) > 0)
      fail("Directory archive rows must be sorted");
    const fields = line.split(fieldSeparator);
    if (fields.length !== rowFieldCount)
      fail("A directory archive row must have nine fields");
    const [
      categoryText = "",
      region = "",
      name = "",
      address = "",
      phonesText = "",
      website = "",
      provenanceText = "",
      originText = "",
      confirmation = "",
    ] = fields;
    if (![name, address, website].every(carriedText))
      fail("A directory archive field contains a reserved character");
    if (!regionCode.test(region))
      fail("A directory archive region is not a code");
    const prefecture = region.slice(0, prefectureCodeWidth);
    prefectureCounts.set(
      prefecture,
      (prefectureCounts.get(prefecture) ?? 0) + 1,
    );
    const [, category] = entry(header.categories, categoryText, "category");
    const [provenanceIndex, provenance] = entry(
      header.provenances,
      provenanceText,
      "provenance",
    );
    usedProvenances.add(provenanceIndex);
    const [, source] = entry(
      header.sources,
      String(provenance.source),
      "source",
    );
    const sourceUrls = originText.split(listSeparator).map((item) => {
      const [linkIndex, url] = entry(header.links, item, "origin");
      usedLinks.add(linkIndex);
      return url;
    });
    let phoneConfirmationUrl: string | null = null;
    if (confirmation !== "" && confirmation !== confirmedWithoutLink) {
      const [linkIndex, url] = entry(
        header.links,
        confirmation,
        "confirmation",
      );
      usedLinks.add(linkIndex);
      phoneConfirmationUrl = url;
    }
    return v.parse(DirectoryArchiveContactSchema, {
      name,
      category: category.id,
      prefectureCode: prefecture,
      municipalityCode: region.length === municipalityCodeWidth ? region : null,
      address,
      phones: phonesText.split(listSeparator).map(decodePhone),
      website: website === "" ? null : website,
      sourceId: source.id,
      sourceUrls,
      license: provenance.license,
      licenseUrl: provenance.licenseUrl,
      dataAsOf: provenance.dataAsOf,
      retrievedAt: provenance.retrievedAt,
      phoneConfirmed: confirmation !== "",
      phoneConfirmationUrl,
    });
  });
  for (const prefecture of header.prefectures)
    if ((prefectureCounts.get(prefecture.code) ?? 0) !== prefecture.contacts)
      fail(`Directory archive prefecture count mismatch: ${prefecture.code}`);
  if (
    usedProvenances.size !== header.provenances.length ||
    usedLinks.size !== header.links.length
  )
    fail("Every directory archive dictionary entry must be referenced");
  return { header, rows };
}
