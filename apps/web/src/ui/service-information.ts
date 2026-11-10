import type { ExternalDestination } from "./copy.ts";
import type { IconName } from "./icon-catalog.ts";

export interface ServiceInformation {
  readonly key: "privacy" | "support";
  readonly title: string;
  readonly updated?: string;
  readonly sections: readonly {
    readonly title: string;
    readonly paragraphs: readonly string[];
  }[];
  readonly links: readonly {
    readonly href: string;
    readonly label: string;
    readonly icon: IconName;
    readonly destination?: ExternalDestination;
  }[];
}

export const serviceInformation = [
  {
    key: "privacy",
    title: "プライバシーについて",
    updated: "最終更新日：2026年11月11日",
    sections: [
      {
        title: "アプリのデータ収集",
        paragraphs: [
          "ありません。",
          "検索した言葉や、かかってきた電話の番号をサービスに送りません。",
        ],
      },
      {
        title: "広告と追跡",
        paragraphs: [
          "ありません。",
          "使い方や不具合の記録は、サービスで集めません。",
        ],
      },
      {
        title: "Webの検索",
        paragraphs: [
          "通常はブラウザーの中で検索します。",
          "準備中やブラウザーの中で検索できないときは、検索した言葉をサービスに送ります。",
          "検索した言葉をサービスで記録することはありません。",
        ],
      },
      {
        title: "通信",
        paragraphs: [
          "配信にはCloudflareを使い、通信にIPアドレスなどの情報を使います。",
          "配信先にも、同じ水準のデータ保護を求めます。",
          "地図や外のサイトを開くと、行き先のサービスの決まりが使われます。",
        ],
      },
      {
        title: "保存と削除",
        paragraphs: [
          "アプリの保存データは、アプリを削除すると消えます。",
          "Webで検索した言葉は、ブラウザーの履歴に残ることがあります。",
          "履歴やサイトデータは、ブラウザーで削除できます。",
        ],
      },
      {
        title: "お問い合わせ",
        paragraphs: [
          "メールは、Cloudflareと転送サービスを通して届きます。",
          "メールアドレスと内容は、返信や不具合の対応に使い、必要な間保管します。",
          "削除の希望は、support@dial.pageで受け付けます。",
        ],
      },
    ],
    links: [
      {
        href: "/support",
        label: "使い方とお問い合わせ",
        icon: "life-buoy",
      },
      {
        href: "https://www.cloudflare.com/privacypolicy/",
        label: "Cloudflareのプライバシーを見る",
        icon: "external-link",
        destination: "cloudflarePrivacy",
      },
    ],
  },
  {
    key: "support",
    title: "使い方とお問い合わせ",
    sections: [
      {
        title: "電話番号をさがす",
        paragraphs: [
          "検索欄に施設の名前を入れてください。",
          "準備が終わると、通信できないときもさがせます。",
          "電話をかけるときは「電話をかける」を押します。",
        ],
      },
      {
        title: "iPhoneで電話の相手を表示する",
        paragraphs: [
          "「はじめる」を押して、準備が終わるまで待ってください。",
          "iPhoneの設定でPublic Phonebookを許可してください。",
          "アプリにある番号から電話がかかってきたとき、施設の名前が出ます。",
        ],
      },
      {
        title: "新しいデータを受け取れないとき",
        paragraphs: [
          "新しいデータを自動で確認します。",
          "インターネットにつながっているかをたしかめてください。",
          "通信がもどると、自動でもう一度受け取ります。",
          "iPhoneのモバイルデータ通信や「省データモード」では、自動の受け取りを待ちます。",
          "アプリの更新を求められたときは、App Storeで更新してください。",
        ],
      },
      {
        title: "お問い合わせ",
        paragraphs: [
          "質問や不具合、情報のまちがいは、support@dial.pageにメールでお知らせください。",
          "不具合のときは、使った機器、アプリやブラウザーの名前とバージョン、行った操作を教えてください。",
          "あなたの電話番号や住所などは書かないでください。",
        ],
      },
    ],
    links: [
      {
        href: "mailto:support@dial.page",
        label: "メールを送る",
        icon: "mail",
      },
      {
        href: "/privacy",
        label: "プライバシーについて読む",
        icon: "shield-check",
      },
    ],
  },
] as const satisfies readonly ServiceInformation[];
