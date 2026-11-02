import {
  ExternalLink,
  LifeBuoy,
  type LucideIcon,
  Mail,
  ShieldCheck,
} from "lucide-react";
import type { ExternalDestination } from "./copy.ts";

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
    readonly icon: LucideIcon;
    readonly destination?: ExternalDestination;
  }[];
}

export const serviceInformation = [
  {
    key: "privacy",
    title: "プライバシーについて",
    updated: "最終更新日：2026年11月2日",
    sections: [
      {
        title: "検索した言葉と通信について",
        paragraphs: [
          "ウェブ版は、画面を開いたあとに、全国の施設の検索用データを読みこみます。",
          "読みこんだあとは、入力した言葉をブラウザーの中だけで使い、このサービスに送りません。",
          "読みこむ前と、JavaScriptを使えないときは、入力した言葉をこのサービスに送ってさがします。",
          "ブラウザーでデータ節約の設定をしているときは、検索用データを読みこまず、入力した言葉を送ってさがします。",
          "検索結果から施設の情報を開くと、その施設の情報をこのサービスに問い合わせます。",
          "通信にはIPアドレスなどの情報も使います。",
          "サービスの配信にはCloudflareを使っています。",
        ],
      },
      {
        title: "ウェブ版のデータについて",
        paragraphs: [
          "ウェブ版は、Cookieを使いません。",
          "前の画面にもどったときに同じ位置を出すため、画面の位置だけをブラウザーに保存します。",
          "この位置は、タブを閉じると消えます。",
          "検索した言葉は、ブラウザーに保存しません。",
          "検索用データは公開しているデータで、ブラウザーのキャッシュに残ります。",
          "キャッシュは、ブラウザーの設定で消せます。",
          "APIの説明のページでは、コード例の言語を選ぶと、その選択をブラウザーに保存します。",
        ],
      },
      {
        title: "iPhoneアプリのデータについて",
        paragraphs: [
          "iPhoneアプリは、個人の電話帳や通話履歴を、このサービスに送りません。",
          "全国の公開データは、iPhoneの中に保存します。",
          "アプリで検索した言葉は、iPhoneの中だけで使い、このサービスに送りません。",
          "着信時に名前を出す機能は、自分で有効にしたときだけ使われます。",
        ],
      },
      {
        title: "広告と外のサイトについて",
        paragraphs: [
          "広告や、広告のための行動の追跡はしていません。",
          "利用するための登録もいりません。",
          "地図や公式サイトを開くと、そのサイトの決まりが使われます。",
        ],
      },
      {
        title: "開発者に声を伝えるとき",
        paragraphs: [
          "感想や質問は、support@dial.pageへのメールで受け付けます。",
          "メールは、Cloudflareとメールの転送サービスを通して、開発者に届きます。",
          "メールアドレスと内容は、返事と、不具合や情報のまちがいを直すためだけに使います。",
          "自分や、ほかの人の電話番号や住所など、いらない情報は書かないでください。",
          "内容を変えたときは、このページの日付も更新します。",
        ],
      },
    ],
    links: [
      {
        href: "/support",
        label: "使い方と、声を伝える方法を見る",
        icon: LifeBuoy,
      },
      {
        href: "https://www.cloudflare.com/privacypolicy/",
        label: "Cloudflareのプライバシーを見る",
        icon: ExternalLink,
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
          "名前の一部を入れると、候補が出ます。",
          "検索用データを読みこんだあとは、通信できないときもさがせます。",
          "電話をかけるときは「電話をかける」を押します。",
        ],
      },
      {
        title: "iPhoneアプリで、着信時に名前を出す",
        paragraphs: [
          "アプリをはじめて開き「はじめる」を押すと、全国のデータを保存します。",
          "「iPhoneの設定を開く」を押し、Public Phonebookを有効にします。",
          "保存したデータにある電話番号から着信すると、施設の名前を表示します。",
        ],
      },
      {
        title: "iPhoneアプリのデータを更新できないとき",
        paragraphs: [
          "インターネットにつながっているかをたしかめ、アプリの「設定」で「今すぐ更新する」を押してください。",
          "更新できなくても、すでに保存したデータは使えます。",
          "自動更新は月に1回くらい試みます。",
          "更新する時刻はiPhoneが決めます。",
        ],
      },
      {
        title: "開発者に声を伝える",
        paragraphs: [
          "感想や、使い方の質問、不具合、情報のまちがいは、support@dial.pageにメールで送ってください。",
          "「役に立った」「使いやすい」のひとことも、開発のはげみになります。",
          "施設の情報画面で、もとの情報や公式サイトをたしかめられます。",
          "不具合のときは、使っている機器とブラウザー、iPhoneアプリならアプリのバージョン、行った操作を書くと、たしかめやすくなります。",
        ],
      },
      {
        title: "メールを送るときは",
        paragraphs: [
          "メールは、このサービスの開発者が、ひとつずつ読んでいます。",
          "受け取る人のことを考えて、ていねいな言葉で書いてください。",
          "送る前に、AIに言葉づかいを見てもらうのもおすすめです。",
          "電話番号や住所など、いらない個人の情報は書かないでください。",
        ],
      },
    ],
    links: [
      {
        href: "mailto:support@dial.page",
        label: "開発者にメールを送る",
        icon: Mail,
      },
      {
        href: "/privacy",
        label: "プライバシーについて読む",
        icon: ShieldCheck,
      },
    ],
  },
] as const satisfies readonly ServiceInformation[];
