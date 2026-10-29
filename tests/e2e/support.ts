import { readFile } from "node:fs/promises";
import { type Download, expect, type Page } from "@playwright/test";

export const serviceCategories = [
  ["nursery", "Nursery", "Children and Families Agency / WAM NET"],
  ["kindergarten", "Kindergarten", "Children and Families Agency / WAM NET"],
  [
    "certified_child_center",
    "Certified child center",
    "Children and Families Agency / WAM NET",
  ],
  [
    "small_scale_childcare",
    "Small-scale childcare",
    "Children and Families Agency / WAM NET",
  ],
  [
    "workplace_childcare",
    "Workplace childcare",
    "Children and Families Agency / WAM NET",
  ],
  [
    "unlicensed_childcare",
    "Unlicensed childcare",
    "Children and Families Agency / WAM NET",
  ],
  [
    "university",
    "University",
    "Ministry of Education, Culture, Sports, Science and Technology",
  ],
  [
    "junior_college",
    "Junior college",
    "Ministry of Education, Culture, Sports, Science and Technology",
  ],
  [
    "technical_college",
    "Technical college",
    "Ministry of Education, Culture, Sports, Science and Technology",
  ],
  [
    "consumer_affairs",
    "Consumer affairs consultation",
    "National Consumer Affairs Center of Japan",
  ],
  ["labour_bureau", "Labour bureau", "Ministry of Health, Labour and Welfare"],
  [
    "labour_inspection",
    "Labour standards inspection office",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "labour_consultation",
    "Labour consultation",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "child_consultation",
    "Child guidance center",
    "Children and Families Agency",
  ],
  [
    "social_withdrawal_support",
    "Social withdrawal support",
    "Ministry of Health, Labour and Welfare",
  ],
  ["pension_office", "Pension office", "Japan Pension Service"],
  [
    "pension_consultation",
    "Pension consultation center",
    "Japan Pension Service",
  ],
  ["tax_office", "Tax office", "National Tax Agency"],
  ["legal_affairs", "Legal affairs bureau", "Ministry of Justice"],
  [
    "fire_brigade_office",
    "Fire brigade administration",
    "Fire and Disaster Management Agency",
  ],
  ["police_consultation", "Police consultation", "National Police Agency"],
  ["employment_office", "Hello Work", "Ministry of Health, Labour and Welfare"],
  [
    "parent_employment_support",
    "Employment support for parents",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "graduate_employment_support",
    "Employment support for graduates",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "youth_employment_support",
    "Employment support for young people",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "foreign_employment_support",
    "Employment support for foreign residents",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "local_employment_support",
    "Local employment consultation",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "agriculture_employment_support",
    "Agriculture, forestry and fisheries employment",
    "Ministry of Health, Labour and Welfare",
  ],
  [
    "relocation_employment_support",
    "Employment relocation support",
    "Ministry of Health, Labour and Welfare",
  ],
] as const;

export const categories = [
  "medical",
  "dental",
  "pharmacy",
  "municipal_office",
  "prefectural_office",
  "nursing_care",
  "disability_support",
  "library",
  "museum",
  "archive",
  ...serviceCategories.map(([category]) => category),
] as const;
export const fixtureContacts = 47 * categories.length;
export const fixturePages = Math.ceil(fixtureContacts / 50);
export type Category = (typeof categories)[number];
export interface Contact {
  id: string;
  name: string;
  address: string;
  prefecture_code: string;
  category: string;
  source_url: string;
  attribution?: string;
  phones: { original: string; e164: string }[];
}
export interface Coverage {
  total_contacts: number;
  unique_phone_numbers: number;
  prefectures_covered: number;
  complete: boolean;
  cells: {
    prefecture_code: string;
    prefecture: string;
    category: string;
    contacts: number;
  }[];
  sources: {
    rows: number;
    accepted: number;
    invalid: number;
    duplicate: number;
    missing_phone: number;
  }[];
}

export function object(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected object");
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Expected nonnegative integer");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
export function contacts(text: string): Contact[] {
  const decoded: unknown = JSON.parse(text);
  return array(decoded).map((value: unknown): Contact => {
    object(value);
    return {
      id: string(value.id),
      name: string(value.name),
      address: string(value.address),
      prefecture_code: string(value.prefecture_code),
      category: string(value.category),
      source_url: string(value.source_url),
      ...(value.attribution === undefined
        ? {}
        : { attribution: string(value.attribution) }),
      phones: array(value.phones).map(
        (phone: unknown): { original: string; e164: string } => {
          object(phone);
          return { original: string(phone.original), e164: string(phone.e164) };
        },
      ),
    };
  });
}
export function coverage(value: unknown): Coverage {
  object(value);
  if (typeof value.complete !== "boolean")
    throw new Error("Expected completeness flag");
  return {
    total_contacts: number(value.total_contacts),
    unique_phone_numbers: number(value.unique_phone_numbers),
    prefectures_covered: number(value.prefectures_covered),
    complete: value.complete,
    cells: array(value.cells).map(
      (cell: unknown): Coverage["cells"][number] => {
        object(cell);
        return {
          prefecture_code: string(cell.prefecture_code),
          prefecture: string(cell.prefecture),
          category: string(cell.category),
          contacts: number(cell.contacts),
        };
      },
    ),
    sources: array(value.sources).map(
      (source: unknown): Coverage["sources"][number] => {
        object(source);
        return {
          rows: number(source.rows),
          accepted: number(source.accepted),
          invalid: number(source.invalid),
          duplicate: number(source.duplicate),
          missing_phone: number(source.missing_phone),
        };
      },
    ),
  };
}
export async function download(page: Page, label: string): Promise<Download> {
  if (["VCF ↓", "CSV ↓", "JSON ↓"].includes(label)) {
    const exports = page.locator("details.exports");
    if (!(await exports.evaluate((node) => node.hasAttribute("open"))))
      await exports.locator("summary").click();
    await expect(exports).toHaveAttribute("open", "");
  }
  await expect(
    page.getByRole("link", { name: label, exact: true }),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("link", { name: label, exact: true }).click();
  const result = await pending;
  expect(await result.failure()).toBeNull();
  return result;
}

export async function openSource(page: Page): Promise<void> {
  await page
    .getByRole("link", { name: "くわしく", exact: true })
    .first()
    .click();
  await page
    .getByRole("link", { name: "この番号の出典を見る", exact: true })
    .click();
}

export async function backToResults(page: Page): Promise<void> {
  await page
    .getByRole("link", { name: "連絡先に もどる", exact: true })
    .click();
  await page.getByRole("link", { name: "結果に もどる", exact: true }).click();
}

const uiCategories: readonly (readonly [string, string, string])[] = [
  ["medical", "病院・診療所", "厚生労働省 地方厚生局"],
  ["dental", "歯医者", "厚生労働省 地方厚生局"],
  ["pharmacy", "薬局", "厚生労働省 地方厚生局"],
  ["municipal_office", "市区町村の役所", "japan-municipal-offices"],
  ["prefectural_office", "都道府県の役所", "内閣府"],
  ["nursing_care", "介護サービス", "厚生労働省"],
  ["disability_support", "障害福祉サービス", "WAM NET"],
  ["library", "図書館", "国立国会図書館"],
  ["museum", "博物館・美術館", "国立国会図書館"],
  ["archive", "公文書館", "国立国会図書館"],
  ["nursery", "保育所", "こども家庭庁・WAM NET"],
  ["kindergarten", "幼稚園", "こども家庭庁・WAM NET"],
  ["certified_child_center", "認定こども園", "こども家庭庁・WAM NET"],
  ["small_scale_childcare", "小規模保育", "こども家庭庁・WAM NET"],
  ["workplace_childcare", "事業所内保育", "こども家庭庁・WAM NET"],
  ["unlicensed_childcare", "認可外保育施設", "こども家庭庁・WAM NET"],
  ["university", "大学", "文部科学省"],
  ["junior_college", "短期大学", "文部科学省"],
  ["technical_college", "高等専門学校", "文部科学省"],
  ["consumer_affairs", "消費生活相談", "国民生活センター"],
  ["labour_bureau", "労働局", "厚生労働省"],
  ["labour_inspection", "労働基準監督署", "厚生労働省"],
  ["labour_consultation", "労働相談", "厚生労働省"],
  ["child_consultation", "児童相談所", "こども家庭庁"],
  ["social_withdrawal_support", "ひきこもり支援", "厚生労働省"],
  ["pension_office", "年金事務所", "日本年金機構"],
  ["pension_consultation", "年金相談センター", "日本年金機構"],
  ["tax_office", "税務署", "国税庁"],
  ["legal_affairs", "法務局", "法務省"],
  ["fire_brigade_office", "消防団の事務窓口", "消防庁"],
  ["police_consultation", "警察相談", "警察庁"],
  ["employment_office", "ハローワーク", "厚生労働省"],
  ["parent_employment_support", "子育て中の人の就職支援", "厚生労働省"],
  ["graduate_employment_support", "新卒の就職支援", "厚生労働省"],
  ["youth_employment_support", "若者の就職支援", "厚生労働省"],
  ["foreign_employment_support", "外国人の就職支援", "厚生労働省"],
  ["local_employment_support", "地域の就職相談", "厚生労働省"],
  ["agriculture_employment_support", "農林漁業の就職支援", "厚生労働省"],
  ["relocation_employment_support", "移住に伴う就職支援", "厚生労働省"],
];

export function categoryLabel(category: string): string {
  const label = uiCategories.find(([key]) => key === category)?.[1];
  if (!label) throw new Error(`Missing UI category: ${category}`);
  return label;
}

export function publisherLabel(category: string): string {
  const label = uiCategories.find(([key]) => key === category)?.[2];
  if (!label) throw new Error(`Missing UI publisher: ${category}`);
  return label;
}
export async function contents(result: Download): Promise<string> {
  return readFile(await result.path(), "utf8");
}
export function checkCards(text: string, count: number): void {
  expect(text.match(/BEGIN:VCARD\r\n/g)).toHaveLength(count);
  expect(text.match(/END:VCARD\r\n/g)).toHaveLength(count);
  expect(text.match(/VERSION:3.0\r\n/g)).toHaveLength(count);
  expect(
    text
      .split("\r\n")
      .every((line: string): boolean => Buffer.byteLength(line, "utf8") <= 75),
  ).toBe(true);
  expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
}
