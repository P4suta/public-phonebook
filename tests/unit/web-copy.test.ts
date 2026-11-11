import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serviceInformation } from "../../apps/web/src/ui/service-information.ts";

/** Phrases that described behavior or wording the website and the iPhone app no longer use. */
const retiredPhrases = [
  "候補が出ます",
  "電話番号でもさがせます",
  "名前か、電話番号",
  "名前か電話番号",
  "施設や窓口",
  "着信時に名前を出す機能",
  "入力した言葉",
  "いらない個人の情報",
  "名前の一部でも",
  "都道府県名と主な分類名は",
] as const;

/** Statements shared across the website and Apple app. */
const sharedStatements = [
  "施設の名前を入れてください。",
  "検索欄に施設の名前を入れてください。",
  "新しいデータを自動で確認します。",
  "モバイルデータ通信や「省データモード」では、自動の受け取りを待ちます。",
  "施設の名前と住所を",
  "質問や不具合、情報のまちがいは、",
  "あなたの電話番号や住所などは書かないでください。",
  "あてはまる施設は0件です",
  "別の言葉でさがしてください。",
  "住所などを見る",
  "くわしい情報を見る",
  "施設のホームページを開く",
  "もとの情報を見る",
  "データのページを開く",
  "使うときの決まりを見る",
  "もとの資料を開く",
  "ほかのサイトを開きます",
  "施設のホームページを開きます。",
  "データを公開したページを開きます。",
  "データを使うときの決まりのページを開きます。",
  "電話番号のもとになった資料を開きます。",
  "ほかのサイトのページを開きます。",
] as const;

const platformStatements = {
  web: ["アプリにある番号から電話がかかってきたとき、施設の名前が出ます。"],
  apple: [
    "国や自治体などが公開した電話番号を使います。",
    "アプリにある番号から電話がかかってきたとき、施設の名前が出ます。",
  ],
} as const;

const webSources = ["apps/web/src/routes", "apps/web/src/ui"];
const appSources = ["apps/ios/App"];

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

function missingFrom(
  text: string,
  platform: keyof typeof platformStatements,
): string[] {
  return [...sharedStatements, ...platformStatements[platform]].filter(
    (statement) => !text.includes(statement),
  );
}

describe("website copy", () => {
  it("summarizes app collection and links a concise policy with the required disclosures", async () => {
    const app = await readFile("apps/ios/App/AboutScreen.swift", "utf8");
    expect(app).toContain('section("データの収集")');
    expect(app).toContain('Text("ありません。")');
    expect(app).toContain("https://www.dial.page/privacy");
    const policy = serviceInformation.find((page) => page.key === "privacy");
    expect(policy).toBeDefined();
    expect(
      policy?.sections.flatMap((section) => section.paragraphs).length,
    ).toBeLessThanOrEqual(16);
    expect(policy?.sections.map((section) => section.title)).toEqual([
      "アプリのデータ収集",
      "広告と追跡",
      "Webの検索",
      "通信",
      "保存と削除",
      "お問い合わせ",
    ]);
    expect(policy?.sections[0]?.paragraphs[0]).toBe("ありません。");
    expect(policy?.sections[1]?.paragraphs).toContain(
      "使い方や不具合の記録は、サービスで集めません。",
    );
    const text =
      policy?.sections.flatMap((section) => section.paragraphs).join("\n") ??
      "";
    for (const disclosure of [
      "検索した言葉",
      "IPアドレス",
      "Cloudflare",
      "ブラウザー",
      "削除",
      "メールアドレス",
      "support@dial.page",
    ])
      expect(text).toContain(disclosure);
    expect(
      policy?.links.some(
        (link) => link.href === "https://www.cloudflare.com/privacypolicy/",
      ),
    ).toBe(true);
  });

  it("uses none of the retired phrases", async () => {
    expect(retiredIn(await sourceText(webSources, /\.tsx?$/u))).toEqual([]);
    expect(retiredIn("名前の一部を入れると、候補が出ます。")).toEqual([
      "候補が出ます",
    ]);
    expect(retiredIn("いらない個人の情報は書かないでください。")).toEqual([
      "いらない個人の情報",
    ]);
  });

  it("keeps shared behavior and device-specific statements in each platform's words", async () => {
    expect(
      missingFrom(await sourceText(webSources, /\.tsx?$/u), "web"),
    ).toEqual([]);
    expect(
      missingFrom(await sourceText(appSources, /\.swift$/u), "apple"),
    ).toEqual([]);
    for (const platform of ["web", "apple"] as const) {
      expect(missingFrom("", platform)).toHaveLength(
        sharedStatements.length + platformStatements[platform].length,
      );
    }
  });
});
