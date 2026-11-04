import { DatabaseSync } from "node:sqlite";
import { Miniflare, type Response as WorkerResponse } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  categoryDefinitions,
  prefectureNames,
} from "../../src/core/catalog.ts";
import {
  continueCategory,
  type LocalMatches,
  localQuery,
  matchIndex,
  previewGroups,
} from "../../src/core/local-search.ts";
import {
  type Catalog,
  CatalogSchema,
  type Contact,
  ContactSchema,
  GroupedSearchResponseSchema,
  ProblemSchema,
  type SearchResponse,
  SearchResponseSchema,
} from "../../src/core/models.ts";
import { normalizeName } from "../../src/core/search.ts";
import {
  compareRowOrder,
  decodeSearchIndex,
  type SearchIndex,
} from "../../src/core/search-index.ts";
import { uiCopy } from "../../src/ui/copy.ts";
import { localRow } from "../../src/ui/local-search-service.ts";
import {
  catalogRegions,
  localCard,
  serverCard,
} from "../../src/ui/result-cards.ts";
import { checkFixtureContacts } from "../../tools/check-fixture.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
import { contactSeedStatements } from "../../tools/directory-fixture.ts";
import type { SqlStatement } from "../../tools/remote-statements.ts";
import { readSearchIndex } from "../../tools/search-index.ts";
import { contactRowNumbers } from "../../tools/snapshot.ts";
import { apiWorkerEntry, bundledApi } from "./workerd-fixture.ts";

const snapshot = "c".repeat(64);
const origin = "https://example.org";

const names = [
  "図書館",
  "ﾄｼｮｶﾝ",
  "トショカン",
  "Ａ図書館",
  "a図書館",
  "市立図書館",
  "図書館分館",
  "𠮷田図書館",
  "﨑山図書館",
  "ABC分室",
  "abc分室",
  "国立国会図書館",
  "国立国会図書館 分室",
  "山崎図書館",
  "髙田医院",
  "高田医院",
] as const;
const categories = ["library", "library", "medical", "museum"] as const;
const phones = [
  ["03-3581-2331", "+81335812331"],
  ["0774-98-1200", "+81774981200"],
  ["090-1234-5678", "+819012345678"],
  ["03-1111-2222", "+81311112222"],
  ["03-1234-5678", "+81312345678"],
  ["083-1234-5678", "+818312345678"],
] as const;
const generatedContacts = 150;
/** Addresses whose details show nothing, including a map annotation alone, and one that shows an address. */
const addresses = ["所在地", "", "所在地", "　", "所在地", "（地図）"] as const;

function contact(index: number): Contact {
  const name =
    index < names.length * 2
      ? (names[index % names.length] ?? "")
      : index % 3 === 0
        ? `図書館${index}`
        : `全国の図書館${index % 7}`;
  const ownPhone = `+8133333${String(index).padStart(4, "0")}`;
  const shared = phones[index % phones.length] ?? phones[0];
  return v.parse(ContactSchema, {
    id: `parity:${String((index * 53) % 211).padStart(3, "0")}`,
    name,
    category: categories[index % categories.length],
    prefectureCode: index % 2 === 0 ? "13" : "14",
    municipalityCode:
      index % 5 === 0 ? null : index % 2 === 0 ? "13101" : "14100",
    address: addresses[index % addresses.length],
    phones:
      index % 4 === 0
        ? [
            { display: shared[0], e164: shared[1] },
            { display: ownPhone, e164: ownPhone },
          ]
        : [{ display: shared[0], e164: shared[1] }],
    website: null,
    sourceId: "fixture",
    sourceRecordId: String(index),
    sourceUrls: ["https://example.org/data"],
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-29T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  });
}

const contacts = [
  ...checkFixtureContacts(),
  ...Array.from({ length: generatedContacts }, (_, index) => contact(index)),
];
const ordered = contacts.toSorted((left, right) =>
  compareRowOrder(
    { normalizedName: normalizeName(left.name), id: left.id },
    { normalizedName: normalizeName(right.name), id: right.id },
  ),
);
const catalog: Catalog = v.parse(CatalogSchema, {
  snapshot,
  generatedAt: "2026-10-29T00:00:00Z",
  contacts: contacts.length,
  phones: new Set(contacts.flatMap((item) => item.phones.map((p) => p.e164)))
    .size,
  sourceCount: 1,
  categories: categoryDefinitions.map((category) => ({
    id: category.id,
    label: category.label,
    contacts: contacts.filter((item) => item.category === category.id).length,
    publisher: "公開元",
    license: "CC0-1.0",
    licenseUrl: "https://example.org/license",
  })),
  prefectures: prefectureNames.map((name, index) => ({
    code: String(index + 1).padStart(2, "0"),
    name,
    contacts: contacts.filter(
      (item) => item.prefectureCode === String(index + 1).padStart(2, "0"),
    ).length,
  })),
  municipalities: [
    { code: "13101", prefectureCode: "13", name: "千代田区" },
    { code: "14100", prefectureCode: "14", name: "横浜市" },
  ],
});

function statements(): SqlStatement[] {
  return [
    ...contactSeedStatements(contacts, contactRowNumbers(contacts)),
    {
      sql: "INSERT INTO metadata VALUES ('catalog', ?)",
      params: [JSON.stringify(catalog)],
    },
  ];
}

let runtime: Miniflare | undefined;
let index: SearchIndex;

beforeAll(async () => {
  runtime = new Miniflare({
    cf: false,
    telemetry: { enabled: false },
    enableDevRegistry: false,
    unsafeEnableSharedStorage: false,
    workers: [
      {
        config: {
          name: "local-search-parity",
          compatibilityDate: "2026-10-23",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: apiWorkerEntry },
              "api.js": { type: "esm", contents: await bundledApi() },
            },
          },
          env: {
            DB: { type: "d1", id: "local-search-parity" },
            DATASETS: { type: "r2", name: "local-search-parity" },
            APP_ENV: { type: "text", value: "development" },
            PUBLIC_ORIGIN: { type: "text", value: "http://localhost:8787" },
          },
        },
      },
    ],
  });
  const DB = await runtime.getD1Database("DB");
  await DB.exec(databaseSchema.replaceAll("\n", " "));
  await DB.batch(
    statements().map((item) => DB.prepare(item.sql).bind(...item.params)),
  );
  const local = new DatabaseSync(":memory:");
  try {
    local.exec(databaseSchema);
    for (const item of statements())
      local.prepare(item.sql).run(...item.params);
    index = decodeSearchIndex(readSearchIndex(local, { snapshot, catalog }));
  } finally {
    local.close();
  }
});

afterAll(async () => runtime?.dispose());

/** Asks workerd for the whole response, so each request crosses from Node once. */
async function request(path: string): Promise<WorkerResponse> {
  if (!runtime) throw new Error("The workerd runtime isn't ready");
  return runtime.dispatchFetch(`${origin}${path}`);
}

async function json(path: string): Promise<unknown> {
  const response = await request(path);
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return body;
}

function ids(rows: readonly number[]): string[] {
  return rows.map((row) => ordered[row]?.id ?? `missing:${row}`);
}

async function serverPages(first: SearchResponse): Promise<string[][]> {
  const result = [first.data.map((item) => item.id)];
  let page = first;
  while (page.links.next) {
    const next = new URL(page.links.next);
    page = v.parse(
      SearchResponseSchema,
      await json(next.pathname + next.search),
    );
    result.push(page.data.map((item) => item.id));
  }
  return result;
}

function localPages(
  matches: LocalMatches,
  category: string,
  visible: number,
  first: readonly number[],
): string[][] {
  const result = [ids(first)];
  let current = visible;
  for (;;) {
    const page = continueCategory(matches, category, current);
    if (!page.ok) throw new Error(page.error);
    if (page.value.rows.length === 0) return result;
    result.push(ids(page.value.rows));
    current = page.value.visible;
  }
}

const queries = [
  "図書館",
  "ﾄｼｮｶﾝ",
  "トショ",
  "ａ",
  "A図",
  "abc",
  "ＡＢＣ分",
  "国立国会図書館",
  "国立国会",
  "関西館",
  "𠮷",
  "﨑",
  "館",
  "分館",
  "全国",
  "1",
  "１",
  "図書館1",
  " 分室",
  "03-3581-2331",
  "０３３５８１２３３１",
  "+81 3 3581 2331",
  "0774981200",
  "090-1234-5678",
  "0333330004",
  "03-1234-5678",
  "08312345678",
  "+81312345678",
  "03-3581",
  "\t図書館\t",
  "図\t書",
  "存在しない名前",
  "山\u{fa11}",
  "山崎",
  "髙田",
  "高田",
  "崎",
  "千代田 図書館",
  "東京　分室",
  "横浜  国立",
  "神奈川 図書館 1",
  "図書館 abc",
  "横浜",
  "東京都",
  "病院",
  "博物館 全国",
  "トショカン",
  "としょかん",
  "ﾄｼｮｶﾝ 千代田",
  "図 書 館 分 室 全 国 1",
  `${"図".repeat(170)}ab`,
];

describe("local search parity with the server", () => {
  it("numbers rows in index order so positions map to D1 rows", () => {
    const rows = contactRowNumbers(contacts);
    expect(ordered.map((item) => rows.get(item.id))).toEqual(
      ordered.map((_, position) => position + 1),
    );
    expect(index.rows.map((row) => row.name)).toEqual(
      ordered.map((item) => item.name),
    );
  });

  it("returns the server's groups, totals, previews, and every continuation page", async () => {
    let continued = 0;
    for (const query of queries) {
      const parsed = localQuery(query);
      if (!parsed.ok) throw new Error(`The query must be valid: ${query}`);
      const matches = matchIndex(index, parsed.value);
      const local = previewGroups(matches);
      const grouped = v.parse(
        GroupedSearchResponseSchema,
        await json(`/api/contact-groups?q=${encodeURIComponent(query)}`),
      );
      expect(local.total, query).toBe(grouped.meta.total);
      expect(
        local.groups.map((group) => group.category),
        query,
      ).toEqual(grouped.groups.map((group) => group.category));
      for (const [position, group] of grouped.groups.entries()) {
        const mine = local.groups[position];
        if (!mine) throw new Error(`Missing local group for ${query}`);
        expect(mine.total, query).toBe(group.results.meta.total);
        const server = await serverPages(group.results);
        expect(
          localPages(matches, mine.category, mine.rows.length, mine.rows),
          `${query} ${group.category}`,
        ).toEqual(server);
        continued += server.length - 1;
        const selected = v.parse(
          GroupedSearchResponseSchema,
          await json(
            `/api/contact-groups?q=${encodeURIComponent(query)}&category=${group.category}`,
          ),
        );
        const firstPage = continueCategory(matches, group.category, 0);
        if (!firstPage.ok || !selected.groups[0])
          throw new Error(`Missing category page for ${query}`);
        expect(firstPage.value.total).toBe(
          selected.groups[0].results.meta.total,
        );
        expect(
          localPages(
            matches,
            group.category,
            firstPage.value.visible,
            firstPage.value.rows,
          ),
          `${query} ${group.category} selected`,
        ).toEqual(await serverPages(selected.groups[0].results));
      }
    }
    expect(continued).toBeGreaterThan(queries.length);
  });

  it("labels each detail action the same way for server and in-browser results", async () => {
    const regions = catalogRegions(catalog);
    const labels = new Set<string>();
    for (const query of queries) {
      const parsed = localQuery(query);
      if (!parsed.ok) throw new Error(`The query must be valid: ${query}`);
      const local = previewGroups(matchIndex(index, parsed.value));
      const grouped = v.parse(
        GroupedSearchResponseSchema,
        await json(`/api/contact-groups?q=${encodeURIComponent(query)}`),
      );
      const server = grouped.groups.flatMap((group) =>
        group.results.data.map((item) =>
          uiCopy.resultDetail.label(serverCard(item, regions, "/").hasAddress),
        ),
      );
      const browser = local.groups.flatMap((group) =>
        group.rows.map((position) =>
          uiCopy.resultDetail.label(
            localCard(localRow(index, position), snapshot, regions, "/")
              .hasAddress,
          ),
        ),
      );
      expect(browser, query).toEqual(server);
      for (const label of server) labels.add(label);
    }
    expect([...labels].sort()).toEqual([
      "くわしい情報を見る",
      "住所などを見る",
    ]);
  });

  it("finds either form of a kanji variant from the other on the server and in the browser", async () => {
    for (const [query, name] of [
      ["山\u{fa11}", "山崎図書館"],
      ["崎", "\u{fa11}山図書館"],
      ["髙田", "高田医院"],
      ["高田", "髙田医院"],
    ] as const) {
      const grouped = v.parse(
        GroupedSearchResponseSchema,
        await json(`/api/contact-groups?q=${encodeURIComponent(query)}`),
      );
      expect(
        grouped.groups.flatMap((group) =>
          group.results.data.map((item) => item.name),
        ),
        query,
      ).toContain(name);
      const parsed = localQuery(query);
      if (!parsed.ok) throw new Error(`The query must be valid: ${query}`);
      expect(
        previewGroups(matchIndex(index, parsed.value)).groups.flatMap((group) =>
          group.rows.map((row) => index.rows[row]?.name),
        ),
        query,
      ).toContain(name);
    }
  });

  it("rejects the queries the server rejects", async () => {
    for (const query of [
      "図書館\0",
      "\0",
      "図".repeat(171),
      "図 書 館 分 室 全 国 1 2",
    ]) {
      expect(localQuery(query)).toEqual({ ok: false, error: "invalid_query" });
      const response = await request(
        `/api/contact-groups?q=${encodeURIComponent(query)}`,
      );
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(v.parse(ProblemSchema, body).code).toBe("invalid_query");
    }
  });
});
