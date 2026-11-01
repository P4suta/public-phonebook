import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
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
import { nameTokens, normalizeName } from "../../src/core/search.ts";
import {
  compareRowOrder,
  decodeSearchIndex,
  type SearchIndex,
} from "../../src/core/search-index.ts";
import { api, type DirectoryApiBindings } from "../../src/server/api.ts";
import { checkFixtureContacts } from "../../tools/check-fixture.ts";
import { databaseSchema } from "../../tools/database-schema.ts";
import { readSearchIndex } from "../../tools/search-index.ts";
import { contactRowNumbers } from "../../tools/snapshot.ts";

const snapshot = "c".repeat(64);
const origin = "https://example.org";
const runtime = new Miniflare({
  cf: false,
  telemetry: { enabled: false },
  enableDevRegistry: false,
  unsafeEnableSharedStorage: false,
  workers: [
    {
      config: {
        name: "local-search-parity",
        compatibilityDate: "2026-10-23",
        manifest: {
          mainModule: "parity.js",
          modules: {
            "parity.js": {
              type: "esm",
              contents:
                "export default { fetch() { return new Response('parity'); } }",
            },
          },
        },
        env: { DB: { type: "d1", id: "local-search-parity" } },
      },
    },
  ],
});

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
    address: "所在地",
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
  municipalities: [],
});

interface Statement {
  readonly sql: string;
  readonly values: readonly (string | number | null)[];
}

function statements(): Statement[] {
  const rows = contactRowNumbers(contacts);
  return [
    ...contacts.flatMap((item): Statement[] => {
      const rowid = rows.get(item.id);
      if (rowid === undefined) throw new Error("Missing parity row number");
      return [
        {
          sql: "INSERT INTO contacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          values: [
            rowid,
            item.id,
            item.name,
            normalizeName(item.name),
            item.prefectureCode,
            item.municipalityCode,
            item.category,
            item.sourceId,
            JSON.stringify(item),
          ],
        },
        ...item.phones.map((phone) => ({
          sql: "INSERT INTO phones VALUES (?, ?)",
          values: [phone.e164, rowid],
        })),
        {
          sql: "INSERT INTO contact_search(rowid, terms) VALUES (?, ?)",
          values: [rowid, nameTokens(normalizeName(item.name)).join(" ")],
        },
      ];
    }),
    {
      sql: "INSERT INTO metadata VALUES ('catalog', ?)",
      values: [JSON.stringify(catalog)],
    },
  ];
}

let bindings: DirectoryApiBindings;
let index: SearchIndex;

beforeAll(async () => {
  const DB = await runtime.getD1Database("DB");
  bindings = {
    DB,
    DATASETS: { get: async (): Promise<null> => null },
    APP_ENV: "development",
    PUBLIC_ORIGIN: "http://localhost:8787",
  };
  await DB.exec(databaseSchema.replaceAll("\n", " "));
  await DB.batch(
    statements().map((item) => DB.prepare(item.sql).bind(...item.values)),
  );
  const local = new DatabaseSync(":memory:");
  try {
    local.exec(databaseSchema);
    for (const item of statements())
      local.prepare(item.sql).run(...item.values);
    index = decodeSearchIndex(readSearchIndex(local, { snapshot, catalog }));
  } finally {
    local.close();
  }
});

afterAll(async () => runtime.dispose());

async function request(path: string): Promise<Response> {
  return api.fetch(new Request(`${origin}${path}`), bindings);
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

  it("rejects the queries the server rejects", async () => {
    for (const query of ["図書館\0", "\0", "図".repeat(171)]) {
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
