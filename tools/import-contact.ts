import * as v from "valibot";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "../src/core/catalog.ts";
import {
  type Contact,
  ContactSchema,
  type Source,
  SourceSchema,
} from "../src/core/models.ts";

const ImportedContactSchema = v.strictObject({
  id: v.string(),
  source_record_id: v.string(),
  prefecture_code: PrefectureCodeSchema,
  prefecture: v.string(),
  municipality_code: v.nullable(MunicipalityCodeSchema),
  category: CategorySchema,
  name: v.string(),
  address: v.string(),
  phones: v.array(v.strictObject({ original: v.string(), e164: v.string() })),
  official_url: v.nullable(v.string()),
  source_id: v.string(),
  source_url: v.string(),
  license: v.string(),
  license_url: v.string(),
  data_as_of: v.string(),
  retrieved_at: v.string(),
  official_phone_observed: v.boolean(),
  official_phone_source: v.optional(v.nullable(v.string()), null),
});

export function importContact(value: unknown): Contact {
  const row = v.parse(ImportedContactSchema, value);
  return v.parse(ContactSchema, {
    id: row.id,
    sourceRecordId: row.source_record_id,
    prefectureCode: row.prefecture_code,
    municipalityCode: row.municipality_code,
    category: row.category,
    name: row.name,
    address: row.address,
    phones: row.phones.map((phone) => ({
      display: phone.original,
      e164: phone.e164,
    })),
    website: row.official_url || null,
    sourceId: row.source_id,
    sourceUrls: row.source_url
      .split(/,\s*(?=https?:\/\/)/u)
      .map((url) => url.trim()),
    license: row.license,
    licenseUrl: row.license_url,
    dataAsOf: row.data_as_of,
    retrievedAt: row.retrieved_at,
    phoneConfirmed: row.official_phone_observed,
    phoneConfirmationUrl: row.official_phone_source,
  });
}

export function importSource(value: unknown): Source {
  const record = v.parse(v.record(v.string(), v.unknown()), value);
  return v.parse(SourceSchema, {
    id: record.id,
    url: record.url,
    sha256: record.sha256,
    dataAsOf: record.data_as_of,
    retrievedAt: record.retrieved_at,
    indexUrl: record.index_url || null,
    indexSha256: record.index_sha256 || null,
    licenseUrl: record.license_url || null,
    licenseSha256: record.license_sha256 || null,
    artifacts: v
      .parse(
        v.array(
          v.strictObject({
            url: v.string(),
            sha256: v.string(),
            retrieved_at: v.string(),
          }),
        ),
        record.artifacts ?? [],
      )
      .map((item) => ({
        url: item.url,
        sha256: item.sha256,
        retrievedAt: item.retrieved_at,
      })),
    rows: record.rows,
    accepted: record.accepted,
    missingPhone: record.missing_phone,
    invalid: record.invalid,
    duplicate: record.duplicate,
    issues: record.issues,
  });
}
