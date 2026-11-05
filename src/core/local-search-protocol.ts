import * as v from "valibot";
import { CategorySchema } from "./catalog.ts";
import {
  SearchIndexLocationSchema,
  SearchRankingLocationSchema,
} from "./dataset-storage.ts";
import { CountSchema, TextSchema } from "./models.ts";
import { SearchIndexHeaderSchema } from "./search-index.ts";

const RequestIdSchema = CountSchema;
const LocalCategorySchema = v.optional(
  v.union([CategorySchema, v.literal("")]),
  "",
);
export const indexProgressSteps = 20;

export const LocalSearchRequestSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("load"),
    index: SearchIndexLocationSchema,
    ranking: SearchRankingLocationSchema,
  }),
  v.strictObject({
    type: v.literal("search"),
    id: RequestIdSchema,
    query: v.string(),
    category: LocalCategorySchema,
  }),
  v.strictObject({
    type: v.literal("continue"),
    id: RequestIdSchema,
    query: v.string(),
    category: LocalCategorySchema,
    visible: CountSchema,
  }),
]);
export type LocalSearchRequest = v.InferOutput<typeof LocalSearchRequestSchema>;

export const LocalRowSchema = v.strictObject({
  row: CountSchema,
  name: TextSchema,
  category: CategorySchema,
  region: v.string(),
  phones: v.array(v.string()),
  hasAddress: v.boolean(),
  score: v.optional(v.pipe(CountSchema, v.maxValue(1_000_000))),
});
export type LocalRow = v.InferOutput<typeof LocalRowSchema>;

export const IndexUnavailableSchema = v.picklist([
  "fetch_failed",
  "length_mismatch",
  "digest_mismatch",
  "signature_mismatch",
  "malformed",
  "snapshot_mismatch",
  "transport_mismatch",
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
    type: v.literal("progress"),
    received: CountSchema,
    total: CountSchema,
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
    rows: v.array(LocalRowSchema),
  }),
  v.strictObject({
    type: v.literal("page"),
    id: RequestIdSchema,
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
