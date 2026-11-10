type Instruction = `${string}ください${"" | "。"}`;
type Action =
  `${string}${"する" | "さがす" | "見る" | "開く" | "もどる" | "知る" | "かける" | "試す" | "読みこむ"}`;
type Statement = `${string}ます。`;

export const uiCopy = {
  search: {
    label: "施設の名前",
    help: "施設の名前を入れてください。" satisfies Instruction,
    action: "電話番号をさがす" satisfies Action,
    searching: "電話番号をさがしています。",
    found: (total: string): `${string}件 見つかりました` =>
      `${total}件 見つかりました`,
    none: "あてはまる施設は0件です",
    invalid: "さがす名前をたしかめてください" satisfies Instruction,
    empty: "別の言葉でさがしてください。" satisfies Instruction,
  },
  about: "Public Phonebookについて知る" satisfies Action,
  app: {
    heading: "iPhoneで、電話の相手が分かります",
    description:
      "アプリにある番号から電話がかかってきたとき、施設の名前が出ます。",
    setup:
      "iPhoneの設定でPublic Phonebookを許可してください。" satisfies Instruction,
    store: "App Storeでアプリを見る" satisfies Action,
  },
  openSource: {
    heading: "無料で使えます",
    description: "プログラムも公開しています。",
    source: "プログラムを見る" satisfies Action,
  },
  searchReturn: "さがす画面にもどる" satisfies Action,
  rowUpdated: {
    title: "電話番号のデータが新しくなりました",
    body: "施設をえらんだあとに、データが新しくなりました。もう一度さがしてください。" satisfies Instruction,
    searchedAgain:
      "新しいデータで、もう一度さがしました。施設をえらびなおしてください。" satisfies Instruction,
  },
  resultDetail: {
    label: (hasAddress: boolean): Action =>
      hasAddress ? "住所などを見る" : "くわしい情報を見る",
    name: (facility: string, label: Action): Action => `${facility}の${label}`,
  },
  address: {
    heading: "住所",
    map: "地図で見る" satisfies Action,
    mapName: (facility: string): Action => `${facility}を地図で見る`,
  },
  facilityHomepage: "施設のホームページを開く" satisfies Action,
  sourceTitle: "電話番号のもとの情報",
  sourceAction: "もとの情報を見る" satisfies Action,
  loadFailed: (subject: string): `${string}を読みこめませんでした` =>
    `${subject}を読みこめませんでした`,
  reloadFromStart: (subject: string): Action =>
    `${subject}をはじめから読みこむ`,
  reload: (subject: string): Action => `${subject}をもう一度読みこむ`,
  external: {
    heading: "ほかのサイトを開きます",
    destinations: {
      address: "施設の名前と住所をGoogleマップに送ります。" satisfies Statement,
      facility: "施設のホームページを開きます。" satisfies Statement,
      publication: "データを公開したページを開きます。" satisfies Statement,
      license:
        "データを使うときの決まりのページを開きます。" satisfies Statement,
      source: "電話番号のもとになった資料を開きます。" satisfies Statement,
      cloudflarePrivacy:
        "Cloudflareのプライバシーのページを開きます。" satisfies Statement,
      appStore: "App StoreでPublic Phonebookを開きます。" satisfies Statement,
      sourceCode: "GitHubでプログラムを開きます。" satisfies Statement,
      other: "ほかのサイトのページを開きます。" satisfies Statement,
    },
    host: (host: string): `行き先：${string}` => `行き先：${host}`,
    newTab: "新しいタブで開きます。" satisfies Statement,
    open: "開く" satisfies Action,
    cancel: "キャンセル",
  },
} as const;

export type ExternalDestination = keyof typeof uiCopy.external.destinations;
