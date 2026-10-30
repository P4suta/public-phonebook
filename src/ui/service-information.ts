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
    updated: "最終更新日：2026年10月31日",
    sections: [
      {
        title: "検索した名前と通信について",
        paragraphs: [
          "施設をさがすときは、入力した名前や、えらんだ地域などを、このサービスに送ります。",
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
          "APIの説明のページでは、コード例の言語を選ぶと、その選択をブラウザーに保存します。",
        ],
      },
      {
        title: "iPhoneアプリのデータについて",
        paragraphs: [
          "iPhoneアプリは、個人の電話帳や通話履歴を、このサービスに送りません。",
          "えらんだ地域の公開データや更新の設定は、iPhoneの中に保存します。",
          "着信時に名前を出す機能や、連絡先アプリからさがす機能は、自分で有効にしたときだけ使われます。",
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
          "地域や施設の種類でもしぼれます。",
          "電話をかけるときは「電話をかける」を押します。",
        ],
      },
      {
        title: "iPhoneアプリで、着信時に名前を出す",
        paragraphs: [
          "アプリの設定で都道府県をえらび、地域のデータを保存します。",
          "「iPhoneの設定で変更」を押し、Public Phonebookを有効にします。",
          "保存したデータにある電話番号から着信すると、施設の名前を表示します。",
        ],
      },
      {
        title: "iPhoneアプリで、連絡先アプリからさがす",
        paragraphs: [
          "地域のデータを保存してから、「連絡先アプリでさがせるようにする」を有効にします。",
          "同じ設定で、この機能を止められます。",
        ],
      },
      {
        title: "iPhoneアプリのデータを更新できないとき",
        paragraphs: [
          "インターネットにつながっているかをたしかめ、「今すぐ更新」を押してください。",
          "更新できなくても、すでに保存したデータは使えます。",
          "自動更新はWi-Fiにつながっているときに試みます。",
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
