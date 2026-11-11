import { prefectureNames } from "@public-phonebook/directory/catalog";
import {
  CatalogSchema,
  ContactSchema,
  SourceSchema,
} from "@public-phonebook/directory/models";
import * as v from "valibot";

const origin = "https://sample-city.example.invalid";
const publisher = "みほん市（サンプル）";
const dataAsOf = "2099-04-01";
const generatedAt = "2099-04-02T00:00:00Z";
const digestLength = 64;
const codeDigits = 2;
const facilities = [
  ["civic-library", "みほん市民図書館"],
  ["central-library", "みほん市立中央図書館"],
  ["north-library", "みほん市立北図書館"],
] as const;
const contacts = facilities.map(([id, name]) =>
  v.parse(ContactSchema, {
    id: `sample-city:${id}`,
    name,
    category: "library",
    prefectureCode: "13",
    municipalityCode: "13001",
    address: "みほん県みほん市本町1-2-3（サンプル）",
    phones: [{ display: "03-0000-0000", e164: "+81300000000" }],
    website: `${origin}/${id}`,
    sourceId: "sample-city",
    sourceRecordId: id,
    sourceUrls: [`${origin}/facilities`],
    license: "CC0-1.0",
    licenseUrl: `${origin}/license`,
    dataAsOf,
    retrievedAt: generatedAt,
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  }),
);

export const sampleCityDirectory = {
  contacts,
  catalog: v.parse(CatalogSchema, {
    snapshot: "0".repeat(digestLength),
    generatedAt,
    contacts: contacts.length,
    phones: 1,
    sourceCount: 1,
    categories: [
      {
        id: "library",
        label: "図書館",
        contacts: contacts.length,
        publisher,
        license: "CC0-1.0",
        licenseUrl: `${origin}/license`,
      },
    ],
    prefectures: prefectureNames.map((_name, index) => {
      const code = String(index + 1).padStart(codeDigits, "0");
      return {
        code,
        name: code === "13" ? "みほん県（サンプル）" : `サンプル地域${code}`,
        contacts: code === "13" ? contacts.length : 0,
      };
    }),
    municipalities: [{ code: "13001", prefectureCode: "13", name: "みほん市" }],
  }),
  source: v.parse(SourceSchema, {
    id: "sample-city",
    publisher,
    title: "みほん市の施設一覧（サンプル）",
    url: `${origin}/facilities.csv`,
    sha256: "a".repeat(digestLength),
    dataAsOf,
    retrievedAt: generatedAt,
    indexUrl: `${origin}/facilities`,
    indexSha256: "b".repeat(digestLength),
    licenseUrl: `${origin}/license`,
    licenseSha256: "c".repeat(digestLength),
    artifacts: [],
    rows: contacts.length,
    accepted: contacts.length,
    missingPhone: 0,
    invalid: 0,
    duplicate: 0,
    issues: {},
  }),
};

export function requireSampleCityEnvironment(
  environment: NodeJS.ProcessEnv,
): void {
  for (const name of [
    "PHONEBOOK_FIXTURE_CONTACTS",
    "PHONEBOOK_FIXTURE_CATALOG",
    "PHONEBOOK_FIXTURE_PUBLIC_ORIGIN",
  ]) {
    if (environment[name] !== undefined)
      throw new Error(`Sample images reject ${name}`);
  }
  if (
    environment.PHONEBOOK_FIXTURE_REVISION !== undefined &&
    environment.PHONEBOOK_FIXTURE_REVISION !== "baseline"
  )
    throw new Error("Sample images require the baseline sample revision");
}
