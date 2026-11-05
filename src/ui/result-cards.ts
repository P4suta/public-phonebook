import type { Category } from "../core/catalog.ts";
import type { LocalRow } from "../core/local-search-protocol.ts";
import type { Contact } from "../core/models.ts";
import { showsAddress } from "../core/search.ts";

const countryPrefix = "+81";
const trunkPrefixLength = 1;
const prefectureCodeWidth = 2;

export interface RegionNames {
  readonly prefectures: ReadonlyMap<string, string>;
  readonly municipalities: ReadonlyMap<
    string,
    { readonly prefectureCode: string; readonly name: string }
  >;
}

/** A result card's content, whether the server or the device found it. */
export interface ResultCardView {
  readonly key: string;
  readonly name: string;
  readonly category: Category;
  readonly region: string;
  readonly phones: readonly string[];
  /** Whether the detail page shows an address, which names the card's detail action. */
  readonly hasAddress: boolean;
  readonly href: string;
  readonly row: { readonly snapshot: string; readonly row: number } | null;
}

export interface RegionLists {
  readonly prefectures: readonly {
    readonly code: string;
    readonly name: string;
  }[];
  readonly municipalities: readonly {
    readonly code: string;
    readonly prefectureCode: string;
    readonly name: string;
  }[];
}

/** Indexes the catalog's or the search index header's region names by code. */
export function catalogRegions(catalog: RegionLists): RegionNames {
  return {
    prefectures: new Map(
      catalog.prefectures.map((prefecture) => [
        prefecture.code,
        prefecture.name,
      ]),
    ),
    municipalities: new Map(
      catalog.municipalities.map((municipality) => [
        municipality.code,
        {
          prefectureCode: municipality.prefectureCode,
          name: municipality.name,
        },
      ]),
    ),
  };
}

/** Names a prefecture code, or a municipality code with its prefecture, as one place name. */
export function regionLabel(code: string, names: RegionNames): string {
  const municipality = names.municipalities.get(code);
  const prefecture = names.prefectures.get(
    municipality?.prefectureCode ?? code.slice(0, prefectureCodeWidth),
  );
  return `${prefecture ?? ""}${municipality?.name ?? ""}`;
}

export function serverCard(
  contact: Contact,
  names: RegionNames,
  returnTo: string,
): ResultCardView {
  return {
    key: contact.id,
    name: contact.name,
    category: contact.category,
    region: regionLabel(
      contact.municipalityCode ?? contact.prefectureCode,
      names,
    ),
    phones: contact.phones.map((phone) => phone.e164),
    hasAddress: showsAddress(contact.address),
    href: `/contacts/${encodeURIComponent(contact.id)}?from=${encodeURIComponent(returnTo)}`,
    row: null,
  };
}

export function localCard(
  row: LocalRow,
  snapshot: string,
  names: RegionNames,
  returnTo: string,
): ResultCardView {
  return {
    key: `row-${row.row}`,
    name: row.name,
    category: row.category,
    region: regionLabel(row.region, names),
    phones: row.phones.map(
      (national) => `${countryPrefix}${national.slice(trunkPrefixLength)}`,
    ),
    hasAddress: row.hasAddress,
    href: `/contacts/row/${snapshot}/${row.row}?from=${encodeURIComponent(returnTo)}`,
    row: { snapshot, row: row.row },
  };
}

export function resultIdentity(card: ResultCardView): string {
  return JSON.stringify([
    card.name,
    card.category,
    card.region,
    card.phones,
    card.hasAddress,
  ]);
}
