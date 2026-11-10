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
          "検索語や着信番号をサービスに送りません。",
        ],
      },
      {
        title: "広告と追跡",
        paragraphs: [
          "ありません。",
          "利用状況や診断ログは、サービスで集めません。",
        ],
      },
      {
        title: "Webの検索",
        paragraphs: [
          "通常はブラウザーの中で検索します。",
          "準備中や端末内で検索できないときは、検索語をサービスに送ります。",
          "開発者が検索語を記録することはありません。",
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
          "Webの検索語は、ブラウザーの履歴に残ることがあります。",
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
        label: "使い方と、声を伝える方法を見る",
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
    title: "使い方と、開発者に声を伝える方法",
    sections: [
      {
        title: "電話番号をさがす",
        paragraphs: [
          "検索欄に施設の名前を入れます。",
          "検索用データを読みこんだあとは、通信できないときもさがせます。",
          "電話をかけるときは「電話をかける」を押します。",
        ],
      },
      {
        title: "iPhoneアプリで、電話の相手が分かるようにする",
        paragraphs: [
          "「はじめる」を押すと、アプリで使うデータを受け取ります。",
          "iPhoneの設定で、Public Phonebookを許可します。",
          "病院や役所などから電話がかかってきたとき、iPhoneの画面に施設の名前が出ます。",
        ],
      },
      {
        title: "iPhoneアプリのデータの受け取りが止まったとき",
        paragraphs: [
          "インターネットにつながっているかを、たしかめてください。",
          "受け取れなかったときは、アプリが自動でもう一度受け取ります。",
          "通信がとぎれたときは、通信がもどると、自動で続きを受け取ります。",
          "新しいデータを受け取れなかったときは、次の確認で自動でもう一度受け取ります。",
          "アプリを新しくするように出たときは、App Storeでアプリを新しくしてください。",
          "新しいデータが出ると、自動で受け取ります。",
          "モバイルデータ通信や省データモードのときは、ほかの回線につながるまで待ちます。",
        ],
      },
      {
        title: "開発者に声を伝える",
        paragraphs: [
          "感想や使い方の質問、不具合、情報のまちがいは、support@dial.pageにメールで送ってください。",
          "「役に立った」「使いやすい」のひとことも、開発のはげみになります。",
          "施設の情報画面で、もとの情報や施設のホームページをたしかめられます。",
          "不具合のときは、使っている機器とブラウザー、iPhoneアプリならアプリのバージョン、行った操作を書くと、たしかめやすくなります。",
        ],
      },
      {
        title: "メールを送るときは",
        paragraphs: [
          "メールは、このサービスの開発者が、ひとつずつ読んでいます。",
          "受け取る人のことを考えて、ていねいな言葉で書いてください。",
          "送る前に、AIに言葉づかいを見てもらうのもおすすめです。",
          "あなたの電話番号や住所などは書かないでください。",
        ],
      },
    ],
    links: [
      {
        href: "mailto:support@dial.page",
        label: "開発者にメールを送る",
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
