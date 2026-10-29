const CONTACTS_PER_PAGE = 50;
export class FeedPage {
    #data;
    constructor(value) {
        this.#data = value;
    }
    get snapshot() {
        return this.#data.snapshot;
    }
    get total() {
        return this.#data.total;
    }
    get page() {
        return this.#data.page;
    }
    get pages() {
        return this.#data.pages;
    }
    get shown() {
        return this.#data.shown;
    }
    get html() {
        return this.#data.html;
    }
    toJSON() {
        return { ...this.#data };
    }
    static parse(value) {
        if (!isRecord(value) ||
            typeof value.snapshot !== "string" ||
            !/^[0-9a-f]{64}$/.test(value.snapshot) ||
            !isCount(value.total) ||
            !isCount(value.page) ||
            !isCount(value.pages) ||
            !isCount(value.shown) ||
            typeof value.html !== "string" ||
            value.page < 1 ||
            value.page > value.pages ||
            value.pages !== Math.max(1, Math.ceil(value.total / CONTACTS_PER_PAGE)) ||
            value.shown !== Math.min(value.page * CONTACTS_PER_PAGE, value.total))
            throw new Error("Invalid feed response");
        return new FeedPage({
            snapshot: value.snapshot,
            total: value.total,
            page: value.page,
            pages: value.pages,
            shown: value.shown,
            html: value.html,
        });
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function feedPayload(value) {
    return FeedPage.parse(value);
}
class SnapshotChanged extends Error {
}
export function enhanceFeed(root) {
    const list = document.getElementById("contact-list");
    const button = document.getElementById("load-more");
    const retry = document.getElementById("feed-retry");
    const status = document.getElementById("feed-message");
    const errorPanel = document.getElementById("feed-error");
    const errorMessage = document.getElementById("feed-error-message");
    const next = document.getElementById("next-page");
    if (!(list instanceof HTMLElement) ||
        !(button instanceof HTMLButtonElement) ||
        !(retry instanceof HTMLButtonElement) ||
        !(status instanceof HTMLElement) ||
        !(errorPanel instanceof HTMLElement) ||
        !(errorMessage instanceof HTMLElement) ||
        !(next instanceof HTMLAnchorElement))
        return;
    let initial;
    try {
        initial = feedPayload({
            snapshot: root.dataset.snapshot,
            page: Number(root.dataset.page),
            pages: Number(root.dataset.pages),
            total: Number(root.dataset.total),
            shown: Math.min(Number(root.dataset.page) * CONTACTS_PER_PAGE, Number(root.dataset.total)),
            html: "",
        });
    }
    catch {
        return;
    }
    if (initial.page >= initial.pages)
        return;
    const endpoint = new URL(next.href);
    if (endpoint.origin !== location.origin || endpoint.pathname !== "/")
        return;
    endpoint.pathname = "/internal/search";
    const seen = new Set();
    for (const node of list.querySelectorAll(".contact")) {
        const id = node.getAttribute("data-contact-id");
        if (!id || seen.has(id))
            return;
        seen.add(id);
    }
    if (seen.size !== CONTACTS_PER_PAGE)
        return;
    let state = {
        kind: "ready",
        page: initial.page,
        mode: "automatic",
    };
    let observer;
    const numbers = new Intl.NumberFormat("ja-JP");
    root.dataset.enhanced = "true";
    const observeTail = () => {
        observer?.disconnect();
        if (state.kind === "ready" &&
            state.mode === "automatic" &&
            list.lastElementChild) {
            observer?.observe(list.lastElementChild);
        }
    };
    const render = () => {
        const current = state.kind === "suspended" ? state.resume : state;
        button.hidden =
            (current.kind !== "ready" && current.kind !== "loading") ||
                (current.mode === "automatic" && observer !== undefined);
        button.disabled = current.kind === "loading";
        retry.disabled = current.kind === "loading";
        retry.hidden = current.kind !== "retry";
        errorPanel.hidden = current.kind !== "retry" && current.kind !== "stale";
        list.setAttribute("aria-busy", String(current.kind === "loading"));
        const shown = `${numbers.format(Math.min(current.page * CONTACTS_PER_PAGE, initial.total))} / ${numbers.format(initial.total)} 件を表示`;
        switch (current.kind) {
            case "ready":
                status.textContent = shown;
                break;
            case "loading":
                status.textContent = "つづきを読みこんでいます";
                break;
            case "complete":
                status.textContent = `${shown}（すべて表示しました）`;
                break;
            case "retry":
                status.textContent = "追加の読み込みを停止しました";
                errorMessage.textContent =
                    "通信が切れたか、サーバーが答えませんでした。表示済みの連絡先はそのまま残っています。";
                break;
            case "stale":
                status.textContent = "追加の読み込みを停止しました";
                errorMessage.textContent =
                    "データが更新されています。検索をやり直してください。";
                break;
            default: {
                const unreachable = current;
                throw new Error(String(unreachable));
            }
        }
    };
    const load = async () => {
        if (state.kind !== "ready" && state.kind !== "retry")
            return;
        const previous = state;
        const mode = previous.kind === "ready" ? previous.mode : "manual";
        const controller = new AbortController();
        state = { kind: "loading", page: previous.page, mode, controller };
        render();
        endpoint.searchParams.set("page", String(previous.page + 1));
        try {
            const response = await fetch(endpoint, {
                signal: controller.signal,
                headers: { Accept: "application/json" },
                credentials: "same-origin",
                cache: "no-store",
            });
            if (!response.ok)
                throw new Error("Request failed");
            if (response.headers.get("x-public-phonebook-snapshot") !== initial.snapshot)
                throw new SnapshotChanged();
            const raw = await response.json();
            if (controller.signal.aborted)
                return;
            const value = feedPayload(raw);
            if (value.snapshot !== initial.snapshot)
                throw new SnapshotChanged();
            if (value.page !== previous.page + 1 ||
                value.pages !== initial.pages ||
                value.total !== initial.total)
                throw new Error("Unexpected result page");
            const expected = value.shown - (value.page - 1) * CONTACTS_PER_PAGE;
            const documentPage = new DOMParser().parseFromString(value.html, "text/html");
            const records = Array.from(documentPage.body.children);
            const added = new Set();
            if (records.length !== expected ||
                records.some((node) => {
                    const id = node.getAttribute("data-contact-id");
                    if (node.tagName !== "ARTICLE" ||
                        !node.classList.contains("contact") ||
                        !id ||
                        seen.has(id) ||
                        added.has(id))
                        return true;
                    added.add(id);
                    return false;
                }))
                throw new Error("Invalid contact page");
            const fragment = document.createDocumentFragment();
            for (const record of records)
                fragment.appendChild(record);
            list.appendChild(fragment);
            for (const id of added)
                seen.add(id);
            state =
                value.page === value.pages
                    ? { kind: "complete", page: value.page }
                    : { kind: "ready", page: value.page, mode };
            root.dataset.page = String(value.page);
            observeTail();
        }
        catch (error) {
            if (controller.signal.aborted)
                return;
            state = {
                kind: error instanceof SnapshotChanged ? "stale" : "retry",
                page: previous.page,
            };
            observer?.disconnect();
        }
        finally {
            render();
        }
    };
    button.addEventListener("click", () => {
        void load();
    });
    retry.addEventListener("click", () => {
        void load();
    });
    if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver((entries) => {
            if (state.kind === "ready" &&
                state.mode === "automatic" &&
                entries.some((entry) => entry.isIntersecting))
                void load();
        }, { rootMargin: "120px" });
        observeTail();
    }
    window.addEventListener("pagehide", () => {
        if (state.kind === "suspended")
            return;
        let resume;
        if (state.kind === "loading") {
            state.controller.abort();
            resume = { kind: "ready", page: state.page, mode: state.mode };
        }
        else
            resume = state;
        state = { kind: "suspended", resume };
        observer?.disconnect();
        render();
    });
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted || state.kind !== "suspended")
            return;
        state = state.resume;
        render();
        observeTail();
    });
    render();
}
if (typeof document !== "undefined") {
    const root = document.getElementById("feed");
    if (root instanceof HTMLElement)
        enhanceFeed(root);
    const prefecture = document.getElementById("prefecture");
    const municipality = document.getElementById("municipality");
    if (prefecture instanceof HTMLSelectElement &&
        municipality instanceof HTMLSelectElement) {
        const choices = Array.from(municipality.options);
        const refresh = (reset) => {
            const selected = reset ? "" : municipality.value;
            municipality.replaceChildren(...choices.filter((option) => !option.value || option.value.startsWith(prefecture.value)));
            municipality.value = selected;
        };
        refresh(false);
        prefecture.addEventListener("change", () => refresh(true));
    }
}
