import { and, asc, count, eq, gt, or, type SQL, sql } from "drizzle-orm";
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
  decodeCursor,
  encodeCursor,
  nameRankValues,
  nameTokens,
  normalizeName,
  type Search,
  searchKey,
} from "../core/search.ts";
import { cursorDecision, previewLimit } from "../core/search-policy.ts";
import * as schema from "./schema.ts";

const nameCandidateLimit = 48;

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
  const { condition, rank } = await searchSelection(db, search);
  const totals = await db
    .select({ total: count() })
    .from(schema.contacts)
    .where(condition)
    .get();
  const total = totals?.total ?? 0;
  const continuation = after
    ? or(
        gt(rank, after.rank),
        and(
          eq(rank, after.rank),
          gt(schema.contacts.normalizedName, after.name),
        ),
        and(
          eq(rank, after.rank),
          eq(schema.contacts.normalizedName, after.name),
          gt(schema.contacts.id, after.id),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      id: schema.contacts.id,
      name: schema.contacts.normalizedName,
      rank,
      payload: schema.contacts.payload,
    })
    .from(schema.contacts)
    .where(and(condition, continuation))
    .orderBy(
      asc(rank),
      asc(schema.contacts.normalizedName),
      asc(schema.contacts.id),
    )
    .limit(search.limit + 1);
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

async function searchSelection(
  db: DirectoryDatabase,
  search: Search,
): Promise<{
  readonly condition: SQL | undefined;
  readonly rank: SQL<number>;
}> {
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
  const rank =
    normalized && !number.ok
      ? sql<number>`CASE WHEN ${schema.contacts.normalizedName} = ${normalized} THEN 0 WHEN instr(${schema.contacts.normalizedName}, ${normalized}) = 1 THEN 1 ELSE 2 END`
      : sql<number>`CAST(0 AS INTEGER)`;
  return { condition, rank };
}

const GroupRowSchema = v.strictObject({
  category: CategorySchema,
  total: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  id: v.string(),
  name: v.string(),
  rank: v.picklist(nameRankValues),
  payload: v.string(),
});

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
  const rows = v.parse(v.array(GroupRowSchema), raw);
  const byCategory = new Map<string, v.InferOutput<typeof GroupRowSchema>[]>();
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
