import * as v from "valibot";

export const categoryDefinitions = [
  {
    id: "medical",
    label: "病院・診療所",
    icon: "hospital",
  },
  {
    id: "dental",
    label: "歯医者",
    icon: "tooth",
  },
  {
    id: "pharmacy",
    label: "薬局",
    icon: "pill",
  },
  {
    id: "municipal_office",
    label: "市区町村の役所",
    icon: "landmark",
  },
  {
    id: "prefectural_office",
    label: "都道府県の役所",
    icon: "building-complex",
  },
  {
    id: "nursing_care",
    label: "介護サービス",
    icon: "hand-heart",
  },
  {
    id: "disability_support",
    label: "障害福祉サービス",
    icon: "accessibility",
  },
  {
    id: "library",
    label: "図書館",
    icon: "library-big",
  },
  {
    id: "museum",
    label: "博物館・美術館",
    icon: "gallery-thumbnails",
  },
  {
    id: "archive",
    label: "公文書館",
    icon: "archive",
  },
  {
    id: "nursery",
    label: "保育所",
    icon: "baby",
  },
  {
    id: "kindergarten",
    label: "幼稚園",
    icon: "blocks",
  },
  {
    id: "certified_child_center",
    label: "認定こども園",
    icon: "school",
  },
  {
    id: "small_scale_childcare",
    label: "小規模保育",
    icon: "house-heart",
  },
  {
    id: "workplace_childcare",
    label: "事業所内保育",
    icon: "building",
  },
  {
    id: "unlicensed_childcare",
    label: "認可外保育施設",
    icon: "house",
  },
  {
    id: "university",
    label: "大学",
    icon: "university",
  },
  {
    id: "junior_college",
    label: "短期大学",
    icon: "book-open-check",
  },
  {
    id: "technical_college",
    label: "高等専門学校",
    icon: "drafting-compass",
  },
  { id: "elementary_school", label: "小学校", icon: "pencil-ruler" },
  { id: "junior_high_school", label: "中学校", icon: "notebook-pen" },
  { id: "high_school", label: "高校", icon: "book-marked" },
  {
    id: "compulsory_education_school",
    label: "義務教育学校",
    icon: "book-open-text",
  },
  { id: "secondary_school", label: "中等教育学校", icon: "notebook-tabs" },
  {
    id: "special_needs_school",
    label: "特別支援学校",
    icon: "heart-handshake",
  },
  { id: "vocational_school", label: "専修学校", icon: "wrench" },
  { id: "miscellaneous_school", label: "各種学校", icon: "presentation" },
  { id: "education_board", label: "教育委員会", icon: "clipboard-pen" },
  { id: "health_center", label: "保健所", icon: "stethoscope" },
  {
    id: "mental_health_center",
    label: "こころの健康相談",
    icon: "brain",
  },
  {
    id: "fire_department",
    label: "消防署・消防本部",
    icon: "fire-extinguisher",
  },
  { id: "police_station", label: "警察署・交番", icon: "shield" },
  { id: "community_center", label: "公民館", icon: "house-plus" },
  { id: "sports_facility", label: "スポーツ施設", icon: "dumbbell" },
  { id: "cultural_hall", label: "文化会館・ホール", icon: "theater" },
  { id: "tourist_information", label: "観光案内所", icon: "signpost" },
  { id: "passport_office", label: "パスポートの窓口", icon: "book-user" },
  { id: "immigration_office", label: "出入国在留管理局", icon: "stamp" },
  { id: "court", label: "裁判所", icon: "gavel" },
  { id: "customs", label: "税関", icon: "container" },
  {
    id: "gender_equality_center",
    label: "男女共同参画センター",
    icon: "venus-and-mars",
  },
  {
    id: "domestic_violence_support",
    label: "DVの相談",
    icon: "shield-check",
  },
  {
    id: "child_family_support",
    label: "こども家庭センター",
    icon: "heart-plus",
  },
  { id: "vocational_training", label: "職業訓練の相談", icon: "hammer" },
  { id: "business_support", label: "事業の相談", icon: "store" },
  {
    id: "consumer_affairs",
    label: "消費生活相談",
    icon: "shopping-bag",
  },
  {
    id: "labour_bureau",
    label: "労働局",
    icon: "clipboard-list",
  },
  {
    id: "labour_inspection",
    label: "労働基準監督署",
    icon: "hard-hat",
  },
  {
    id: "labour_consultation",
    label: "労働相談",
    icon: "messages-square",
  },
  {
    id: "child_consultation",
    label: "児童相談所",
    icon: "hand-helping",
  },
  {
    id: "social_withdrawal_support",
    label: "ひきこもり支援",
    icon: "life-buoy",
  },
  {
    id: "pension_office",
    label: "年金事務所",
    icon: "calendar-days",
  },
  {
    id: "pension_consultation",
    label: "年金相談センター",
    icon: "calendar-check",
  },
  {
    id: "tax_office",
    label: "税務署",
    icon: "receipt-japanese-yen",
  },
  {
    id: "legal_affairs",
    label: "法務局",
    icon: "scale",
  },
  {
    id: "fire_brigade_office",
    label: "消防団の事務窓口",
    icon: "flame",
  },
  {
    id: "police_consultation",
    label: "警察相談",
    icon: "shield-user",
  },
  {
    id: "employment_office",
    label: "ハローワーク",
    icon: "briefcase-business",
  },
  {
    id: "parent_employment_support",
    label: "子育て中の人の就職支援",
    icon: "users-round",
  },
  {
    id: "graduate_employment_support",
    label: "新卒の就職支援",
    icon: "graduation-cap",
  },
  {
    id: "youth_employment_support",
    label: "若者の就職支援",
    icon: "person-standing",
  },
  {
    id: "foreign_employment_support",
    label: "外国人の就職支援",
    icon: "languages",
  },
  {
    id: "local_employment_support",
    label: "地域の就職相談",
    icon: "map-pinned",
  },
  {
    id: "agriculture_employment_support",
    label: "農林漁業の就職支援",
    icon: "sprout",
  },
  {
    id: "relocation_employment_support",
    label: "移住に伴う就職支援",
    icon: "luggage",
  },
] as const;

export const CategorySchema = v.picklist(
  categoryDefinitions.map((category) => category.id),
);
export type Category = v.InferOutput<typeof CategorySchema>;

export const prefectureNames = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
] as const;

export const PrefectureCodeSchema = v.pipe(
  v.string(),
  v.regex(/^(0[1-9]|[1-3][0-9]|4[0-7])$/),
  v.brand("PrefectureCode"),
);
export const MunicipalityCodeSchema = v.pipe(
  v.string(),
  v.regex(/^(0[1-9]|[1-3][0-9]|4[0-7])[0-9]{3}$/),
  v.brand("MunicipalityCode"),
);
export type PrefectureCode = v.InferOutput<typeof PrefectureCodeSchema>;
export type MunicipalityCode = v.InferOutput<typeof MunicipalityCodeSchema>;
