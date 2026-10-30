import type { Category } from "../../src/core/catalog.ts";

const publicFacilities = [
  [/教育委員会$/u, "education_board"],
  [/(?:精神保健福祉センター|こころの健康センター)$/u, "mental_health_center"],
  [/(?:保健所|保健支所)$/u, "health_center"],
  [
    /(?:消防本部|消防局|消防署|消防分署|消防出張所|消防分遣所)$/u,
    "fire_department",
  ],
  [/(?:警察署|交番|駐在所|警察官連絡所)$/u, "police_station"],
  [
    /(?:公民館|市民センター|地区センター|地域センター|コミュニティセンター|コミュニティ会館)$/u,
    "community_center",
  ],
  [
    /(?:体育館|運動場|陸上競技場|野球場|球場|テニスコート|スポーツセンター|スポーツプラザ|プール|武道館|武道場|柔剣道場|弓道場|競技場|スケート場|庭球場)$/u,
    "sports_facility",
  ],
  [
    /(?:文化会館|文化センター|市民会館|市民文化センター|市民ホール|音楽ホール|文化ホール|芸術劇場|公会堂)$/u,
    "cultural_hall",
  ],
  [
    /(?:観光案内所|観光案内センター|観光交流センター|ツーリストインフォメーションセンター)$/u,
    "tourist_information",
  ],
  [/(?:旅券事務所|パスポートセンター|旅券センター)$/u, "passport_office"],
  [
    /(?:出入国在留管理局|出入国在留管理局.*出張所|入国管理局.*出張所)$/u,
    "immigration_office",
  ],
  [/(?:裁判所|裁判所.*支部|裁判所.*出張所)$/u, "court"],
  [/(?:税関|税関.*支署|税関.*出張所)$/u, "customs"],
  [
    /(?:男女共同参画センター|男女共同参画推進センター|男女共同参画交流センター)$/u,
    "gender_equality_center",
  ],
  [
    /(?:配偶者暴力相談支援センター|女性相談支援センター)$/u,
    "domestic_violence_support",
  ],
  [
    /(?:こども家庭センター|子ども家庭支援センター|子育て支援センター|地域子育て支援拠点)$/u,
    "child_family_support",
  ],
  [
    /(?:職業能力開発校|高等技術専門校|高等技術学校|職業能力開発促進センター)$/u,
    "vocational_training",
  ],
  [
    /(?:よろず支援拠点|商工会議所|商工会|産業支援センター|中小企業支援センター)$/u,
    "business_support",
  ],
] as const satisfies readonly (readonly [RegExp, Category])[];

export function classifyPublicFacility(name: string): Category | null {
  const normalized = name.normalize("NFKC").replace(/\s/gu, "");
  return (
    publicFacilities.find(([pattern]) => pattern.test(normalized))?.[1] ?? null
  );
}
