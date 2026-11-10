import {
  categoryDefinitions,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
  prefectureNames,
} from "@public-phonebook/directory/catalog";
import { normalizeName } from "@public-phonebook/directory/identity";
import {
  compareRowOrder,
  encodeSearchIndex,
  type SearchIndexInput,
  searchIndexRow,
} from "@public-phonebook/directory/search-index";
import * as v from "valibot";

export interface ModelContact {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly prefectureCode: string;
  readonly municipalityCode: string | null;
  readonly phones: readonly { readonly e164: string }[];
}

export interface ModelDirectory {
  readonly contacts: readonly ModelContact[];
  readonly bytes: Uint8Array;
}

export function indexInput(snapshot: string): SearchIndexInput {
  return {
    snapshot,
    catalog: {
      categories: categoryDefinitions.map((category) => ({
        id: category.id,
        label: category.label,
        contacts: 0,
        publisher: "Publisher",
        license: "CC0-1.0",
        licenseUrl: "https://example.org/license",
      })),
      prefectures: prefectureNames.map((name, index) => ({
        code: v.parse(PrefectureCodeSchema, String(index + 1).padStart(2, "0")),
        name,
        contacts: 0,
      })),
      municipalities: [
        {
          code: v.parse(MunicipalityCodeSchema, "13101"),
          prefectureCode: v.parse(PrefectureCodeSchema, "13"),
          name: "千代田区",
        },
      ],
    },
  };
}

export function modelDirectory(
  contacts: readonly ModelContact[],
  snapshot: string,
): ModelDirectory {
  const ordered = contacts.toSorted((left, right) =>
    compareRowOrder(
      { normalizedName: normalizeName(left.name), id: left.id },
      { normalizedName: normalizeName(right.name), id: right.id },
    ),
  );
  return {
    contacts: ordered,
    bytes: encodeSearchIndex(
      ordered.map((contact) =>
        searchIndexRow({ ...contact, hasAddress: true }),
      ),
      indexInput(snapshot),
    ),
  };
}
