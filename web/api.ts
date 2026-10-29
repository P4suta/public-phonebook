const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECTION_MIN = 300;
const JSON_INDENT_SPACES = 2;

type ExplorerState =
  | { readonly kind: "ready" }
  | { readonly kind: "loading"; readonly controller: AbortController }
  | {
      readonly kind: "response";
      readonly status: number;
      readonly payload: string;
      readonly headers: string;
    }
  | { readonly kind: "failed" };

function enhanceApi(): void {
  const form = document.getElementById("api-search");
  const query = document.getElementById("api-q");
  const direct = document.getElementById("api-direct");
  const submit = document.getElementById("api-submit");
  const address = document.getElementById("api-url");
  const select = document.getElementById("api-select-url");
  const status = document.getElementById("api-status");
  const output = document.getElementById("api-response");
  const responseHeaders = document.getElementById("api-response-headers");
  const curl = document.getElementById("api-curl");
  const javascript = document.getElementById("api-javascript");
  if (
    !(form instanceof HTMLFormElement) ||
    !(query instanceof HTMLInputElement) ||
    !(direct instanceof HTMLButtonElement) ||
    !(submit instanceof HTMLButtonElement) ||
    !(address instanceof HTMLInputElement) ||
    !(select instanceof HTMLButtonElement) ||
    !(status instanceof HTMLElement) ||
    !(output instanceof HTMLElement) ||
    !(responseHeaders instanceof HTMLElement) ||
    !(curl instanceof HTMLElement) ||
    !(javascript instanceof HTMLElement)
  )
    return;
  let state: ExplorerState = { kind: "ready" };

  const examples = (): URL => {
    const url = new URL("/api/contacts", location.origin);
    url.searchParams.set("q", query.value);
    address.value = url.href;
    curl.textContent = `curl --fail-with-body '${url.href.replaceAll("'", "'\\''")}'`;
    javascript.textContent = `const response = await fetch(${JSON.stringify(url.href)});\nif (!response.ok) throw new Error(\`HTTP \${response.status}\`);\nconst result: unknown = await response.json();\nconsole.log(result);`;
    return url;
  };

  const render = (): void => {
    output.hidden = state.kind !== "response";
    responseHeaders.hidden = state.kind !== "response";
    output.setAttribute("aria-busy", String(state.kind === "loading"));
    switch (state.kind) {
      case "ready":
        status.textContent = "施設名の一部か、電話番号を入力してください。";
        output.textContent = "";
        responseHeaders.textContent = "";
        break;
      case "loading":
        status.textContent = "JSONを取得しています。";
        break;
      case "response":
        status.textContent =
          state.status >= HTTP_SUCCESS_MIN &&
          state.status < HTTP_REDIRECTION_MIN
            ? `HTTP ${state.status}・JSONを取得しました。`
            : `HTTP ${state.status}・レスポンスのエラー内容を確認してください。`;
        output.textContent = state.payload;
        responseHeaders.textContent = state.headers;
        break;
      case "failed":
        status.textContent =
          "レスポンスを読み取れませんでした。接続やJSON形式を確認して、もう一度取得してください。";
        break;
      default: {
        const unreachable: never = state;
        throw new Error(String(unreachable));
      }
    }
  };

  query.addEventListener("input", () => {
    if (state.kind === "loading") state.controller.abort();
    state = { kind: "ready" };
    examples();
    render();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.kind === "loading") state.controller.abort();
    const controller = new AbortController();
    const url = examples();
    state = { kind: "loading", controller };
    render();
    void (async (): Promise<void> => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: "omit",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const payload: unknown = await response.json();
        if (controller.signal.aborted) return;
        state = {
          kind: "response",
          status: response.status,
          payload: JSON.stringify(payload, null, JSON_INDENT_SPACES) ?? "null",
          headers: [
            "content-type",
            "x-request-id",
            "x-public-phonebook-snapshot",
            "retry-after",
            "etag",
            "link",
          ]
            .flatMap((name) => {
              const value = response.headers.get(name);
              return value === null ? [] : [`${name}: ${value}`];
            })
            .join("\n"),
        };
      } catch {
        if (controller.signal.aborted) return;
        state = { kind: "failed" };
      }
      render();
    })();
  });
  select.hidden = false;
  select.addEventListener("click", () => {
    address.focus();
    address.select();
  });
  window.addEventListener("pagehide", () => {
    if (state.kind === "loading") {
      state.controller.abort();
      state = { kind: "ready" };
      render();
    }
  });
  examples();
  render();
  direct.hidden = true;
  submit.hidden = false;
}

if (typeof document !== "undefined") enhanceApi();
