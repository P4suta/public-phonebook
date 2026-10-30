import { expect, it } from "vitest";
import { prefectureNames } from "../../src/core/catalog.ts";
import { validatePublicationCoverage } from "../../tools/publication-coverage.ts";

const catalog = {
  snapshot: "a".repeat(64),
  generatedAt: "2026-10-30",
  contacts: 470,
  phones: 470,
  sourceCount: 1,
  categories: [
    {
      id: "library",
      label: "図書館",
      contacts: 470,
      publisher: "Fixture",
      license: "CC0",
      licenseUrl: "https://example.invalid/license",
    },
  ],
  prefectures: prefectureNames.map((name, index) => ({
    code: String(index + 1).padStart(2, "0"),
    name,
    contacts: 10,
  })),
  municipalities: [],
};

it("requires all populated prefectures and unambiguous nonempty categories before activation", () => {
  expect(validatePublicationCoverage(catalog).contacts).toBe(470);
  for (const input of [
    { ...catalog, contacts: 0 },
    { ...catalog, contacts: 10000001 },
    { ...catalog, prefectures: catalog.prefectures.slice(1) },
    {
      ...catalog,
      prefectures: catalog.prefectures.map(() => catalog.prefectures[0]),
    },
    {
      ...catalog,
      prefectures: catalog.prefectures.map((item) => ({
        ...item,
        contacts: 0,
      })),
    },
    { ...catalog, categories: [] },
    { ...catalog, categories: [...catalog.categories, ...catalog.categories] },
    {
      ...catalog,
      categories: catalog.categories.map((item) => ({ ...item, contacts: 0 })),
    },
  ])
    expect(() => validatePublicationCoverage(input)).toThrow();
});

it("refuses lost production categories or a reduction beyond the retention boundary", () => {
  const previous = validatePublicationCoverage(catalog);
  expect(
    validatePublicationCoverage({ ...catalog, contacts: 423 }, previous)
      .contacts,
  ).toBe(423);
  expect(() =>
    validatePublicationCoverage({ ...catalog, contacts: 422 }, previous),
  ).toThrow("coverage loss");
  expect(() =>
    validatePublicationCoverage(
      {
        ...catalog,
        categories: catalog.categories.map((item) => ({
          ...item,
          id: "medical",
        })),
      },
      previous,
    ),
  ).toThrow("coverage loss");
  expect(() =>
    validatePublicationCoverage(catalog, { ...previous, contacts: 10000001 }),
  ).toThrow("coverage loss");
});
