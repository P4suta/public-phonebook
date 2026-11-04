import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Phrases that described behavior or wording the website and the iPhone app no longer use. */
const retiredPhrases = [
  "候補が出ます",
  "電話番号でもさがせます",
  "施設や窓口",
  "着信時に名前を出す機能",
  "入力した言葉",
] as const;

/** Statements the website and the iPhone app make word for word. */
const sharedStatements = [
  "検索欄に施設の名前か、電話番号を入れます。",
  "全国の施設が公開した電話番号のデータを、アプリの中に受け取って使います。",
  "新しいデータが出ると、自動で受け取ります。",
  "モバイルデータ通信や省データモードのときは、ほかの回線につながるまで待ちます。",
  "自分の連絡先や通話の履歴を読んだり、変えたり、サービスに送ったりすることはありません。",
  "を許可すると、受け取った公開データをiOSに渡します。",
  "アカウントの登録、広告、行動の追跡はありません。",
  "受け取ったデータは、アプリを削除すると消えます。",
  "場所をさがすために、施設の名前と住所を",
  "病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前が出ます。",
  "感想や使い方の質問、不具合、情報のまちがいは、",
  "電話番号や住所など、いらない個人の情報は書かないでください。",
  "あてはまる施設は0件です",
  "名前の一部を入れるか、別の言葉でさがしてください。",
  "住所などを見る",
  "くわしい情報を見る",
  "施設のホームページを開く",
  "電話番号のもとの情報を見る",
  "データを公開したページを見る",
  "データを使うときの決まりを見る",
  "もとの資料を開く",
  "ほかのサイトを開きます",
  "この施設のホームページを開きます。",
  "このデータを公開しているページを開きます。",
  "データを使うときの決まりのページを開きます。",
  "電話番号のもとになった資料を開きます。",
  "ほかのサイトのページを開きます。",
] as const;

const webSources = ["src/routes", "src/ui"];
const appSources = ["ios/App"];

async function sourceText(
  directories: readonly string[],
  extension: RegExp,
): Promise<string> {
  const texts = await Promise.all(
    directories.map(async (directory) => {
      const names = (await readdir(directory))
        .filter((name) => extension.test(name))
        .sort();
      return Promise.all(
        names.map((name) => readFile(join(directory, name), "utf8")),
      );
    }),
  );
  return texts.flat().join("\n");
}

function retiredIn(text: string): string[] {
  return retiredPhrases.filter((phrase) => text.includes(phrase));
}

function missingFrom(text: string): string[] {
  return sharedStatements.filter((statement) => !text.includes(statement));
}

describe("website copy", () => {
  it("uses none of the retired phrases", async () => {
    expect(retiredIn(await sourceText(webSources, /\.tsx?$/u))).toEqual([]);
    expect(retiredIn("名前の一部を入れると、候補が出ます。")).toEqual([
      "候補が出ます",
    ]);
  });

  it("makes the iPhone app's statements in the app's words", async () => {
    expect(missingFrom(await sourceText(webSources, /\.tsx?$/u))).toEqual([]);
    expect(missingFrom(await sourceText(appSources, /\.swift$/u))).toEqual([]);
    expect(missingFrom("")).toHaveLength(sharedStatements.length);
  });
});
