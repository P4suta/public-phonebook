import * as v from "valibot";
import source from "../../ios/Sources/PhonebookKit/PlaceReadings.json" with {
  type: "json",
};
import { searchForm } from "./search-text.ts";

const KanaSchema = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(128),
  v.regex(/^[ァ-ヶー]+$/u),
);

export const PlaceReadingsSchema = v.strictObject({
  prefectures: v.pipe(
    v.array(v.tuple([v.pipe(v.string(), v.nonEmpty()), KanaSchema])),
    v.length(47),
  ),
  categories: v.record(
    v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/u)),
    v.pipe(v.array(KanaSchema), v.minLength(1), v.maxLength(8)),
  ),
});

const checked = v.parse(PlaceReadingsSchema, source);
const prefectures = checked.prefectures.map(([, kana], position) => ({
  code: String(position + 1).padStart(2, "0"),
  form: searchForm(kana),
}));
const categories = Object.entries(checked.categories).map(([id, readings]) => ({
  id,
  forms: readings.map(searchForm),
}));

export interface ReadingPlaces {
  readonly prefectures: readonly string[];
  readonly categories: readonly string[];
}

export function readingPlaces(word: string): ReadingPlaces {
  if (!/^[ぁ-ゖゝゞ-]{2,}$/u.test(word) || !/[ぁ-ゖゝゞ]/u.test(word))
    return { prefectures: [], categories: [] };
  return {
    prefectures: prefectures
      .filter(({ form }) => form.startsWith(word))
      .map(({ code }) => code),
    categories: categories
      .filter(({ forms }) => forms.some((form) => form.startsWith(word)))
      .map(({ id }) => id)
      .sort(),
  };
}
