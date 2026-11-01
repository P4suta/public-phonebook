import type { DatabaseSync } from "node:sqlite";
import { type BrotliOptions, brotliCompressSync, constants } from "node:zlib";
import * as v from "valibot";
import {
  encodeSearchIndex,
  type SearchIndexInput,
  type SearchIndexRow,
  searchIndexRow,
} from "../src/core/search-index.ts";

const searchIndexQuality = 11;
const searchIndexWindowBits = 24;

const ContactRowSchema = v.object({
  rowid: v.number(),
  name: v.string(),
  normalized_name: v.string(),
  category: v.string(),
  prefecture: v.string(),
  municipality: v.nullable(v.string()),
  payload: v.string(),
});
const PayloadPhonesSchema = v.object({
  phones: v.array(v.object({ e164: v.string() })),
});

export function searchIndexCompression(bytes: number): BrotliOptions {
  return {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
      [constants.BROTLI_PARAM_QUALITY]: searchIndexQuality,
      [constants.BROTLI_PARAM_LGWIN]: searchIndexWindowBits,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes,
    },
  };
}

export function compressSearchIndex(bytes: Uint8Array): Uint8Array {
  return brotliCompressSync(bytes, searchIndexCompression(bytes.byteLength));
}

function* databaseRows(db: DatabaseSync): Generator<SearchIndexRow> {
  let position = 0;
  for (const value of db
    .prepare(
      "SELECT rowid, name, normalized_name, category, prefecture, municipality, payload FROM contacts ORDER BY rowid",
    )
    .iterate()) {
    const row = v.parse(ContactRowSchema, value);
    position += 1;
    if (row.rowid !== position)
      throw new Error("Contact row numbers must count from one without gaps");
    const decoded: unknown = JSON.parse(row.payload);
    yield searchIndexRow(
      {
        name: row.name,
        category: row.category,
        prefectureCode: row.prefecture,
        municipalityCode: row.municipality,
        phones: v.parse(PayloadPhonesSchema, decoded).phones,
      },
      row.normalized_name,
    );
  }
}

export function readSearchIndex(
  db: DatabaseSync,
  input: SearchIndexInput,
): Uint8Array {
  return encodeSearchIndex(databaseRows(db), input);
}

export function checkRowOrder(db: DatabaseSync): void {
  const result = v.parse(
    v.object({ misplaced: v.number() }),
    db
      .prepare(
        "SELECT count(*) AS misplaced FROM (SELECT rowid, row_number() OVER (ORDER BY normalized_name, id) AS position FROM contacts) WHERE rowid != position",
      )
      .get(),
  );
  if (result.misplaced !== 0)
    throw new Error(
      "Contact row numbers must follow the normalized name and identifier order",
    );
}
