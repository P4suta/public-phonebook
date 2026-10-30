import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../../src/core/address.ts";

describe("address presentation", () => {
  it.each([
    ["東京都千代田区永田町一丁目十番一号", "東京都千代田区永田町1-10-1"],
    ["北海道旭川市一条通二十五丁目487番地の六", "北海道旭川市一条通25-487-6"],
    ["北海道札幌市中央区北一条西五丁目４番地", "北海道札幌市中央区北一条西5-4"],
    ["東京都千代田区一番町1 第一号館", "東京都千代田区一番町1 第一号館"],
    [
      "〒２７２－００３３市川市市川南１－１－１ザ・タワーズ・イースト１１１",
      "市川市市川南1-1-1ザ・タワーズ・イースト111",
    ],
    ["272-0033 市川市市川南1−1−1（案内図）", "市川市市川南1-1-1"],
    ["愛知県名古屋市千種区千種三丁目２番５号", "愛知県名古屋市千種区千種3-2-5"],
    [
      "東京都千代田区一番町１ー２ ＡＢＣビル １０１号室",
      "東京都千代田区一番町1-2 ABCビル 101号室",
    ],
    [
      "京都府京都市上京区一条通三丁目３番地の４",
      "京都府京都市上京区一条通3-3-4",
    ],
    ["山梨県山梨市三日市場５５８", "山梨県山梨市三日市場558"],
    [
      "三重県四日市市西新地１－２\n﨑山ビル",
      "三重県四日市市西新地1-2 﨑山ビル",
    ],
    ["大阪市中央区一丁目", "大阪市中央区1丁目"],
    ["京都市中京区一之船入町５３７", "京都市中京区一之船入町537"],
    [
      "静岡県静岡市葵区駒形通2-4-47（本館）",
      "静岡県静岡市葵区駒形通2-4-47（本館）",
    ],
  ])("normalizes %s without rewriting named places", (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });
  it("is idempotent over mixed address text", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            "〒",
            "０",
            "１",
            "２",
            "三",
            "十",
            "丁目",
            "番地の",
            "号",
            "ー",
            "－",
            "\n",
            "市",
            "﨑",
            "町",
            "ビル",
            "一番町",
          ),
          { maxLength: 40 },
        ),
        (parts) => {
          const once = normalizeAddress(parts.join(""));
          expect(normalizeAddress(once)).toBe(once);
        },
      ),
      { seed: 20261030, numRuns: 500 },
    );
  });
});
