import {
  and,
  asc,
  count,
  eq,
  gt,
  or,
  type Query,
  type SQL,
  sql,
} from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { CategorySchema } from "../core/catalog.ts";
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
import { normalizePhone } from "../core/phone.ts";
import type { Result } from "../core/result.ts";
import {
  type Cursor,
  decodeCursor,
  encodeCursor,
  nameRank,
  nameRankValues,
  nameTokens,
  normalizeName,
  type Search,
  searchKey,
} from "../core/search.ts";
import {
  boundedLimit,
  cursorDecision,
  previewLimit,
  totalSource,
} from "../core/search-policy.ts";
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
  const selection = await searchSelection(db, search);
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
      normalizeName(search.q) !== "",
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
      ? or(
          gt(rank, after.rank),
          and(eq(rank, after.rank), gt(name, after.name)),
          and(
            eq(rank, after.rank),
            eq(name, after.name),
            gt(schema.contacts.id, after.id),
          ),
        )
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

export async function searchSelection(
  db: DirectoryDatabase,
  search: Search,
): Promise<SearchSelection> {
  const normalized = normalizeName(search.q);
  const number = normalizePhone(search.q);
  const clauses: SQL[] = [];
  if (search.prefecture)
    clauses.push(eq(schema.contacts.prefecture, search.prefecture));
  if (search.municipality)
    clauses.push(eq(schema.contacts.municipality, search.municipality));
  if (search.category)
    clauses.push(eq(schema.contacts.category, search.category));
  if (normalized) {
    if (number.ok) {
      clauses.push(
        sql`${schema.contacts.rowid} IN (SELECT contact_rowid FROM phones WHERE number = ${number.value})`,
      );
    } else {
      const tokens = nameTokens(normalized);
      const bigrams = tokens.filter((term) => term.includes("x"));
      const candidates = (bigrams.length ? bigrams : tokens).slice(
        0,
        nameCandidateLimit,
      );
      if (candidates.length) {
        const termList = sql.join(
          candidates.map((term) => sql`${term}`),
          sql`, `,
        );
        const rarest = await db.get<{ term: string }>(
          sql`SELECT term FROM search_vocabulary WHERE term IN (${termList}) ORDER BY doc, term LIMIT 1`,
        );
        const term = rarest?.term ?? candidates[0];
        if (term)
          clauses.push(
            sql`${schema.contacts.rowid} IN (SELECT rowid FROM contact_search WHERE contact_search MATCH ${term})`,
          );
      }
      clauses.push(
        sql`instr(${schema.contacts.normalizedName}, ${normalized}) > 0`,
      );
    }
  }
  const condition = and(...clauses);
  const ranked = normalized !== "" && !number.ok;
  const rank = ranked
    ? sql<number>`CASE WHEN ${schema.contacts.normalizedName} = ${normalized} THEN 0 WHEN instr(${schema.contacts.normalizedName}, ${normalized}) = 1 THEN 1 ELSE 2 END`
    : sql<number>`CAST(0 AS INTEGER)`;
  return { condition, rank, ranked };
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
): Promise<GroupRow[]> {
  const { condition, rank } = await searchSelection(db, search);
  const raw: unknown = await db.all(sql`
    WITH candidates AS (
      SELECT rowid, category, id, normalized_name AS name,
        ${rank} AS rank,
        count(*) OVER (PARTITION BY category) AS total,
        row_number() OVER (
          PARTITION BY category ORDER BY ${rank}, normalized_name, id
        ) AS position
      FROM contacts WHERE ${condition ?? sql`1`}
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
      normalizeName(search.q) !== "",
      search.prefecture !== "",
      search.municipality !== "",
      false,
    ) === "directory" &&
    populated.length > 0 &&
    boundedLimit(populated.length + 1);
  const rows = indexed
    ? await indexedPreviewRows(db, populated, previewLimit(search.limit))
    : await rankedPreviewRows(db, search);
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
