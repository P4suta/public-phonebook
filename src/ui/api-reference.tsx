import { ApiReferenceReact } from "@scalar/api-reference-react";
import { ExternalLink } from "lucide-react";
import {
  type ComponentProps,
  type ReactElement,
  useEffect,
  useRef,
} from "react";
import "@scalar/api-reference-react/style.css";
import { browserCredentials } from "../core/staging-access-policy.ts";
import { enhanceReference } from "./reference-accessibility.ts";

export default function ApiReference({
  content,
  onReady,
}: {
  readonly content: string;
  readonly onReady: () => void;
}): ReactElement {
  const externalIcon = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    function enhanceLinks(): void {
      enhanceReference(document);
      const icon = externalIcon.current?.querySelector("svg");
      if (!icon) return;
      for (const link of document.querySelectorAll("a[href]")) {
        if (!(link instanceof HTMLAnchorElement)) continue;
        const url = new URL(link.href);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.origin === location.origin
        )
          continue;
        link.target = "_blank";
        link.relList.add("noopener", "noreferrer");
        const label =
          link.getAttribute("aria-label") ??
          link.textContent?.trim() ??
          "外部のページ";
        if (!label.includes("新しいタブ"))
          link.setAttribute("aria-label", `${label}（新しいタブ）`);
        if (!link.querySelector("svg.lucide-external-link"))
          link.appendChild(icon.cloneNode(true));
      }
    }
    const observer = new MutationObserver(enhanceLinks);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "role",
        "aria-controls",
        "aria-expanded",
        "aria-label",
        "contenteditable",
      ],
    });
    enhanceLinks();
    return (): void => observer.disconnect();
  }, []);
  const configuration: ComponentProps<
    typeof ApiReferenceReact
  >["configuration"] = {
    url: "/api/openapi.json",
    content,
    layout: "modern",
    theme: "none",
    withDefaultFonts: false,
    telemetry: false,
    forceDarkModeState: "light",
    hideDarkModeToggle: true,
    hideClientButton: true,
    showDeveloperTools: "never",
    agent: { disabled: true },
    proxyUrl: "",
    defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
    featuredClients: ["js/fetch", "shell/curl", "python/requests"],
    documentDownloadType: "none",
    defaultOpenAllTags: true,
    customFetch: (input, init) =>
      fetch(input, {
        ...init,
        credentials: browserCredentials(window.location.origin),
      }),
    onLoaded: () => {
      onReady();
    },
    localization: {
      locale: "ja",
      direction: "ltr",
      translations: {
        common: {
          description: "説明",
          httpMethod: "HTTPメソッド",
          path: "パス",
          copyDefault: "はじめの値をコピー",
          copyExample: "値の例をコピー",
        },
        search: {
          label: "APIをさがす",
          inputLabel: "さがす言葉",
          open: "APIをさがす",
          placeholder: "APIをさがす",
          clear: "検索を消す",
          noResults: "見つかりませんでした",
          results: "APIの検索結果",
          keyboardShortcut: "キーボードで開く",
          navigate: "選ぶ",
          select: "開く",
          instructions:
            "上下の矢印で選び、Enterキーで開きます。文字を入れると、しぼれます。",
          entryHeading: "見出し",
          entryOperation: "API",
          entryTag: "グループ",
          entryTagGroup: "グループ",
        },
        navigation: {
          introduction: "APIについて",
          openMenu: "APIの一覧を開く",
          closeMenu: "APIの一覧を閉じる",
          operations: "APIの一覧",
          mainContent: "{name}の説明",
          sidebarFor: "{name}の一覧",
          closeGroup: "グループを閉じる",
          openGroup: "グループを開く",
          endpoints: "{name}のAPI",
          showAllEndpoints: "{name}のAPIをすべて見る",
          collapsed: "閉じています",
        },
        server: { label: "接続先", select: "接続先を選ぶ" },
        clientLibraries: {
          heading: "コード例",
          more: "ほかの言語",
          selectAll: "言語を選ぶ",
          searchLabel: "言語をさがす",
          changeClient: "コード例の言語を変える",
        },
        operation: {
          testRequest: "リクエストを試す",
          codeSample: "コード例",
          queryParameters: "検索の条件",
          pathParameters: "URLに入れる値",
          responses: "応答",
          headers: "ヘッダー",
          body: "データ",
          requestBody: "送るデータ",
          cookies: "Cookie",
          codeSampleUnavailable: "このAPIにはコード例がありません。",
          selectedContentType: "選んだデータ形式",
        },
        response: {
          exampleResponses: "応答の例",
          noBody: "データはありません",
          showSchema: "データの形を見る",
          status: "状態",
        },
        actions: {
          copyLink: "リンクをコピー",
          copyLinkTo: "{name}のリンクをコピー",
          copyToClipboard: "リンクをコピー",
          copyEndpointUrl: "URLをコピー",
          copied: "コピーしました",
          showMore: "もっと見る",
          copyAsMarkdown: "Markdownをコピー",
        },
        models: { label: "データの形" },
        schema: {
          example: "例",
          examples: "例",
          default: "はじめの値",
          schema: "データの形",
          emptyObject: "空のデータ",
          showAdditionalProperties: "ほかの項目を見る",
          showOneMoreProperty: "あと1項目を見る",
          showMoreProperties: "あと{count}項目を見る",
          forName: "{name}の値",
          showSchemaDetails: "データの形をくわしく見る",
          propertyCount: "項目数：{count}",
          headerCount: "ヘッダー数：{count}",
          recursiveReference: "{name}をくり返し使います",
          additionalProperties: "ほかの項目",
          deprecated: "今後使わなくなる項目",
          format: "形式",
          greaterThan: "より大きい値",
          lessThan: "より小さい値",
          max: "最大",
          min: "最小",
          maxLength: "最大の文字数",
          minLength: "最小の文字数",
          multipleOf: "の倍数",
          nullable: "nullも使えます",
          pattern: "文字のパターン",
          copyPattern: "文字のパターンをコピー",
          readOnly: "読み取り専用",
          required: "必須",
          hideValues: "値を閉じる",
          showAllValues: "値をすべて見る",
          type: "型",
          unique: "重複なし",
          values: "使える値",
          writeOnly: "書き込み専用",
          typeInteger: "整数です。",
        },
        authentication: {
          title: "認証",
          detailsRequired: "認証が必要です",
          detailsOptional: "認証はなくても使えます",
          optional: "認証は任意",
          required: "認証が必要",
        },
        apiClient: {
          modalClientContainer: { label: "APIを試す" },
          header: {
            closeClient: "APIを試す画面を閉じる",
            operationSettings: "APIの設定",
          },
          sidebarToggle: { show: "APIの一覧を開く", hide: "APIの一覧を閉じる" },
          serverDropdown: {
            server: "接続先：",
            unknownServer: "接続先がわかりません",
          },
          addressBar: {
            send: "送信",
            sendRequest: "リクエストを送信（{method}）",
            path: "パス",
            copyUrl: "URLをコピー",
            urlPlaceholder: "URLを入れる",
          },
          requestBlock: {
            authentication: "認証",
            headers: "ヘッダー",
            queryParameters: "検索の条件",
            requestBody: "送るデータ",
            variables: "変数",
            cookies: "Cookie",
            label: "リクエスト：{name}",
            requestName: "リクエスト名",
          },
          responseBlock: {
            response: "応答",
            requestFailed: "送信できませんでした",
            networkErrorHelp: "通信を確認して、もう一度送信してください。",
            requestHeaders: "送信のヘッダー",
            responseHeaders: "応答のヘッダー",
            body: "データ",
          },
          responseEmpty: { sendRequest: "送信" },
          sectionFilter: {
            all: "すべて",
            headers: "ヘッダー",
            body: "データ",
            cookies: "Cookie",
            query: "検索の条件",
          },
          codeInput: {
            required: "必須",
            exitHint: "{escape}キーのあとに{tab}キーを押すと、入力欄から出ます",
          },
          codeInputLite: { required: "必須" },
          requestTable: { enabled: "使う", key: "名前", value: "値" },
          requestTableRow: {
            key: "名前",
            value: "値",
            delete: "消す",
            include: "{name}をリクエストに入れる",
            keyLabel: "項目の名前",
            valueLabel: "項目の値",
            deleteRow: "{name}を消す",
            row: "この行",
          },
          requestTableTooltip: {
            min: "最小：",
            max: "最大：",
            default: "はじめの値：",
            invalid: "値が正しくありません",
            moreInformation: "くわしく見る",
          },
          dataTableInput: {
            clearValue: "値を消す",
            resetValue: "はじめの値に戻す",
            showPassword: "パスワードを表示",
            hidePassword: "パスワードを隠す",
          },
          dataTableInputSelect: { value: "値", addValue: "値を足す" },
          collapsibleSection: {
            collapsed: "（閉じています）",
            item: "項目",
            items: "項目",
          },
          requestCodeSnippet: {
            codeSnippet: "コード例",
            unavailable: "このAPIにはコード例がありません。",
          },
          headers: {
            headerKey: "ヘッダーの名前",
            headerValue: "ヘッダーの値",
            noHeaders: "ヘッダーはありません",
          },
          responseBodyToggle: { preview: "見やすく表示", raw: "そのまま表示" },
          responseBodyVirtual: {
            body: "データ",
            largeBodyHint: "データが大きいため、そのまま表示しています。",
          },
          responseCookies: {
            cookies: "Cookie",
            cookieName: "Cookieの名前",
            cookieValue: "Cookieの値",
            noCookies: "Cookieはありません",
          },
          responseLoadingOverlay: { cancel: "送信をやめる" },
        },
      },
    },
  };
  return (
    <>
      <span ref={externalIcon} hidden>
        <ExternalLink size={18} aria-hidden="true" />
      </span>
      <ApiReferenceReact configuration={configuration} />
    </>
  );
}
