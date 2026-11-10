import { prefectureNames } from "@public-phonebook/directory/catalog";
import {
  type Catalog,
  CatalogSchema,
} from "@public-phonebook/directory/models";
import { retainsCoverage } from "@public-phonebook/directory/publication-policy";
import * as v from "valibot";

const maximumContacts = 10000000;
const regionCodeWidth = 2;

export function validatePublicationCoverage(
  input: unknown,
  previous?: Catalog,
): Catalog {
  const catalog = v.parse(CatalogSchema, input);
  const expected = prefectureNames.map((_, index) =>
    String(index + 1).padStart(regionCodeWidth, "0"),
  );
  if (
    catalog.contacts <= 0 ||
    catalog.contacts > maximumContacts ||
    catalog.phones <= 0 ||
    catalog.sourceCount <= 0 ||
    catalog.prefectures.length !== expected.length ||
    new Set(catalog.prefectures.map((item) => item.code)).size !==
      expected.length ||
    expected.some(
      (code) =>
        !catalog.prefectures.some(
          (item) => item.code === code && item.contacts > 0,
        ),
    ) ||
    catalog.categories.length === 0 ||
    new Set(catalog.categories.map((item) => item.id)).size !==
      catalog.categories.length ||
    catalog.categories.some((item) => item.contacts <= 0)
  )
    throw new Error("Publication requires populated national coverage");
  if (
    previous &&
    (previous.contacts > maximumContacts ||
      !retainsCoverage(catalog.contacts, previous.contacts) ||
      previous.categories.some(
        (category) =>
          !catalog.categories.some((item) => item.id === category.id),
      ))
  )
    throw new Error(
      "Production coverage loss requires a reviewed policy change",
    );
  return catalog;
}
