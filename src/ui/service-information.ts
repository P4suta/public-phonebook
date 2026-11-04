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
    updated: "最終更新日：2026年11月4日",
    sections: [
      {
        title: "検索した言葉と通信について",
        paragraphs: [
          "ウェブ版は、画面を開いたあとに、全国の施設の検索用データを読みこみます。",
          "読みこんだあとは、検索した言葉をブラウザーの中だけで使います。",
          "サービスには送りません。",
          "読みこむ前と、JavaScriptを使えないときは、検索した言葉をサービスに送ってさがします。",
          "ブラウザーでデータ節約の設定をしているときは、検索用データを読みこまず、検索した言葉を送ってさがします。",
          "検索結果から施設の情報を開くと、その施設の情報をサービスに問い合わせます。",
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
        ],
      },
      {
        title: "iPhoneアプリのデータについて",
        paragraphs: [
          "全国の施設が公開した電話番号のデータを、アプリの中に受け取って使います。",
          "アプリで検索した言葉は、iPhoneの中だけで使います。",
          "サービスには送りません。",
          "自分の連絡先や通話の履歴を読んだり、変えたり、サービスに送ったりすることはありません。",
          "iPhoneの設定でPublic Phonebookを許可すると、受け取った公開データをiOSに渡します。",
          "受け取ったデータは、アプリを削除すると消えます。",
        ],
      },
      {
        title: "広告と外のサイトについて",
        paragraphs: [
          "アカウントの登録、広告、行動の追跡はありません。",
          "「地図で見る」からGoogleマップを開くときは、場所をさがすために施設の名前と住所をGoogleに送ります。",
          "施設のページなど、ほかのサイトを開いたときは、そのサイトの決まりが使われます。",
        ],
      },
      {
        title: "開発者に声を伝えるとき",
        paragraphs: [
          "感想や質問は、support@dial.pageへのメールで受け付けます。",
          "メールは、Cloudflareとメールの転送サービスを通して、開発者に届きます。",
          "メールアドレスと内容は、返事と、不具合や情報のまちがいを直すためだけに使います。",
          "電話番号や住所など、いらない個人の情報は書かないでください。",
          "内容を変えたときは、このページの日付も更新します。",
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
          "検索欄に施設の名前か、電話番号を入れます。",
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
          "受け取りがとちゅうで止まったときは、アプリが自動でもう一度受け取ります。",
          "前に受け取ったデータは、そのまま使えます。",
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
          "電話番号や住所など、いらない個人の情報は書かないでください。",
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
