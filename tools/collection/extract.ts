import { createHash } from "node:crypto";
import * as v from "valibot";
import { normalizeAddress } from "../../src/core/address.ts";
import {
  type Category,
  MunicipalityCodeSchema,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  type Contact,
  ContactSchema,
  PublicUrlSchema,
} from "../../src/core/models.ts";
import { formatPhone, normalizePhone } from "../../src/core/phone.ts";
import type { DirectorySource, SourceColumns } from "./models.ts";
import { classifyPublicFacility } from "./public-facility.ts";
import type { SourceTable } from "./read-tables.ts";
import type { SchoolRegistry } from "./school-registry.ts";

const prefectureCodeWidth = 2;
const municipalityCodeWidth = 5;
const contactIdentityHashWidth = 32;
const fieldAliases = {
  name: [
    "学校名",
    "施設名称",
    "施設_名称",
    "名称(漢字)",
    "施設名(漢字)",
    "小学校名",
    "中学校名",
    "義務教育学校名",
    "校名",
    "名称",
    "施設名",
    "保健所名",
    "教育委員会名",
  ],
  address: [
    "所在地",
    "所在地_連結表記",
    "住所",
    "住所_連結表記",
    "学校所在地",
    "施設所在地",
    "所在地(住所)",
    "施設_住所_表記",
  ],
  phone: [
    "電話",
    "電話番号",
    "tel",
    "電話(代表)",
    "電話番号(代表)",
    "所在地(電話番号)",
    "施設_電話番号",
    "telephonenumber",
    "連絡先電話番号",
  ],
  phoneAreaCode: ["市外局番", "局番"],
  postalCode: ["郵便", "郵便番号", "〒", "所在地(郵便番号)"],
  website: ["url", "ホームページ", "学校ホームページ"],
  recordId: ["学校コード"],
  kind: ["学校種別", "学校種", "校種"],
} as const;

function label(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s/gu, "")
    .replace(/^[0-9]+[.)、]/u, "");
}

export function findColumns(row: readonly string[]): SourceColumns | null {
  const fields = Object.fromEntries(
    Object.entries(fieldAliases).map(([key, aliases]) => [
      key,
      row.flatMap((cell, index) =>
        aliases.some((alias) => alias === label(cell)) ? [index] : [],
      ),
    ]),
  );
  const parsed = v.safeParse(
    v.object({
      name: v.pipe(v.array(v.number()), v.minLength(1)),
      address: v.array(v.number()),
      phone: v.pipe(v.array(v.number()), v.minLength(1)),
      phoneAreaCode: v.array(v.number()),
      postalCode: v.array(v.number()),
      website: v.array(v.number()),
      recordId: v.array(v.number()),
      kind: v.array(v.number()),
    }),
    fields,
  );
  return parsed.success ? parsed.output : null;
}

export function extractPhones(
  value: string,
  prefix?: string,
): Contact["phones"] {
  const text = value.normalize("NFKC").replace(/[‐‑‒–—―−ー]/gu, "-");
  const numbers = new Map<string, Contact["phones"][number]>();
  for (const line of text.split(/[\r\n/、,;]/u)) {
    const voice = line.split(/(?:fax|ファックス|ファクス)\s*[:：]?/iu)[0] ?? "";
    const cleaned = voice
      .replace(/(?:電話(?:番号)?|tel(?:ephone)?)\s*[:：]?/giu, "")
      .replace(/\((?:代表|代|職員室|事務室)\)/gu, "")
      .trim();
    const direct = normalizePhone(cleaned);
    const candidates = direct.ok
      ? [cleaned]
      : (cleaned.match(/(?:\+81|0)[0-9() .-]{8,}[0-9]/gu) ?? []);
    if (!candidates.length && prefix && /^[1-9][0-9 -]+$/u.test(cleaned))
      candidates.push(`${prefix}-${cleaned}`);
    for (const candidate of candidates) {
      const phone = normalizePhone(candidate);
      if (phone.ok)
        numbers.set(phone.value, {
          display: formatPhone(phone.value),
          e164: phone.value,
        });
    }
  }
  return Array.from(numbers.values());
}

function field(
  row: readonly string[],
  columns: readonly number[] | undefined,
): string {
  return Array.from(
    new Set(
      (columns ?? [])
        .map((column) => row[column]?.trim() ?? "")
        .filter(Boolean),
    ),
  ).join("");
}

export interface ExtractedSource {
  readonly contacts: Contact[];
  readonly rows: number;
  readonly missingPhone: number;
  readonly invalid: number;
  readonly duplicate: number;
  readonly issues: Record<string, number>;
  readonly unmatched: readonly {
    name: string;
    address: string;
    table: string;
    row: number;
  }[];
}

export function extractTables(input: {
  readonly source: DirectorySource;
  readonly tables: readonly SourceTable[];
  readonly registry: SchoolRegistry;
  readonly retrievedAt: string;
  readonly sourceUrl: string;
  readonly sourceId: string;
}): ExtractedSource {
  const { source, registry } = input;
  const contacts = new Map<string, Contact>();
  const issues: Record<string, number> = {};
  const unmatched: {
    name: string;
    address: string;
    table: string;
    row: number;
  }[] = [];
  let rows = 0;
  let missingPhone = 0;
  let invalid = 0;
  let duplicate = 0;
  for (const table of input.tables) {
    if (
      source.tablePattern &&
      !new RegExp(source.tablePattern, "u").test(table.name)
    )
      continue;
    let columns = source.columns ?? null;
    for (const [index, row] of table.rows.entries()) {
      const header = findColumns(row);
      if (header && !source.columns) {
        columns = header;
        continue;
      }
      if (!columns) continue;
      if (
        columns.phone.some((column) =>
          fieldAliases.phone.some(
            (alias) => alias === label(row[column] ?? ""),
          ),
        )
      )
        continue;
      const name = field(row, columns.name)
        .replace(/^[○〇△◇◎※\s]+/u, "")
        .trim();
      if (!name || fieldAliases.name.some((alias) => alias === label(name)))
        continue;
      rows += 1;
      const excluded = /閉校|廃校|休校|募集停止|☆/u.test(name);
      if (excluded) {
        issues.excluded_inactive = (issues.excluded_inactive ?? 0) + 1;
        continue;
      }
      const rawArea = field(row, columns.phoneAreaCode)
        .normalize("NFKC")
        .replace(/[()\s-]/gu, "");
      const areaCode = /^[1-9][0-9]{1,3}$/u.test(rawArea)
        ? `0${rawArea}`
        : /^0[1-9][0-9]{1,3}$/u.test(rawArea)
          ? rawArea
          : source.phonePrefix;
      const phones = extractPhones(
        columns.phone.map((column) => row[column] ?? "").join("\n"),
        areaCode,
      );
      if (!phones.length) {
        missingPhone += 1;
        continue;
      }
      const address = field(row, columns.address).replace(
        /^〒\s*[0-9０-９]{3}[-－]?[0-9０-９]{4}\s*/u,
        "",
      );
      const namedPrefecture = field(row, columns.prefecture);
      const addressPrefecture = prefectureNames.findIndex(
        (prefecture) =>
          address.normalize("NFKC").startsWith(prefecture) ||
          namedPrefecture === prefecture,
      );
      const prefectureCode =
        addressPrefecture >= 0
          ? String(addressPrefecture + 1).padStart(prefectureCodeWidth, "0")
          : (source.prefectureCode ?? "00");
      const normalizedAddress = normalizeAddress(address);
      const prefixedAddress =
        normalizedAddress &&
        !prefectureNames.some((prefecture) =>
          normalizedAddress.startsWith(prefecture),
        ) &&
        addressPrefecture >= 0
          ? `${prefectureNames[addressPrefecture] ?? ""}${normalizedAddress}`
          : normalizedAddress;
      const municipality = v.safeParse(
        MunicipalityCodeSchema,
        field(row, columns.municipality).slice(0, municipalityCodeWidth),
      );
      const kind = field(row, columns.kind).normalize("NFKC");
      let category: Category | undefined =
        source.category === "school"
          ? source.kindValues[kind]
          : source.category === "public_facility"
            ? undefined
            : source.category;
      const school = registry.match({
        name,
        address,
        prefectureCode,
        ...(category ? { category } : {}),
        postalCode: field(row, columns.postalCode),
        ...(/^[A-Z][0-9]{12}$/u.test(field(row, columns.recordId))
          ? { code: field(row, columns.recordId) }
          : {}),
      });
      if (source.category === "public_facility" && !school)
        category = classifyPublicFacility(name) ?? undefined;
      if (
        (source.category === "school" || category?.endsWith("_school")) &&
        !school
      ) {
        issues.excluded_unmatched_school =
          (issues.excluded_unmatched_school ?? 0) + 1;
        unmatched.push({ name, address, table: table.name, row: index });
        continue;
      }
      if (!school && !category) {
        issues.excluded_unclassified_facility =
          (issues.excluded_unclassified_facility ?? 0) + 1;
        continue;
      }
      const parsedWebsite = v.safeParse(
        PublicUrlSchema,
        field(row, columns.website),
      );
      const parsed = v.safeParse(ContactSchema, {
        id: school
          ? `school:${school.code}`
          : `facility:${createHash("sha256")
              .update(
                JSON.stringify([
                  category,
                  prefectureCode,
                  name.normalize("NFKC").replace(/\s/gu, ""),
                  prefixedAddress.replace(/\s/gu, ""),
                ]),
              )
              .digest("hex")
              .slice(0, contactIdentityHashWidth)}`,
        name: school?.name ?? name,
        category: school?.category ?? category,
        prefectureCode,
        municipalityCode:
          municipality.success && municipality.output.startsWith(prefectureCode)
            ? municipality.output
            : null,
        address: normalizeAddress(school?.address ?? prefixedAddress),
        phones,
        website: parsedWebsite.success ? parsedWebsite.output : null,
        sourceId: input.sourceId,
        sourceRecordId: `${table.name}:${index + 1}`,
        sourceUrls: Array.from(
          new Set([
            ...(source.indexUrl ? [source.indexUrl] : []),
            input.sourceUrl,
          ]),
        ),
        license: source.license,
        licenseUrl: source.licenseUrl,
        dataAsOf: source.dataAsOf,
        retrievedAt: input.retrievedAt,
        phoneConfirmed: false,
        phoneConfirmationUrl: null,
      });
      if (!parsed.success) {
        invalid += 1;
        continue;
      }
      const previous = contacts.get(parsed.output.id);
      if (previous) {
        const merged = new Map(
          [...previous.phones, ...parsed.output.phones].map((phone) => [
            phone.e164,
            phone,
          ]),
        );
        contacts.set(previous.id, {
          ...previous,
          phones: Array.from(merged.values()),
        });
        duplicate += 1;
      } else contacts.set(parsed.output.id, parsed.output);
    }
  }
  return {
    contacts: Array.from(contacts.values()),
    rows,
    missingPhone,
    invalid,
    duplicate,
    issues,
    unmatched,
  };
}
