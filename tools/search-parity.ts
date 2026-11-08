import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { brotliDecompressSync } from "node:zlib";
import * as v from "valibot";
import { type Category, CategorySchema } from "../src/core/catalog.ts";
import { PreparedDatasetManifestSchema } from "../src/core/dataset-storage.ts";
import { environments } from "../src/core/environment.ts";
import {
  localQuery,
  matchIndex,
  previewGroups,
} from "../src/core/local-search.ts";
import type { LocalRow } from "../src/core/local-search-protocol.ts";
import {
  CatalogSchema,
  type Contact,
  GroupedSearchResponseSchema,
  RowLocationSchema,
  type SearchResponse,
  SearchResponseSchema,
} from "../src/core/models.ts";
import { formatPhone, normalizePhone } from "../src/core/phone.ts";
import { showsAddress } from "../src/core/search.ts";
import {
  decodeLiteralSearchIndex,
  type SearchIndex,
  searchIndexFile,
} from "../src/core/search-index.ts";
import { api, type DirectoryApiBindings } from "../src/server/api.ts";
import { localRow as indexRow } from "../src/ui/local-search-service.ts";
import { localDataRuntime } from "./local-data.ts";

const commandArgumentOffset = 2;
const defaultState = ".local/state";
const defaultOutput = ".local/search-parity.json";
const paritySeed = 0x5eed_2026;
export interface ParityCounts {
  readonly substrings: number;
  readonly names: number;
  readonly numbers: number;
  readonly absent: number;
  readonly places: number;
}

export const parityCounts: ParityCounts = {
  substrings: 2000,
  names: 1000,
  numbers: 1000,
  absent: 200,
  places: 500,
};
const deepLimit = 100;
const previewSize = 3;

export interface PortRetry {
  readonly attempts: number;
  readonly waitMs: number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** macOS keeps a closed loopback socket for 30 seconds, so 60 one-second waits outlast one full TIME_WAIT period. */
const portRetryAttempts = 60;
const portRetryWaitMs = 1000;

export const portRetry: PortRetry = {
  attempts: portRetryAttempts,
  waitMs: portRetryWaitMs,
  sleep: async (milliseconds) => {
    await new Promise((done) => setTimeout(done, milliseconds));
  },
};

/** Whether an error, or one of its causes, reports that no ephemeral port was free for Miniflare's loopback connection. */
export function isPortExhaustion(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if ("code" in current && current.code === "EADDRNOTAVAIL") return true;
    if (current.message.includes("EADDRNOTAVAIL")) return true;
  }
  return false;
}

/** Repeats an idempotent read after port exhaustion, and lets every other error through at once. */
export async function retryPortExhaustion<T>(
  read: () => Promise<T>,
  retry: PortRetry = portRetry,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!isPortExhaustion(error) || attempt >= retry.attempts) throw error;
      await retry.sleep(retry.waitMs);
    }
  }
}

function statementObject(value: unknown): object {
  if (typeof value !== "object" || value === null)
    throw new Error("The D1 binding returned no statement");
  return value;
}

/** Wraps a D1 binding so that each statement's reads and each batch repeat after port exhaustion. */
export function retryingDatabase<T extends object>(
  database: T,
  retry: PortRetry = portRetry,
): T {
  const statement = (value: object): object =>
    new Proxy(value, {
      get(target, property): unknown {
        const member: unknown = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        if (property === "bind")
          return (...args: unknown[]): object =>
            statement(statementObject(Reflect.apply(member, target, args)));
        return async (...args: unknown[]): Promise<unknown> =>
          retryPortExhaustion(async (): Promise<unknown> => {
            const result: unknown = Reflect.apply(member, target, args);
            return result;
          }, retry);
      },
    });
  return new Proxy(database, {
    get(target, property): unknown {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      if (property === "prepare")
        return (...args: unknown[]): object =>
          statement(statementObject(Reflect.apply(member, target, args)));
      if (property === "batch")
        return async (...args: unknown[]): Promise<unknown> =>
          retryPortExhaustion(async (): Promise<unknown> => {
            const result: unknown = Reflect.apply(member, target, args);
            return result;
          }, retry);
      return (...args: unknown[]): unknown =>
        Reflect.apply(member, target, args);
    },
  });
}
const exampleLimit = 20;
const swappedPairs = 50;
const placeKinds = 3;
const prefectureCodeWidth = 2;
const rowLocatorSamples = 100;
const progressInterval = 500;
const longestSubstring = 6;
const countryPrefix = "+81";
const trunkPrefix = "0";
const uint32Range = 4_294_967_296;
const prngIncrement = 0x6d2b79f5;
const prngShiftA = 15;
const prngShiftB = 7;
const prngShiftC = 14;
const prngMultiplierA = 1;
const prngMultiplierB = 61;
const landlineDigits = 9;
const mobilePrefixes = ["090", "080", "070"] as const;
const mobileDigits = 8;
const mobileShare = 0.5;
const spellings = 2;
const fullWidthOffset = 0xfee0;
const pairWidth = 2;
const jsonIndentation = 2;
const decimalBase = 10;

/** A row as a result card shows it, tied to the contact ID that its detail link resolves to. */
export interface ComparedRow {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly region: string;
  readonly phones: readonly string[];
  readonly hasAddress: boolean;
}

export interface ComparedGroup {
  readonly category: string;
  readonly total: number;
  readonly rows: readonly ComparedRow[];
}

export interface ComparedResults {
  readonly total: number;
  readonly groups: readonly ComparedGroup[];
}

export interface Difference {
  readonly query: string;
  readonly path: string;
  readonly server: unknown;
  readonly local: unknown;
}

export interface ParityQueries {
  readonly substrings: readonly string[];
  readonly names: readonly string[];
  readonly numbers: readonly string[];
  readonly absent: readonly string[];
  readonly places: readonly string[];
}

/** Mulberry32, a small seeded generator, so a run repeats exactly. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + prngIncrement) >>> 0;
    let value = Math.imul(
      state ^ (state >>> prngShiftA),
      prngMultiplierA | state,
    );
    value ^=
      value +
      Math.imul(value ^ (value >>> prngShiftB), prngMultiplierB | value);
    return ((value ^ (value >>> prngShiftC)) >>> 0) / uint32Range;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("A parity sample needs items");
  return item;
}

function e164(national: string): string {
  return `${countryPrefix}${national.slice(trunkPrefix.length)}`;
}

/** The spellings a listed number takes in the parity queries, from its formatted form. */
export const numberSpellings: readonly ((
  formatted: string,
  national: string,
) => string)[] = [
  (formatted) => formatted,
  (_, national) => national,
  (formatted) =>
    formatted.replace(/[0-9-]/gu, (character) =>
      String.fromCodePoint((character.codePointAt(0) ?? 0) + fullWidthOffset),
    ),
  (formatted) => {
    const [area = "", ...rest] = formatted.split("-");
    return rest.length ? `(${area}) ${rest.join("-")}` : `(${area})`;
  },
  (formatted) => `${countryPrefix} ${formatted.slice(trunkPrefix.length)}`,
];

function numberSpelling(national: string, spelling: number): string {
  const spell = numberSpellings[spelling];
  if (!spell) throw new Error("A number spelling is missing");
  return spell(formatPhone(e164(national)), national);
}

function digits(count: number, random: () => number): string {
  return Array.from({ length: count }, () =>
    String(Math.floor(random() * decimalBase)),
  ).join("");
}

/** Draws the release gate's queries from the index: substrings and full display names, listed numbers, and valid numbers that no row lists. */
export function parityQueries(
  index: SearchIndex,
  seed: number = paritySeed,
  counts: ParityCounts = parityCounts,
): ParityQueries {
  const random = seededRandom(seed);
  const { rows } = index;
  const listed = new Set(rows.flatMap((row) => row.phones));
  const substrings: string[] = [];
  while (substrings.length < counts.substrings) {
    const characters = Array.from(pick(rows, random).name);
    const length =
      1 + Math.floor(random() * Math.min(longestSubstring, characters.length));
    const start = Math.floor(random() * (characters.length - length + 1));
    const text = characters.slice(start, start + length).join("");
    const parsed = localQuery(text);
    if (parsed.ok && parsed.value.kind === "words") substrings.push(text);
  }
  const names = Array.from(
    { length: counts.names },
    () => pick(rows, random).name,
  );
  const numbers = Array.from({ length: counts.numbers }, (_, position) => {
    const national = pick(pick(rows, random).phones, random);
    return numberSpelling(national, position % numberSpellings.length);
  });
  const absent: string[] = [];
  while (absent.length < counts.absent) {
    const national =
      random() < mobileShare
        ? `${pick(mobilePrefixes, random)}${digits(mobileDigits, random)}`
        : `${trunkPrefix}${1 + Math.floor(random() * (decimalBase - 1))}${digits(landlineDigits - 1, random)}`;
    if (!listed.has(national) && normalizePhone(national).ok)
      absent.push(national);
  }
  const places = Array.from({ length: counts.places }, (_, position) => {
    const row = pick(rows, random);
    const characters = Array.from(row.name);
    const fragment = characters
      .slice(0, 1 + Math.floor(random() * characters.length))
      .join("");
    const prefecture = index.header.prefectures.find(
      (item) => item.code === row.region.slice(0, prefectureCodeWidth),
    )?.name;
    const municipality = index.header.municipalities.find(
      (item) => item.code === row.region,
    )?.name;
    const category = index.header.categories.find(
      (item) => item.id === row.category,
    )?.label;
    const place =
      [municipality, prefecture, category][position % placeKinds] ??
      category ??
      "";
    return position % spellings === 0
      ? `${place}　${fragment}`
      : `${fragment} ${place}`;
  });
  const readingQueries = [
    "とうきょう",
    "としょかん",
    "とうきょう としょかん",
    "ﾄｼｮｶﾝ",
    "びょういん",
    "やくしょ",
    "ふく",
    "と",
    "としょこ",
  ];
  for (
    let position = 0;
    position < Math.min(places.length, readingQueries.length);
    position++
  ) {
    const query = readingQueries[position];
    if (query !== undefined) places[position] = query;
  }
  return { substrings, names, numbers, absent, places };
}

function rowsDiffer(left: ComparedRow, right: ComparedRow): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function compareRows(
  query: string,
  path: string,
  server: readonly ComparedRow[],
  local: readonly ComparedRow[],
): Difference[] {
  if (server.length !== local.length)
    return [
      {
        query,
        path: `${path}.length`,
        server: server.length,
        local: local.length,
      },
    ];
  return server.flatMap((row, position) => {
    const other = local[position];
    return other && rowsDiffer(row, other)
      ? [{ query, path: `${path}[${position}]`, server: row, local: other }]
      : [];
  });
}

/** Lists every way the device's grouped preview differs from the server's for one query. */
export function compareResults(
  query: string,
  server: ComparedResults,
  local: ComparedResults,
): Difference[] {
  const differences: Difference[] = [];
  if (server.total !== local.total)
    differences.push({
      query,
      path: "total",
      server: server.total,
      local: local.total,
    });
  const serverOrder = server.groups.map((group) => group.category);
  const localOrder = local.groups.map((group) => group.category);
  if (serverOrder.join(",") !== localOrder.join(","))
    differences.push({
      query,
      path: "categories",
      server: serverOrder,
      local: localOrder,
    });
  for (const [position, group] of server.groups.entries()) {
    const other = local.groups[position];
    if (other?.category !== group.category) continue;
    if (group.total !== other.total)
      differences.push({
        query,
        path: `groups[${position}].total`,
        server: group.total,
        local: other.total,
      });
    differences.push(
      ...compareRows(query, `groups[${position}].rows`, group.rows, other.rows),
    );
  }
  return differences;
}

/** Moves the second preview row ahead of the first, the smallest ranking defect the comparison must catch. */
export function reorderPreviews(results: ComparedResults): ComparedResults {
  return {
    ...results,
    groups: results.groups.map((group) => {
      const [first, second, ...rest] = group.rows;
      return first && second
        ? { ...group, rows: [second, first, ...rest] }
        : group;
    }),
  };
}

/** Swaps adjacent rows that share a normalized name but show different details, as a defective index build would. */
export function swapSameNameRows(
  index: SearchIndex,
  limit: number,
): { readonly index: SearchIndex; readonly names: readonly string[] } {
  const rows = [...index.rows];
  const names: string[] = [];
  for (let position = 0; position + 1 < rows.length && names.length < limit; ) {
    const left = rows[position];
    const right = rows[position + 1];
    if (
      left &&
      right &&
      left.normalizedName === right.normalizedName &&
      (left.category !== right.category ||
        left.region !== right.region ||
        left.phones.join(" ") !== right.phones.join(" "))
    ) {
      rows[position] = right;
      rows[position + 1] = left;
      names.push(left.name);
      position += pairWidth;
    } else position += 1;
  }
  return { index: { header: index.header, rows }, names };
}

function serverRow(contact: Contact): ComparedRow {
  return {
    id: contact.id,
    name: contact.name,
    category: contact.category,
    region: contact.municipalityCode ?? contact.prefectureCode,
    phones: contact.phones.map(
      (phone) => `${trunkPrefix}${phone.e164.slice(countryPrefix.length)}`,
    ),
    hasAddress: showsAddress(contact.address),
  };
}

function localRow(row: LocalRow, ids: readonly string[]): ComparedRow {
  return {
    id: ids[row.row] ?? `missing row ${row.row}`,
    name: row.name,
    category: row.category,
    region: row.region,
    phones: row.phones,
    hasAddress: row.hasAddress,
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRowIds(database: string): string[] {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM contacts ORDER BY rowid")
      .all()
      .map((row) => v.parse(v.object({ id: v.string() }), row).id);
  } finally {
    db.close();
  }
}

class ServerSearch {
  readonly #bindings: DirectoryApiBindings;

  constructor(bindings: DirectoryApiBindings) {
    this.#bindings = bindings;
  }

  async json(path: string): Promise<unknown> {
    const response = await api.fetch(
      new Request(new URL(path, environments.development.origin)),
      this.#bindings,
    );
    if (!response.ok)
      throw new Error(`The server answered ${response.status} for ${path}`);
    return response.json();
  }

  async preview(query: string): Promise<ComparedResults> {
    const response = v.parse(
      GroupedSearchResponseSchema,
      await this.json(
        `/api/contact-groups?${new URLSearchParams({ q: query })}`,
      ),
    );
    return {
      total: response.meta.total,
      groups: response.groups.map((group) => ({
        category: group.category,
        total: group.results.meta.total,
        rows: group.results.data.map(serverRow),
      })),
    };
  }

  /** Follows the server's continuation links at the site's page size, as the website does. */
  async category(query: string, category: Category): Promise<ComparedRow[]> {
    const rows: ComparedRow[] = [];
    let path: string | null =
      `/api/contacts?${new URLSearchParams({ q: query, category })}`;
    while (path) {
      const page: SearchResponse = v.parse(
        SearchResponseSchema,
        await this.json(path),
      );
      rows.push(...page.data.map(serverRow));
      const next = page.links.next ? new URL(page.links.next) : null;
      path = next ? `${next.pathname}${next.search}` : null;
    }
    return rows;
  }
}

class LiteralReference {
  readonly #index: SearchIndex;
  readonly #ids: readonly string[];

  constructor(index: SearchIndex, ids: readonly string[]) {
    this.#index = index;
    this.#ids = ids;
  }

  preview(query: string): ComparedResults {
    return previewOf(this.#index, query, this.#ids);
  }

  category(query: string, category: Category): ComparedRow[] {
    const parsed = localQuery(query);
    if (!parsed.ok) throw new Error(`A reference query is invalid: ${query}`);
    const matches = matchIndex(this.#index, parsed.value);
    return (
      matches.categories.find((group) => group.category === category)?.rows ??
      []
    ).map((row) => localRow(indexRow(this.#index, row), this.#ids));
  }
}

function previewOf(
  index: SearchIndex,
  query: string,
  ids: readonly string[],
): ComparedResults {
  const parsed = localQuery(query);
  if (!parsed.ok) throw new Error(`A control query is invalid: ${query}`);
  const results = previewGroups(matchIndex(index, parsed.value));
  return {
    total: results.total,
    groups: results.groups.map((group) => ({
      category: group.category,
      total: group.total,
      rows: group.rows.slice(0, previewSize).map((position) => {
        const row = index.rows[position];
        if (!row) throw new Error("A control row is out of range");
        return localRow(
          {
            row: position,
            name: row.name,
            category: row.category,
            region: row.region,
            phones: [...row.phones],
            hasAddress: row.hasAddress,
          },
          ids,
        );
      }),
    })),
  };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(commandArgumentOffset),
    allowPositionals: true,
    options: { state: { type: "string" }, output: { type: "string" } },
  });
  const [bundle, ...extra] = positionals;
  if (!bundle || extra.length)
    throw new Error(
      "Usage: node tools/search-parity.ts BUNDLE [--state DIRECTORY] [--output FILE]",
    );
  const started = performance.now();
  const directory = resolve(bundle);
  const manifestText: unknown = JSON.parse(
    await readFile(join(directory, "manifest.ready.json"), "utf8"),
  );
  const manifest = v.parse(PreparedDatasetManifestSchema, manifestText);
  const compressed = await readFile(join(directory, searchIndexFile));
  if (
    compressed.byteLength !== manifest.searchIndex.bytes ||
    sha256(compressed) !== manifest.searchIndex.sha256
  )
    throw new Error("The bundle's search index differs from its manifest");
  const decoded = new Uint8Array(brotliDecompressSync(compressed));
  if (
    decoded.byteLength !== manifest.searchIndex.uncompressedBytes ||
    sha256(decoded) !== manifest.searchIndex.uncompressedSha256
  )
    throw new Error("The decoded search index differs from its manifest");
  const ids = readRowIds(join(directory, "directory.sqlite"));
  if (ids.length !== manifest.contacts)
    throw new Error("The bundle database has a different contact count");
  const index = decodeLiteralSearchIndex(decoded);
  const reference = new LiteralReference(index, ids);
  const runtime = localDataRuntime(values.state ?? defaultState);
  try {
    const server = new ServerSearch({
      DB: retryingDatabase(await runtime.getD1Database("DB")),
      DATASETS: {
        get: async (): Promise<null> => null,
        head: async (): Promise<null> => null,
      },
      APP_ENV: "development",
      PUBLIC_ORIGIN: environments.development.origin,
    });
    const catalog = v.parse(CatalogSchema, await server.json("/api/catalog"));
    if (catalog.snapshot !== manifest.snapshot)
      throw new Error(
        `The local server holds snapshot ${catalog.snapshot}; seed this bundle with just data-local first`,
      );
    const random = seededRandom(paritySeed);
    const rowLocatorMismatches: number[] = [];
    for (let sample = 0; sample < rowLocatorSamples; sample += 1) {
      const row = Math.floor(random() * ids.length);
      const located = v.parse(
        RowLocationSchema,
        await server.json(`/api/contacts/row/${manifest.snapshot}/${row}`),
      );
      if (located.id !== ids[row]) rowLocatorMismatches.push(row);
    }
    const queries = parityQueries(index);
    const all = [
      ...queries.substrings,
      ...queries.names,
      ...queries.numbers,
      ...queries.absent,
      ...queries.places,
    ];
    const differences: Difference[] = [];
    const compared: {
      readonly server: ComparedResults;
      readonly local: ComparedResults;
      readonly query: string;
    }[] = [];
    let deepCompared = 0;
    for (const [position, query] of all.entries()) {
      const serverResults = await server.preview(query);
      const localResults = reference.preview(query);
      compared.push({ query, server: serverResults, local: localResults });
      differences.push(...compareResults(query, serverResults, localResults));
      const deep = serverResults.groups.find(
        (group) => group.total > previewSize && group.total <= deepLimit,
      );
      if (deep) {
        const category = v.parse(CategorySchema, deep.category);
        differences.push(
          ...compareRows(
            query,
            `category ${category}`,
            await server.category(query, category),
            reference.category(query, category),
          ),
        );
        deepCompared += 1;
      }
      if ((position + 1) % progressInterval === 0)
        console.info(
          JSON.stringify({
            operation: "search-parity.progress",
            compared: position + 1,
            of: all.length,
            differences: differences.length,
          }),
        );
    }
    const absentMatches = compared
      .filter(({ query }) => queries.absent.includes(query))
      .filter(({ server: results }) => results.total > 0).length;
    // Every spelling of a listed number must read as that number and find at least its own contact.
    const unreadNumbers = queries.numbers.filter((query) => {
      const parsed = localQuery(query);
      return !parsed.ok || parsed.value.kind !== "telephone";
    }).length;
    const unmatchedNumbers = compared
      .filter(({ query }) => queries.numbers.includes(query))
      .filter(({ server: results }) => results.total === 0).length;
    const reordered = compared.reduce(
      (count, { query, server: results, local }) =>
        count + compareResults(query, results, reorderPreviews(local)).length,
      0,
    );
    const swapped = swapSameNameRows(index, swappedPairs);
    let swappedDifferences = 0;
    for (const name of swapped.names)
      swappedDifferences += compareResults(
        name,
        await server.preview(name),
        previewOf(swapped.index, name, ids),
      ).length;
    const report = {
      operation: "search-parity",
      contract: "server-literal-reference",
      snapshot: manifest.snapshot,
      contacts: manifest.contacts,
      seed: paritySeed,
      queries: {
        substrings: queries.substrings.length,
        names: queries.names.length,
        numbers: queries.numbers.length,
        absent: queries.absent.length,
        places: queries.places.length,
      },
      compared: compared.length,
      deepCompared,
      rowLocatorSamples,
      rowLocatorMismatches,
      absentMatches,
      unreadNumbers,
      unmatchedNumbers,
      differences: differences.length,
      examples: differences.slice(0, exampleLimit),
      controls: {
        reorderedPreviews: { differences: reordered },
        swappedSameNameRows: {
          pairs: swapped.names.length,
          differences: swappedDifferences,
        },
      },
      durationMs: Math.round(performance.now() - started),
    };
    const passed =
      differences.length === 0 &&
      rowLocatorMismatches.length === 0 &&
      absentMatches === 0 &&
      unreadNumbers === 0 &&
      unmatchedNumbers === 0 &&
      reordered > 0 &&
      swapped.names.length > 0 &&
      swappedDifferences > 0;
    const output = values.output ?? defaultOutput;
    await writeFile(
      output,
      `${JSON.stringify({ ...report, result: passed ? "passed" : "failed" }, null, jsonIndentation)}\n`,
    );
    console.info(
      JSON.stringify({
        ...report,
        examples: report.examples.length,
        output,
        result: passed ? "passed" : "failed",
      }),
    );
    if (!passed)
      throw new Error("The server search differs from its literal reference");
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) await main();
