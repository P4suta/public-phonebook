import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareUtf8 } from "../../src/core/directory-archive.ts";
import { normalizeName } from "../../src/core/identity.ts";
import {
  continueCategory,
  type LocalMatches,
  localPageSize,
  localPreviewSize,
  localQuery,
  matchIndex,
  orderedIndexRows,
  previewGroups,
  searchLocalIndex,
} from "../../src/core/local-search.ts";
import { normalizePhone } from "../../src/core/phone.ts";
import {
  decodeLiteralSearchIndex,
  decodeSearchIndex,
} from "../../src/core/search-index.ts";
import { maximumQueryWords } from "../../src/core/search-text.ts";
import {
  indexInput,
  type ModelContact,
  modelDirectory,
} from "./local-search-fixture.ts";
import {
  referenceForm,
  referenceRank,
  referenceWords,
} from "./search-reference.ts";

const snapshot = "b".repeat(64);
const maximumQueryBytes = 512;
const categories = ["library", "medical", "museum"] as const;
const phonePool = [
  "+81335812331",
  "+81338272053",
  "+81774981200",
  "+819012345678",
  "+81312345678",
  "+818312345678",
] as const;
const namePieces = [
  "図",
  "書",
  "館",
  "図書館",
  "Ａ",
  "A",
  "a",
  "ｂ",
  "B",
  "ｱ",
  "ア",
  "ｶﾞ",
  "ガ",
  "１",
  "1",
  "𠮷",
  "﨑",
  "ｰ",
  " ",
  "と",
  "ト",
  "ー",
  "-",
  "千代田",
  "東京",
] as const;
/** Words that occur in the model's region names and category labels, typed alone or beside name words. */
const placeWords = [
  "千代田",
  "東京",
  "図書館",
  "病院",
  "博物館",
  "神奈川",
  "とうきょう",
  "としょかん",
  "びょういん",
  "びじゅつかん",
] as const;
const sharedNames = [
  "図書館",
  "ﾄｼｮｶﾝ",
  "トショカン",
  "Ａ図書館",
  "a図書館",
  "市立図書館",
  "図書館分館",
  "𠮷田図書館",
  "﨑山図書館",
] as const;

const modelCatalog = indexInput(snapshot).catalog;

/** A model contact's prefecture name, municipality name, and category label. */
function modelPlaces(contact: ModelContact): string[] {
  return [
    modelCatalog.prefectures.find(
      (item) => item.code === contact.prefectureCode,
    )?.name ?? "",
    modelCatalog.municipalities.find(
      (item) => item.code === contact.municipalityCode,
    )?.name ?? "",
    modelCatalog.categories.find((item) => item.id === contact.category)
      ?.label ?? "",
  ];
}

function modelReading(contact: ModelContact, word: string): boolean {
  if (
    word.length < 2 ||
    Array.from(word).some(
      (letter) =>
        !"ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゝゞ-".includes(
          letter,
        ),
    )
  )
    return false;
  const readings: Record<string, readonly string[]> = {
    library: ["としょかん"],
    medical: ["びょういん", "しんりょうじょ", "しんりょうしょ"],
    museum: ["はくぶつかん", "びじゅつかん"],
    "13": ["とうきょうと"],
    "14": ["かながわけん"],
  };
  return [
    ...(readings[contact.category] ?? []),
    ...(readings[contact.prefectureCode] ?? []),
  ].some((reading) => reading.startsWith(word));
}

interface ReferenceGroup {
  readonly category: string;
  readonly rows: readonly number[];
}

function referenceSearch(
  contacts: readonly ModelContact[],
  input: string,
): readonly ReferenceGroup[] | "invalid_query" {
  if (
    new TextEncoder().encode(input).length > maximumQueryBytes ||
    input.includes("\0")
  )
    return "invalid_query";
  const text = input.trim();
  const phone = normalizePhone(text);
  const national = phone.ok ? `0${phone.value.slice(3)}` : null;
  const words = referenceWords(text);
  if (national === null && words.length > maximumQueryWords)
    return "invalid_query";
  if (national === null && words.length === 0) return [];
  const matched = contacts.flatMap((contact, row) => {
    const normalized = normalizeName(contact.name);
    if (national !== null)
      return contact.phones.some(
        (item) => `0${item.e164.slice(3)}` === national,
      )
        ? [{ contact, normalized, row, rank: 0 }]
        : [];
    const rank = referenceRank(
      contact.name,
      modelPlaces(contact),
      words,
      (word) => modelReading(contact, word),
    );
    return rank < 0 ? [] : [{ contact, normalized, row, rank }];
  });
  matched.sort(
    (left, right) =>
      left.rank - right.rank ||
      compareUtf8(left.normalized, right.normalized) ||
      compareUtf8(left.contact.id, right.contact.id),
  );
  const groups = new Map<string, number[]>();
  for (const item of matched)
    groups.set(item.contact.category, [
      ...(groups.get(item.contact.category) ?? []),
      item.row,
    ]);
  return [...groups].map(([category, rows]) => ({ category, rows }));
}

function localGroups(matches: LocalMatches): readonly ReferenceGroup[] {
  return matches.categories.map((item) => ({
    category: item.category,
    rows: item.rows,
  }));
}

function pages(
  matches: LocalMatches,
  category: string,
  visible: number,
): number[][] {
  const result: number[][] = [];
  let current = visible;
  for (;;) {
    const page = continueCategory(matches, category, current);
    if (!page.ok) throw new Error(page.error);
    if (page.value.rows.length === 0) return result;
    result.push([...page.value.rows]);
    current = page.value.visible;
  }
}

function chunks(rows: readonly number[], size: number): number[][] {
  const result: number[][] = [];
  for (let index = 0; index < rows.length; index += size)
    result.push(rows.slice(index, index + size));
  return result;
}

function fullWidth(text: string): string {
  return text.replace(/[0-9+]/gu, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0xfee0),
  );
}

const nameArbitrary = fc.oneof(
  fc.constantFrom(...sharedNames),
  fc
    .array(fc.constantFrom(...namePieces), { minLength: 1, maxLength: 5 })
    .map((pieces) => pieces.join(""))
    .filter((name) => normalizeName(name) !== ""),
);

const contactsArbitrary = fc
  .array(
    fc.record({
      name: nameArbitrary,
      category: fc.oneof(
        { arbitrary: fc.constant(categories[0]), weight: 4 },
        { arbitrary: fc.constantFrom(...categories.slice(1)), weight: 2 },
      ),
      municipalityCode: fc.constantFrom("13101", null),
      phones: fc.uniqueArray(fc.constantFrom(...phonePool), {
        minLength: 1,
        maxLength: 2,
      }),
    }),
    { minLength: 1, maxLength: 120, size: "max" },
  )
  .map((records) =>
    records.map(
      (record, index): ModelContact => ({
        id: `c:${String((index * 37) % 101).padStart(3, "0")}:${index}`,
        name: record.name,
        category: record.category,
        prefectureCode: "13",
        municipalityCode: record.municipalityCode,
        phones: record.phones.map((e164) => ({ e164 })),
      }),
    ),
  );

function queryArbitrary(
  contacts: readonly ModelContact[],
): fc.Arbitrary<string> {
  const contact = fc.constantFrom(...contacts);
  const padding = fc.constantFrom("", " ", "\t", "　", " \t ");
  return fc.oneof(
    fc
      .tuple(contact, fc.nat(), fc.nat(), padding, padding)
      .map(([item, start, length, before, after]) => {
        const points = Array.from(item.name);
        const from = start % points.length;
        const to = from + 1 + (length % (points.length - from));
        return `${before}${points.slice(from, to).join("")}${after}`;
      }),
    fc
      .array(fc.constantFrom(...namePieces), { minLength: 1, maxLength: 3 })
      .map((pieces) => pieces.join("")),
    fc
      .tuple(
        contact,
        fc.nat(),
        fc.constantFrom(...placeWords),
        fc.constantFrom(" ", "　", "  ", " \t"),
        fc.boolean(),
      )
      .map(([item, length, place, separator, before]) => {
        const points = Array.from(item.name);
        const fragment = points.slice(0, 1 + (length % points.length)).join("");
        return before
          ? `${place}${separator}${fragment}`
          : `${fragment}${separator}${place}`;
      }),
    fc
      .array(fc.constantFrom(...placeWords), { minLength: 1, maxLength: 3 })
      .map((words) => words.join(" ")),
    fc
      .tuple(
        contact,
        fc.constantFrom(
          (digits: string) => digits,
          (digits: string) => `0${digits.slice(3)}`,
          (digits: string) =>
            `0${digits.slice(3, 5)}-${digits.slice(5, 9)}-${digits.slice(9)}`,
          (digits: string) => fullWidth(digits),
          (digits: string) => fullWidth(`0${digits.slice(3)}`),
        ),
        padding,
      )
      .map(
        ([item, format, around]) =>
          `${around}${format(item.phones[0]?.e164 ?? "")}${around}`,
      ),
    fc.constantFrom(
      "+81399999999",
      "03-3581",
      "図\t書",
      "\t図書館\t",
      "図\0",
      "\0",
      "図".repeat(171),
      `${"図".repeat(170)}ab`,
      "",
      " \t　 ",
      "Ａ",
      "ａ",
      "TOSHO",
    ),
  );
}

describe.each([
  { storage: "materialized", decode: decodeSearchIndex },
  { storage: "compact", decode: decodeLiteralSearchIndex },
])("local search: $storage", ({ decode }) => {
  it("scans names and complete telephone tokens without decoding display rows", () => {
    const directory = modelDirectory(
      ["Ａ図書館", "北診療所", "南図書館"].map((name, row) => ({
        id: `c:${row}`,
        name,
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: row === 1 ? "+819012345678" : "+81774981200" }],
      })),
      snapshot,
    );
    const materialized = decodeSearchIndex(directory.bytes);
    const compact = decodeLiteralSearchIndex(directory.bytes);
    const { telephoneRows, ...withoutPhoneLookup } = compact;
    expect(telephoneRows).toBeTypeOf("function");
    let reads = 0;
    const rows = new Proxy(compact.rows, {
      get(target, property, receiver): unknown {
        if (typeof property === "string" && /^\d+$/u.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    for (const input of [
      "図書館",
      "東京",
      "診療所 東京",
      "0774981200",
      "0774981201",
      "",
    ]) {
      const query = localQuery(input);
      if (!query.ok) throw new Error("Expected a valid query");
      expect(matchIndex({ ...compact, rows }, query.value)).toEqual(
        matchIndex(materialized, query.value),
      );
      expect(orderedIndexRows({ ...compact, rows }, query.value)).toEqual(
        orderedIndexRows(materialized, query.value),
      );
      expect(matchIndex(withoutPhoneLookup, query.value)).toEqual(
        matchIndex(materialized, query.value),
      );
    }
    expect(reads).toBe(0);
  });

  it("matches a plain reference implementation on generated directories", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(
        contactsArbitrary.chain((contacts) =>
          fc.tuple(
            fc.constant(contacts),
            fc.array(queryArbitrary(contacts), { minLength: 1, maxLength: 8 }),
          ),
        ),
        ([contacts, queries]) => {
          const directory = modelDirectory(contacts, snapshot);
          const index = decode(directory.bytes);
          for (const query of queries) {
            const expected = referenceSearch(directory.contacts, query);
            const parsed = localQuery(query);
            const searched = searchLocalIndex(index, query);
            if (expected === "invalid_query") {
              seen.add(query.includes("\0") ? "nul" : "oversize");
              expect(parsed).toEqual({ ok: false, error: "invalid_query" });
              expect(searched).toEqual({ ok: false, error: "invalid_query" });
              continue;
            }
            if (!parsed.ok || !searched.ok)
              throw new Error(`The query must be valid: ${query}`);
            const matches = matchIndex(index, parsed.value);
            const referenceTier = (row: number): number => {
              const contact = directory.contacts[row];
              if (!contact) throw new Error("A reference contact is missing");
              return parsed.value.kind === "words"
                ? referenceRank(
                    contact.name,
                    modelPlaces(contact),
                    referenceWords(query.trim()),
                    (word) => modelReading(contact, word),
                  )
                : 0;
            };
            expect(orderedIndexRows(index, parsed.value)).toEqual(
              expected
                .flatMap((group) => group.rows)
                .sort(
                  (left, right) =>
                    referenceTier(left) - referenceTier(right) || left - right,
                ),
            );
            if (matches.total > 0) seen.add(parsed.value.kind);
            if (expected.length > 1) seen.add("groups");
            if (
              expected.some(
                (group) => group.rows.length > localPreviewSize + localPageSize,
              )
            )
              seen.add("pages");
            if (query.includes("\t") && parsed.value.kind === "words")
              seen.add("tab");
            if (parsed.value.kind === "words" && parsed.value.words.length > 1)
              seen.add("several");
            const placed = matches.categories.some((group) =>
              group.rows.some(
                (row) =>
                  parsed.value.kind === "words" &&
                  !parsed.value.words.every((word) =>
                    referenceForm(directory.contacts[row]?.name ?? "").includes(
                      word,
                    ),
                  ),
              ),
            );
            if (placed) seen.add("place");
            if (
              expected.some((group) =>
                group.rows.some(
                  (row) =>
                    directory.contacts[row]?.name !==
                    normalizeName(directory.contacts[row]?.name ?? ""),
                ),
              )
            )
              seen.add("folded");
            const exactNames = expected.flatMap((group) =>
              group.rows
                .map((row) => directory.contacts[row])
                .filter(
                  (contact) =>
                    contact !== undefined &&
                    parsed.value.kind === "words" &&
                    parsed.value.words.length === 1 &&
                    referenceForm(contact.name) === parsed.value.words[0],
                )
                .map((contact) => contact?.category),
            );
            if (new Set(exactNames).size > 1) seen.add("same-name");
            expect(localGroups(matches)).toEqual(expected);
            expect(matches.total).toBe(
              expected.reduce((sum, group) => sum + group.rows.length, 0),
            );
            expect(searched.value).toEqual(previewGroups(matches));
            for (const [position, group] of expected.entries()) {
              expect(searched.value.groups[position]).toEqual({
                category: group.category,
                total: group.rows.length,
                rows: group.rows.slice(0, localPreviewSize),
              });
              const previewed = Math.min(localPreviewSize, group.rows.length);
              expect(pages(matches, group.category, previewed)).toEqual(
                chunks(group.rows.slice(previewed), localPageSize),
              );
              expect(pages(matches, group.category, 0)).toEqual(
                chunks(group.rows, localPageSize),
              );
            }
          }
        },
      ),
      { seed: 20261101, numRuns: 400 },
    );
    expect([...seen].sort()).toEqual([
      "folded",
      "groups",
      "nul",
      "oversize",
      "pages",
      "place",
      "same-name",
      "several",
      "tab",
      "telephone",
      "words",
    ]);
  });

  it("keeps the same name apart by category and orders the tie by identifier", () => {
    const contacts: ModelContact[] = [
      ["c:2", "図書館", "library"],
      ["c:1", "図書館", "medical"],
      ["c:3", "市立図書館", "medical"],
      ["c:0", "図書館分館", "museum"],
    ].map(([id = "", name = "", category = ""]) => ({
      id,
      name,
      category,
      prefectureCode: "13",
      municipalityCode: null,
      phones: [{ e164: "+81335812331" }],
    }));
    const directory = modelDirectory(contacts, snapshot);
    const index = decode(directory.bytes);
    expect(directory.contacts.map((contact) => contact.id)).toEqual([
      "c:1",
      "c:2",
      "c:0",
      "c:3",
    ]);
    expect(searchLocalIndex(index, "図書館")).toEqual({
      ok: true,
      value: {
        total: 4,
        groups: [
          { category: "medical", total: 2, rows: [0, 3] },
          { category: "library", total: 1, rows: [1] },
          { category: "museum", total: 1, rows: [2] },
        ],
      },
    });
    expect(searchLocalIndex(index, "０３−３５８１−２３３１")).toEqual({
      ok: true,
      value: {
        total: 4,
        groups: [
          { category: "medical", total: 2, rows: [0, 3] },
          { category: "library", total: 1, rows: [1] },
          { category: "museum", total: 1, rows: [2] },
        ],
      },
    });
  });

  it("folds width and case and treats tabs, NUL, and long queries like the server", () => {
    const contacts: ModelContact[] = ["Ａ図書館", "a図書館", "ABC分室"].map(
      (name, position) => ({
        id: `c:${position}`,
        name,
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: "+81774981200" }],
      }),
    );
    const index = decode(modelDirectory(contacts, snapshot).bytes);
    const rows = (query: string): readonly number[] | string => {
      const result = searchLocalIndex(index, query);
      return result.ok
        ? result.value.groups.flatMap((group) => group.rows)
        : result.error;
    };
    expect(rows("ａ図書館")).toEqual([1, 2]);
    expect(rows("A")).toEqual([0, 1, 2]);
    expect(rows("abc")).toEqual([0]);
    expect(rows("\tａ図書館 ")).toEqual([1, 2]);
    expect(rows("a\t図書館")).toEqual([1, 2, 0]);
    expect(rows("ａ　図書館　ａ")).toEqual([1, 2, 0]);
    expect(rows("図書館 分室")).toEqual([0]);
    expect(rows("図書館\0")).toBe("invalid_query");
    expect(rows("図".repeat(171))).toBe("invalid_query");
    expect(rows(`${"図".repeat(170)}ab`)).toEqual([]);
    expect(rows(" 　\t")).toEqual([]);
    expect(localQuery("　")).toEqual({ ok: true, value: { kind: "empty" } });
    expect(localQuery("+81 774 98 1200")).toEqual({
      ok: true,
      value: { kind: "telephone", number: "0774981200" },
    });
  });

  it("rejects a continuation outside its category's matches", () => {
    const contacts: ModelContact[] = [
      {
        id: "c:0",
        name: "図書館",
        category: "library",
        prefectureCode: "13",
        municipalityCode: null,
        phones: [{ e164: "+81335812331" }],
      },
    ];
    const index = decode(modelDirectory(contacts, snapshot).bytes);
    const query = localQuery("図書館");
    if (!query.ok) throw new Error("The query must be valid");
    const matches = matchIndex(index, query.value);
    expect(continueCategory(matches, "library", 2)).toEqual({
      ok: false,
      error: "invalid_continuation",
    });
    expect(continueCategory(matches, "library", -1).ok).toBe(false);
    expect(continueCategory(matches, "library", 0.5).ok).toBe(false);
    expect(continueCategory(matches, "medical", 0)).toEqual({
      ok: true,
      value: { category: "medical", total: 0, visible: 0, rows: [] },
    });
  });
});
