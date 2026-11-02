import type {
  ParameterLocation,
  ReferenceConstraint,
} from "../core/api-reference.ts";
import { httpStatus } from "../core/http-status.ts";

/**
 * Shows each operation's English summary and description from the OpenAPI document under its Japanese summary.
 * Parameter and response descriptions stay visible either way, because the document has no other text for them.
 */
export const showsContractText = true;

const statusMeanings: Readonly<Record<number, string>> = {
  [httpStatus.ok]: "成功",
  [httpStatus.notModified]: "前に受け取ったものから変わっていません",
  [httpStatus.badRequest]: "リクエストに誤りがあります",
  [httpStatus.notFound]: "見つかりません",
  [httpStatus.notAcceptable]: "受け取れる形式で返せません",
  [httpStatus.conflict]: "データが新しくなりました",
  [httpStatus.unavailable]: "一時的に使えません",
};

export function statusMeaning(status: number): string {
  return statusMeanings[status] ?? "";
}

/** Japanese group names, keyed by OpenAPI tag. */
const tags: Readonly<Record<string, string>> = {
  Directory: "データの概要",
  Contacts: "施設",
  Sources: "もとのデータ",
  Datasets: "データセット",
  "Search index": "ウェブ版の検索用データ",
};

/** Japanese operation summaries, keyed by OpenAPI operation ID. */
const summaries: Readonly<Record<string, string>> = {
  getCatalog: "施設の種類と地域、いまのデータセットを取得する",
  searchContacts: "名前や電話番号、種類、地域で施設をさがす",
  searchContactGroups: "施設の種類ごとに、当てはまる施設を少しずつ見る",
  getContact: "施設の情報と、もとの情報を取得する",
  downloadContact: "1つの施設のvCardをダウンロードする",
  listSources: "もとのデータと、取りこんだ結果の一覧を取得する",
  getSource: "もとのデータのハッシュと、取りこんだ件数を取得する",
  getDatasetManifest: "データセット全体のURL、バイト数、SHA-256を取得する",
  getDatasetDeltas:
    "前のアプリ用データから、いまのデータへの差分の一覧を取得する",
  downloadDataset: "変わらないデータセットのファイルや差分をダウンロードする",
  getSearchIndex: "ウェブ版の検索用データの場所と照合値を取得する",
  downloadSearchIndex: "ウェブ版の検索用データをダウンロードする",
  locateContactRow: "検索用データの行から、施設のIDを取得する",
};

export const referenceCopy = {
  pageActions: "APIドキュメントの操作",
  openapi: "OpenAPI（JSON）を見る",
  copyOpenapi: "API仕様書のURLをコピー",
  openapiSubject: "API仕様書のURL",
  intro: "登録やAPIキーなしで使えます。",
  server: "接続先",
  version: "バージョン",
  navigation: "APIの一覧",
  parameters: "パラメーター",
  noParameters: "パラメーターはありません。",
  parameterColumns: { name: "名前", value: "値", description: "説明" },
  location: {
    query: "クエリ",
    path: "パス",
  } satisfies Record<ParameterLocation, string>,
  required: "必須",
  optional: "任意",
  choices: (count: number): string => `使える値：${count}個`,
  constraints: {
    format: "形式",
    pattern: "パターン",
    minimum: "最小",
    maximum: "最大",
    maxLength: "最大の長さ",
    default: "はじめの値",
  } satisfies Record<ReferenceConstraint["kind"], string>,
  responses: "応答",
  responseColumns: {
    status: "状態",
    description: "説明",
    media: "データの形式",
  },
  noBody: "データなし",
  examples: "コード例",
  placeholders: "{ }の部分を、値に置きかえてください。",
  copyExample: (language: string): string => `${language}のコード例をコピー`,
  attempt: {
    heading: "リクエストを試す",
    submit: "リクエストを試す",
    unspecified: "指定しない",
    sending: "送信しています。",
    status: (status: number): string => {
      const meaning = statusMeaning(status);
      return meaning ? `応答：${status} ${meaning}` : `応答：${status}`;
    },
    media: "データの形式",
    body: "応答のデータ",
    binary: (bytes: number | null): string =>
      bytes === null
        ? "バイナリーのデータは表示しません。"
        : `バイナリーのデータ（${bytes.toLocaleString("ja-JP")}バイト）は表示しません。`,
    truncated: (kibibytes: number): string =>
      `はじめの${kibibytes}KiBだけを表示しています。`,
    failed: "送信できませんでした。通信をたしかめて、もう一度試してください。",
    unknownOperation: "このAPIはありません。",
    incompletePath: "URLに入れる値を入れてください。",
  },
  tags,
  summaries,
} as const;
