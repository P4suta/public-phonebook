type Instruction = `${string}ください${"" | "。"}`;
type FilterDefault = `${string}をえらばない`;
type Action =
  `${string}${"する" | "さがす" | "見る" | "開く" | "もどる" | "知る" | "かける" | "試す" | "読みこむ"}`;

export const uiCopy = {
  search: {
    label: "施設や窓口の名前",
    hint: [
      "病院や役所、学校などの名前を入れてください。" satisfies Instruction,
      "名前の一部でも、さがせます。",
    ],
    action: "電話番号をさがす" satisfies Action,
    searching: "電話番号をさがしています。",
    found: (total: string): `${string}件 見つかりました` =>
      `${total}件 見つかりました`,
    none: "施設や窓口が見つかりませんでした",
    prefecture: "都道府県をえらばない" satisfies FilterDefault,
    municipality: "市区町村をえらばない" satisfies FilterDefault,
    category: "種類をえらばない" satisfies FilterDefault,
    invalid: "名前や地域をたしかめてください" satisfies Instruction,
    empty: "名前の一部だけを入れるか、えらんだ地域や種類を変えてください。",
  },
  about: "Public Phonebookについてくわしく知る" satisfies Action,
  searchReturn: "さがす画面にもどる" satisfies Action,
  sourceTitle: "電話番号のもとの情報",
  sourceAction: "電話番号のもとの情報を見る" satisfies Action,
  copy: "コピーする" satisfies Action,
  copied: (subject: string): `${string}をコピーしました。` =>
    `${subject}をコピーしました。`,
  copyFailed: "コピーできませんでした。文字をえらんでコピーしてください。",
  loadFailed: (subject: string): `${string}を読みこめませんでした` =>
    `${subject}を読みこめませんでした`,
  reloadFromStart: (subject: string): Action =>
    `${subject}をはじめから読みこむ`,
  reload: (subject: string): Action => `${subject}をもう一度読みこむ`,
} as const;
