import type { Category } from "../../src/core/catalog.ts";
import {
  schoolEvidence,
  singleCandidate,
} from "../../src/core/collection-policy.ts";
import { normalizeName } from "../../src/core/search.ts";
import { readCsvTables } from "./read-tables.ts";

const schoolKindWidth = 2;
const prefectureEnd = 4;
const prefectureStart = 2;
const minimumStreetLength = 4;
const postalCodeLength = 7;
const registryColumns = {
  status: 4,
  name: 5,
  address: 6,
  postalCode: 7,
  ended: 9,
} as const;

export const schoolKinds = {
  B1: "elementary_school",
  C1: "junior_high_school",
  C2: "compulsory_education_school",
  D1: "high_school",
  D2: "secondary_school",
  E1: "special_needs_school",
  H1: "vocational_school",
  H2: "miscellaneous_school",
} as const satisfies Record<string, Category>;
export type SchoolCategory = (typeof schoolKinds)[keyof typeof schoolKinds];

export interface School {
  readonly code: string;
  readonly category: SchoolCategory;
  readonly prefectureCode: string;
  readonly name: string;
  readonly address: string;
  readonly postalCode: string;
}

export function addressKey(value: string): string {
  return normalizeName(value)
    .replace(/\s/gu, "")
    .replace(/^〒?[0-9]{3}-?[0-9]{4}/u, "")
    .replace(/[‐‑‒–—―−－ー]/gu, "-")
    .replace(/([0-9]+)(?:丁目|番地の|番地|番|号|の)/gu, "$1-")
    .replace(/-+/gu, "-")
    .replace(/-$/u, "");
}

export function schoolNameKey(value: string): string {
  return normalizeName(value)
    .replace(/\s/gu, "")
    .replace(/[（(][^）)]*[）)]/gu, "")
    .replace(
      /(?:義務教育学校|中等教育学校|特別支援学校|高等学校|中学校|小学校)$/u,
      "",
    );
}

export class SchoolRegistry {
  readonly schools: readonly School[];
  private readonly byRegion = new Map<string, School[]>();
  private readonly byCode = new Map<string, School>();

  constructor(inputs: readonly Uint8Array[], asOf: string) {
    const schools = new Map<string, School>();
    for (const input of inputs) {
      for (const table of readCsvTables(input)) {
        const header = table.rows.findIndex(
          (row) => row[0]?.trim() === "学校コード",
        );
        if (header < 0) throw new Error("The school registry header changed");
        for (const row of table.rows.slice(header + 1)) {
          const code = row[0]?.trim() ?? "";
          if (!/^[A-Z][0-9]{12}$/u.test(code)) continue;
          const category = Object.entries(schoolKinds).find(
            ([kind]) => kind === code.slice(0, schoolKindWidth),
          )?.[1];
          if (!category) continue;
          const ended = row[registryColumns.ended]?.trim() ?? "";
          if (row[registryColumns.status]?.startsWith("9")) continue;
          if (ended && ended <= asOf) continue;
          const name = row[registryColumns.name]?.trim() ?? "";
          const address = row[registryColumns.address]?.trim() ?? "";
          if (!name || !address)
            throw new Error(`Incomplete school registry record: ${code}`);
          const school: School = {
            code,
            category,
            prefectureCode: code.slice(prefectureStart, prefectureEnd),
            name,
            address,
            postalCode: (row[registryColumns.postalCode] ?? "").replace(
              /[^0-9]/gu,
              "",
            ),
          };
          const previous = schools.get(code);
          if (previous && JSON.stringify(previous) !== JSON.stringify(school))
            throw new Error(
              `Conflicting active school registry records: ${code}`,
            );
          schools.set(code, school);
        }
      }
    }
    this.schools = Array.from(schools.values());
    for (const school of this.schools) {
      this.byCode.set(school.code, school);
      const group = this.byRegion.get(school.prefectureCode) ?? [];
      group.push(school);
      this.byRegion.set(school.prefectureCode, group);
    }
  }

  match(input: {
    readonly name: string;
    readonly address: string;
    readonly prefectureCode: string;
    readonly category?: Category;
    readonly postalCode?: string;
    readonly code?: string;
  }): School | null {
    const name = schoolNameKey(input.name);
    if (!name) return null;
    const address = addressKey(input.address);
    const postalCode = input.postalCode?.replace(/[^0-9]/gu, "") ?? "";
    const explicit = input.code ? this.byCode.get(input.code) : undefined;
    if (input.code && !explicit) return null;
    const candidates = explicit
      ? [explicit]
      : (this.byRegion.get(input.prefectureCode) ?? []);
    const matches = candidates.filter((school) => {
      if (
        school.prefectureCode !== input.prefectureCode ||
        (input.category && school.category !== input.category)
      )
        return false;
      if (postalCode && school.postalCode && school.postalCode !== postalCode)
        return false;
      const candidateName = schoolNameKey(school.name);
      const exactName =
        normalizeName(school.name) === normalizeName(input.name);
      const candidateAddress = addressKey(school.address);
      return schoolEvidence(
        Boolean(name),
        exactName || candidateName.endsWith(name),
        exactName,
        Boolean(address),
        address.length >= minimumStreetLength &&
          (candidateAddress.endsWith(address) ||
            address.endsWith(candidateAddress)),
        postalCode.length === postalCodeLength &&
          school.postalCode === postalCode,
        Boolean(explicit),
      );
    });
    return singleCandidate(matches.length) ? (matches[0] ?? null) : null;
  }
}
