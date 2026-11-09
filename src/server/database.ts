import {
  and,
  asc,
  count,
  eq,
  or,
  type Query,
  type SQL,
  sql,
} from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { CategorySchema } from "../core/catalog.ts";
import { compareUtf8 } from "../core/directory-archive.ts";
import {
  type Catalog,
  CatalogSchema,
  type Contact,
  ContactSchema,
  type GroupedSearchResponse,
  GroupedSearchResponseSchema,
  type SearchResponse,
  type Source,
  SourceSchema,
} from "../core/models.ts";
import type { Result } from "../core/result.ts";
import {
  type Cursor,
  decodeCursor,
  encodeCursor,
  nameRank,
  nameRankValues,
  nameTokens,
  type Search,
  searchKey,
  searchQuery,
} from "../core/search.ts";
import {
  boundedLimit,
  cursorDecision,
  previewLimit,
  totalSource,
} from "../core/search-policy.ts";
import { hasPlaces, type WordPlaces, wordPlaces } from "../core/word-match.ts";
import * as schema from "./schema.ts";

const nameCandidateLimit = 48;

export interface SearchSelection {
  readonly condition: SQL | undefined;
  readonly rank: SQL<number>;
  readonly ranked: boolean;
}

interface PageRow {
  readonly id: string;
  readonly name: string;
  readonly rank: number;
  readonly payload: string;
}

export interface PageQuery extends PromiseLike<PageRow[]> {
  toSQL(): Query;
}

export type DirectoryDatabase = DrizzleD1Database<typeof schema>;
export type QueryError = "invalid_cursor" | "snapshot_changed";

export function directoryDatabase(binding: D1Database): DirectoryDatabase {
  return drizzle(binding, { schema });
}

export async function readCatalog(db: DirectoryDatabase): Promise<Catalog> {
  const row = await db
    .select({ payload: schema.metadata.payload })
    .from(schema.metadata)
    .where(eq(schema.metadata.key, "catalog"))
    .get();
  if (!row) throw new Error("The directory catalog is unavailable");
  const value: unknown = JSON.parse(row.payload);
  return v.parse(CatalogSchema, value);
}

export async function readContact(
  db: DirectoryDatabase,
  id: string,
): Promise<Contact | null> {
  const row = await db
    .select({ payload: schema.contacts.payload })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, id))
    .get();
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  return v.parse(ContactSchema, value);
}

export async function readRowContactId(
  db: DirectoryDatabase,
  rowid: number,
): Promise<string | null> {
  const row = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(eq(schema.contacts.rowid, rowid))
    .get();
  return row?.id ?? null;
}

export async function readSource(
  db: DirectoryDatabase,
  id: string,
): Promise<Source | null> {
  const row = await db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.id, id))
    .get();
  if (!row) return null;
  const value: unknown = JSON.parse(row.payload);
  return v.parse(SourceSchema, value);
}

export async function readSources(
  db: DirectoryDatabase,
): Promise<readonly Source[]> {
  const rows = await db
    .select()
    .from(schema.sources)
    .orderBy(asc(schema.sources.id));
  return rows.map((row) => {
    const value: unknown = JSON.parse(row.payload);
    return v.parse(SourceSchema, value);
  });
}

export async function searchContacts(
  db: DirectoryDatabase,
  search: Search,
  catalog: Catalog,
  requestUrl: URL,
): Promise<Result<SearchResponse, QueryError>> {
  const key = await searchKey(search);
  const cursor = search.cursor ? decodeCursor(search.cursor) : null;
  if (cursor && !cursor.ok) return cursor;
  const after = cursor?.ok ? cursor.value : null;
  if (after) {
    const decision = cursorDecision(
      after.snapshot === catalog.snapshot,
      after.query === key,
    );
    if (decision !== "accepted") return { ok: false, error: decision };
  }
  const selection = await searchSelection(db, search, catalog);
  const total =
    catalogTotal(catalog, search) ??
    (
      await db
        .select({ total: count() })
        .from(schema.contacts)
        .where(selection.condition)
        .get()
    )?.total ??
    0;
  const rows = await contactPage(db, selection, after, search.limit);
  const visible = rows.slice(0, search.limit);
  const last = visible.at(-1);
  const nextCursor =
    rows.length > search.limit && last
      ? encodeCursor({
          snapshot: catalog.snapshot,
          query: key,
          rank: v.parse(v.picklist(nameRankValues), last.rank),
          name: last.name,
          id: last.id,
        })
      : null;
  const next = new URL(requestUrl);
  if (nextCursor) next.searchParams.set("cursor", nextCursor);
  const data = visible.map((row) => {
    const value: unknown = JSON.parse(row.payload);
    return v.parse(ContactSchema, value);
  });
  return {
    ok: true,
    value: {
      data,
      meta: { snapshot: catalog.snapshot, total, nextCursor },
      links: { self: requestUrl.href, next: nextCursor ? next.href : null },
    },
  };
}

function catalogTotal(catalog: Catalog, search: Search): number | null {
  switch (
    totalSource(
      searchQuery(search.q).kind !== "empty",
      search.prefecture !== "",
      search.municipality !== "",
      search.category !== "",
    )
  ) {
    case "directory":
      return catalog.contacts;
    case "prefecture":
      return (
        catalog.prefectures.find((item) => item.code === search.prefecture)
          ?.contacts ?? null
      );
    case "category":
      return (
        catalog.categories.find((item) => item.id === search.category)
          ?.contacts ?? null
      );
    case "counted":
      return null;
  }
}

export function contactPage(
  db: DirectoryDatabase,
  selection: SearchSelection,
  after: Cursor | null,
  limit: number,
): PageQuery {
  const { condition, rank, ranked } = selection;
  const name = schema.contacts.normalizedName;
  const continuation = !after
    ? undefined
    : ranked
      ? sql`(${rank}, ${name}, ${schema.contacts.id}) > (${after.rank}, ${after.name}, ${after.id})`
      : after.rank === nameRank.exact
        ? sql`(${name}, ${schema.contacts.id}) > (${after.name}, ${after.id})`
        : sql`0`;
  return db
    .select({
      id: schema.contacts.id,
      name,
      rank,
      payload: schema.contacts.payload,
    })
    .from(schema.contacts)
    .where(and(condition, continuation))
    .orderBy(...(ranked ? [asc(rank)] : []), asc(name), asc(schema.contacts.id))
    .limit(limit + 1);
}

function codeList(codes: readonly string[]): SQL {
  return sql`(SELECT value FROM json_each(${JSON.stringify(codes)}))`;
}

/** The rows whose region or category holds a word, as conditions on indexed codes. */
function placeConditions(places: WordPlaces): SQL[] {
  const { prefecture, municipality, category } = schema.contacts;
  return [
    ...(places.prefectures.length
      ? [sql`${prefecture} IN ${codeList(places.prefectures)}`]
      : []),
    ...(places.municipalities.length
      ? [
          sql`(${prefecture}, ${municipality}) IN (SELECT substr(value, 1, 2), value FROM json_each(${JSON.stringify(places.municipalities)}))`,
        ]
      : []),
    ...(places.categories.length
      ? [sql`${category} IN ${codeList(places.categories)}`]
      : []),
  ];
}

function wordTerms(word: string, limit: number): readonly string[] {
  const tokens = nameTokens(word);
  const bigrams = tokens.filter((term) => term.includes("x"));
  return (bigrams.length ? bigrams : tokens).slice(0, limit);
}

/** How many rows a word's region and category matches may hold, from the catalog's counts. */
function placeRows(places: WordPlaces, catalog: Catalog): number {
  const perMunicipality = Math.ceil(
    catalog.contacts / Math.max(catalog.municipalities.length, 1),
  );
  const prefectureRows = catalog.prefectures
    .filter((item) => places.prefectures.includes(item.code))
    .reduce((sum, item) => sum + item.contacts, 0);
  const categoryRows = catalog.categories
    .filter((item) => places.categories.includes(item.id))
    .reduce((sum, item) => sum + item.contacts, 0);
  return (
    prefectureRows +
    categoryRows +
    places.municipalities.length * perMunicipality
  );
}

/**
 * Narrows the rows to those of one word: its rarest name term, joined with the rows its region or category holds.
 * Every matching row holds every word, so any one word's candidates cover the result.
 */
async function wordCandidates(
  db: DirectoryDatabase,
  words: readonly string[],
  places: readonly WordPlaces[],
  catalog: Catalog,
): Promise<SQL> {
  const perWord = Math.max(1, Math.floor(nameCandidateLimit / words.length));
  const terms = words.map((word) => wordTerms(word, perWord));
  const unique = Array.from(new Set(terms.flat()));
  const counts = new Map(
    (
      await db.all<{ term: string; doc: number }>(
        sql`SELECT term, doc FROM search_vocabulary WHERE term IN (${sql.join(
          unique.map((term) => sql`${term}`),
          sql`, `,
        )})`,
      )
    ).map((row) => [row.term, row.doc]),
  );
  const choices = words.map((_, index) => {
    const [rarest = ""] = (terms[index] ?? []).toSorted(
      (left, right) =>
        (counts.get(left) ?? 0) - (counts.get(right) ?? 0) ||
        compareUtf8(left, right),
    );
    const wordPlaces = places[index] ?? noPlaces;
    return {
      rarest,
      wordPlaces,
      rows:
        (counts.get(rarest) ?? 0) +
        (hasPlaces(wordPlaces) ? placeRows(wordPlaces, catalog) : 0),
    };
  });
  const chosen = choices.reduce((best, choice) =>
    choice.rows < best.rows ? choice : best,
  );
  const named = sql`SELECT rowid FROM contact_search WHERE contact_search MATCH ${chosen.rarest}`;
  const placed = placeConditions(chosen.wordPlaces).map(
    (condition) => sql` UNION SELECT rowid FROM contacts WHERE ${condition}`,
  );
  return sql`${schema.contacts.rowid} IN (${named}${sql.join(placed)})`;
}

const noPlaces: WordPlaces = {
  prefectures: [],
  municipalities: [],
  categories: [],
};

export async function searchSelection(
  db: DirectoryDatabase,
  search: Search,
  catalog: Catalog,
): Promise<SearchSelection> {
  const query = searchQuery(search.q);
  const clauses: SQL[] = [];
  if (search.prefecture)
    clauses.push(eq(schema.contacts.prefecture, search.prefecture));
  if (search.municipality)
    clauses.push(eq(schema.contacts.municipality, search.municipality));
  if (search.category)
    clauses.push(eq(schema.contacts.category, search.category));
  if (query.kind === "telephone")
    clauses.push(
      sql`${schema.contacts.rowid} IN (SELECT contact_rowid FROM phones WHERE number = ${query.number})`,
    );
  if (query.kind !== "words")
    return {
      condition: and(...clauses),
      rank: sql<number>`CAST(0 AS INTEGER)`,
      ranked: false,
    };
  const { words } = query;
  const name = schema.contacts.foldedName;
  const places = words.map((word) =>
    wordPlaces(catalog, word, "with-readings"),
  );
  clauses.push(await wordCandidates(db, words, places, catalog));
  for (const [index, word] of words.entries())
    clauses.push(
      or(
        sql`instr(${name}, ${word}) > 0`,
        ...placeConditions(places[index] ?? noPlaces),
      ) ?? sql`0`,
    );
  const [single] = words;
  const rank =
    words.length === 1 && single !== undefined
      ? sql<number>`CASE WHEN ${name} = ${single} THEN 0 WHEN instr(${name}, ${single}) = 1 THEN 1 WHEN instr(${name}, ${single}) > 0 THEN 2 ELSE 3 END`
      : sql<number>`CASE WHEN ${sql.join(
          words.map((word) => sql`instr(${name}, ${word}) > 0`),
          sql` AND `,
        )} THEN 2 ELSE 3 END`;
  return { condition: and(...clauses), rank, ranked: true };
}

export function categoryPreviews(
  categories: readonly string[],
  limit: number,
): SQL {
  return sql`
    WITH categories(category) AS (
      VALUES ${sql.join(
        categories.map((category) => sql`(${category})`),
        sql`, `,
      )}
    )
    SELECT contacts.category, contacts.id, contacts.normalized_name AS name,
      contacts.payload
    FROM categories JOIN contacts ON contacts.rowid IN (
      SELECT preview.rowid FROM contacts AS preview
      WHERE preview.category = categories.category
      ORDER BY preview.normalized_name, preview.id
      LIMIT ${limit}
    )
    ORDER BY contacts.normalized_name, contacts.id
  `;
}

const PreviewRowSchema = v.strictObject({
  category: CategorySchema,
  id: v.string(),
  name: v.string(),
  payload: v.string(),
});

const GroupRowSchema = v.strictObject({
  ...PreviewRowSchema.entries,
  total: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  rank: v.picklist(nameRankValues),
});

type GroupRow = v.InferOutput<typeof GroupRowSchema>;

async function indexedPreviewRows(
  db: DirectoryDatabase,
  categories: Catalog["categories"],
  limit: number,
): Promise<GroupRow[]> {
  const totals = new Map(categories.map((item) => [item.id, item.contacts]));
  const raw: unknown = await db.all(
    categoryPreviews(
      categories.map((item) => item.id),
      limit,
    ),
  );
  return v.parse(v.array(PreviewRowSchema), raw).map((row) =>
    v.parse(GroupRowSchema, {
      ...row,
      total: totals.get(row.category),
      rank: nameRank.exact,
    }),
  );
}

async function rankedPreviewRows(
  db: DirectoryDatabase,
  search: Search,
  catalog: Catalog,
): Promise<GroupRow[]> {
  const { condition, rank } = await searchSelection(db, search, catalog);
  const raw: unknown = await db.all(sql`
    WITH ranked AS (
      SELECT rowid, category, id, normalized_name AS name, ${rank} AS rank
      FROM contacts WHERE ${condition ?? sql`1`}
    ), candidates AS (
      SELECT rowid, category, id, name, rank,
        count(*) OVER (PARTITION BY category) AS total,
        row_number() OVER (
          PARTITION BY category ORDER BY rank, name, id
        ) AS position
      FROM ranked
    )
    SELECT candidates.category, candidates.total, candidates.id,
      candidates.name, candidates.rank, contacts.payload
    FROM candidates JOIN contacts ON contacts.rowid = candidates.rowid
    WHERE candidates.position <= ${previewLimit(search.limit)}
    ORDER BY candidates.rank, candidates.name, candidates.id
  `);
  return v.parse(v.array(GroupRowSchema), raw);
}

export async function searchContactGroups(
  db: DirectoryDatabase,
  search: Search,
  catalog: Catalog,
  requestUrl: URL,
): Promise<Result<GroupedSearchResponse, QueryError>> {
  const contactsUrl = new URL(requestUrl);
  contactsUrl.pathname = contactsUrl.pathname.replace(
    /contact-groups$/u,
    "contacts",
  );
  for (const [key, value] of Object.entries(search))
    if (value !== "") contactsUrl.searchParams.set(key, String(value));
  if (search.category) {
    const result = await searchContacts(db, search, catalog, contactsUrl);
    if (!result.ok) return result;
    return {
      ok: true,
      value: v.parse(GroupedSearchResponseSchema, {
        groups: result.value.meta.total
          ? [{ category: search.category, results: result.value }]
          : [],
        meta: { snapshot: catalog.snapshot, total: result.value.meta.total },
      }),
    };
  }
  if (search.cursor) return { ok: false, error: "invalid_cursor" };
  const populated = catalog.categories.filter((item) => item.contacts > 0);
  const indexed =
    totalSource(
      searchQuery(search.q).kind !== "empty",
      search.prefecture !== "",
      search.municipality !== "",
      false,
    ) === "directory" &&
    populated.length > 0 &&
    boundedLimit(populated.length + 1);
  const rows = indexed
    ? await indexedPreviewRows(db, populated, previewLimit(search.limit))
    : await rankedPreviewRows(db, search, catalog);
  const byCategory = new Map<string, GroupRow[]>();
  for (const row of rows) {
    const group = byCategory.get(row.category);
    if (group) group.push(row);
    else byCategory.set(row.category, [row]);
  }
  const groups: GroupedSearchResponse["groups"] = [];
  for (const entries of byCategory.values()) {
    const first = entries[0];
    const last = entries.at(-1);
    if (!first || !last) throw new Error("A result category has no preview");
    const categorySearch = { ...search, category: first.category };
    const nextCursor =
      entries.length < first.total
        ? encodeCursor({
            snapshot: catalog.snapshot,
            query: await searchKey(categorySearch),
            rank: last.rank,
            name: last.name,
            id: last.id,
          })
        : null;
    const next = new URL(contactsUrl);
    next.searchParams.set("category", first.category);
    if (nextCursor) next.searchParams.set("cursor", nextCursor);
    groups.push({
      category: first.category,
      results: {
        data: entries.map((row) => {
          const value: unknown = JSON.parse(row.payload);
          return v.parse(ContactSchema, value);
        }),
        meta: { snapshot: catalog.snapshot, total: first.total, nextCursor },
        links: { self: requestUrl.href, next: nextCursor ? next.href : null },
      },
    });
  }
  return {
    ok: true,
    value: v.parse(GroupedSearchResponseSchema, {
      groups,
      meta: {
        snapshot: catalog.snapshot,
        total: groups.reduce((sum, group) => sum + group.results.meta.total, 0),
      },
    }),
  };
}
