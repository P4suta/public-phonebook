type Instruction = `${string}ください`;
type FilterDefault = `${string}をえらばない`;
type Action =
  `${string}${"する" | "さがす" | "見る" | "開く" | "もどる" | "知る" | "かける" | "試す"}`;

export const uiCopy = {
  search: {
    prompt: "名前を入れてください" satisfies Instruction,
    label: "施設や窓口の名前",
    action: "さがす" satisfies Action,
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
  copyFailed: "コピーできませんでした。文字をえらんでコピーしてください。",
} as const;
