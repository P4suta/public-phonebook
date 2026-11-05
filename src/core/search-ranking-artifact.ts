import * as v from "valibot";
import { DigestSchema } from "./models.ts";

export const rankingArtifactFile = "search-ranking.br";
export const rankingArtifactFormat = "public-phonebook-search-ranking/1";
const signature = "public-phonebook-search-ranking\t1\n";
const lineFeedByte = 10;
const varintBase = 128;
const maximumVarintMultiplier = varintBase ** 3;
export const rankingArtifactLimits = {
  contacts: 2_000_000,
  compressedBytes: 64 * 1_048_576,
  uncompressedBytes: 256 * 1_048_576,
} as const;

const NaturalSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const TextSchema = v.pipe(v.string(), v.minLength(1));
const WeightSchema = v.pipe(NaturalSchema, v.maxValue(100_000));
const PairSchema = v.tuple([TextSchema, TextSchema]);
const DictionaryEntrySchema = v.tuple([
  TextSchema,
  WeightSchema,
  NaturalSchema,
]);
const MetadataSchema = v.strictObject({
  snapshot: DigestSchema,
  contacts: v.pipe(NaturalSchema, v.maxValue(rankingArtifactLimits.contacts)),
  analyzer: v.strictObject({ engine: TextSchema, dictionary: DigestSchema }),
  readings: v.array(v.string()),
  lexicon: v.array(
    v.tuple([TextSchema, TextSchema, v.pipe(NaturalSchema, v.minValue(1))]),
  ),
  aliases: v.array(v.tuple([NaturalSchema, TextSchema])),
  variants: v.array(PairSchema),
  unknownWeight: WeightSchema,
  lexical: v.array(DictionaryEntrySchema),
  phonetic: v.array(DictionaryEntrySchema),
});

export type RankingPosting = readonly [string, number, readonly number[]];
export interface RankingArtifact {
  readonly snapshot: string;
  readonly contacts: number;
  readonly analyzer: { readonly engine: string; readonly dictionary: string };
  readonly readings: readonly string[];
  readonly lexicon: readonly (readonly [string, string, number])[];
  readonly aliases: readonly (readonly [number, string])[];
  readonly variants: readonly (readonly [string, string])[];
  readonly unknownWeight: number;
  readonly lexical: readonly RankingPosting[];
  readonly phonetic: readonly RankingPosting[];
}

function validateMetadata(
  value: unknown,
): v.InferOutput<typeof MetadataSchema> {
  const metadata = v.parse(MetadataSchema, value);
  if (metadata.readings.length !== metadata.contacts)
    throw new Error("Ranking reading count differs from the contact count");
  if (metadata.aliases.some(([row]) => row >= metadata.contacts))
    throw new Error("Ranking alias is outside the snapshot");
  const variants = new Map(metadata.variants);
  if (
    variants.size !== metadata.variants.length ||
    metadata.variants.some(
      ([from, to]) =>
        Array.from(from).length !== 1 ||
        Array.from(to).length !== 1 ||
        variants.has(to),
    )
  )
    throw new Error("Ranking variants must be single, idempotent mappings");
  for (const entries of [metadata.lexical, metadata.phonetic]) {
    const keys = new Set<string>();
    for (const [key, , count] of entries) {
      if (keys.has(key) || count === 0 || count > metadata.contacts)
        throw new Error("Invalid ranking posting dictionary");
      keys.add(key);
    }
  }
  return metadata;
}

export function encodeRankingArtifact(artifact: RankingArtifact): Uint8Array {
  const metadata = validateMetadata({
    ...artifact,
    lexical: artifact.lexical.map(([key, weight, rows]) => [
      key,
      weight,
      rows.length,
    ]),
    phonetic: artifact.phonetic.map(([key, weight, rows]) => [
      key,
      weight,
      rows.length,
    ]),
  });
  const prefix = new TextEncoder().encode(
    `${signature}${JSON.stringify(metadata)}\n`,
  );
  const postings: number[] = [];
  for (const entries of [artifact.lexical, artifact.phonetic]) {
    for (const [, , rows] of entries) {
      let previous = -1;
      for (const row of rows) {
        if (
          !Number.isSafeInteger(row) ||
          row <= previous ||
          row >= artifact.contacts
        )
          throw new Error(
            "Ranking postings must be ascending snapshot ordinals",
          );
        let delta = row - previous;
        while (delta >= varintBase) {
          postings.push((delta % varintBase) + varintBase);
          delta = Math.floor(delta / varintBase);
        }
        postings.push(delta);
        previous = row;
      }
    }
  }
  if (prefix.length + postings.length > rankingArtifactLimits.uncompressedBytes)
    throw new Error("Ranking artifact exceeds its byte limit");
  const bytes = new Uint8Array(prefix.length + postings.length);
  bytes.set(prefix);
  bytes.set(postings, prefix.length);
  return bytes;
}

export function decodeRankingArtifact(
  bytes: Uint8Array,
  snapshot: string,
  contacts: number,
): RankingArtifact {
  if (bytes.length > rankingArtifactLimits.uncompressedBytes)
    throw new Error("Ranking artifact exceeds its byte limit");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const first = bytes.indexOf(lineFeedByte);
  if (first < 0 || decoder.decode(bytes.subarray(0, first + 1)) !== signature)
    throw new Error("Unsupported ranking artifact format");
  const second = bytes.indexOf(lineFeedByte, first + 1);
  if (second < 0) throw new Error("Missing ranking artifact metadata");
  const metadata = validateMetadata(
    JSON.parse(decoder.decode(bytes.subarray(first + 1, second))),
  );
  if (metadata.snapshot !== snapshot)
    throw new Error("Ranking snapshot mismatch");
  if (metadata.contacts !== contacts)
    throw new Error("Ranking contact count mismatch");
  let offset = second + 1;
  function readPostings(
    entries: readonly (readonly [string, number, number])[],
  ): RankingPosting[] {
    return entries.map(([key, weight, count]) => {
      const rows: number[] = [];
      let previous = -1;
      for (let i = 0; i < count; i += 1) {
        let delta = 0;
        let multiplier = 1;
        for (;;) {
          const byte = bytes[offset++];
          if (byte === undefined || multiplier > maximumVarintMultiplier)
            throw new Error("Truncated or overflowing ranking varint");
          delta += (byte % varintBase) * multiplier;
          if (byte < varintBase) {
            if (multiplier > 1 && byte === 0)
              throw new Error("Noncanonical ranking varint");
            break;
          }
          multiplier *= varintBase;
        }
        const row = previous + delta;
        if (delta === 0 || row >= contacts)
          throw new Error("Ranking posting is outside the snapshot");
        rows.push(row);
        previous = row;
      }
      return [key, weight, rows];
    });
  }
  const lexical = readPostings(metadata.lexical);
  const phonetic = readPostings(metadata.phonetic);
  if (offset !== bytes.length)
    throw new Error("Trailing ranking artifact bytes");
  return { ...metadata, lexical, phonetic };
}
