import * as v from "valibot";
import { CategorySchema } from "./catalog.ts";
import { CountSchema, DigestSchema, TextSchema } from "./models.ts";
import { SearchIndexHeaderSchema } from "./search-index.ts";

const IndexPathSchema = v.pipe(v.string(), v.regex(/^\/(?![/\\])[^\\\s]*$/u));
const RequestIdSchema = CountSchema;

export const LocalSearchRequestSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("load"),
    url: IndexPathSchema,
    snapshot: DigestSchema,
    bytes: CountSchema,
    sha256: DigestSchema,
  }),
  v.strictObject({
    type: v.literal("search"),
    id: RequestIdSchema,
    query: v.string(),
  }),
  v.strictObject({
    type: v.literal("continue"),
    id: RequestIdSchema,
    query: v.string(),
    category: CategorySchema,
    visible: CountSchema,
  }),
]);
export type LocalSearchRequest = v.InferOutput<typeof LocalSearchRequestSchema>;

export const LocalRowSchema = v.strictObject({
  row: CountSchema,
  name: TextSchema,
  category: TextSchema,
  region: v.string(),
  phones: v.array(v.string()),
});
export type LocalRow = v.InferOutput<typeof LocalRowSchema>;

export const IndexUnavailableSchema = v.picklist([
  "fetch_failed",
  "length_mismatch",
  "digest_mismatch",
  "signature_mismatch",
  "malformed",
  "snapshot_mismatch",
]);
export type IndexUnavailable = v.InferOutput<typeof IndexUnavailableSchema>;

const { snapshot, contacts, categories, prefectures, municipalities } =
  SearchIndexHeaderSchema.entries;

export const LocalSearchReplySchema = v.variant("type", [
  v.strictObject({
    type: v.literal("ready"),
    snapshot,
    contacts,
    categories,
    prefectures,
    municipalities,
  }),
  v.strictObject({
    type: v.literal("unavailable"),
    reason: IndexUnavailableSchema,
    detail: v.string(),
  }),
  v.strictObject({
    type: v.literal("results"),
    id: RequestIdSchema,
    total: CountSchema,
    groups: v.array(
      v.strictObject({
        category: TextSchema,
        total: CountSchema,
        rows: v.array(LocalRowSchema),
      }),
    ),
  }),
  v.strictObject({
    type: v.literal("page"),
    id: RequestIdSchema,
    category: TextSchema,
    total: CountSchema,
    visible: CountSchema,
    rows: v.array(LocalRowSchema),
  }),
  v.strictObject({
    type: v.literal("failed"),
    id: RequestIdSchema,
    error: v.picklist(["not_ready", "invalid_query", "invalid_continuation"]),
  }),
]);
export type LocalSearchReply = v.InferOutput<typeof LocalSearchReplySchema>;
