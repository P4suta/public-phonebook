import { useEffect, useState, useSyncExternalStore } from "react";
import * as v from "valibot";
import type { Category } from "../core/catalog.ts";
import {
  SearchIndexLocationSchema,
  SearchRankingLocationSchema,
} from "../core/dataset-storage.ts";
import type { IndexReadiness } from "../core/local-search-policy.ts";
import {
  indexProgressSteps,
  type LocalRow,
  type LocalSearchReply,
  LocalSearchReplySchema,
  type LocalSearchRequest,
} from "../core/local-search-protocol.ts";
import { requestJson } from "./client.ts";
import { catalogRegions, type RegionNames } from "./result-cards.ts";

export type LocalIndexStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "skipped";

export interface LocalIndexState {
  readonly status: LocalIndexStatus;
  readonly progress: number;
  readonly snapshot: string;
  readonly generation: number;
  readonly regions: RegionNames | null;
}

export interface LocalGroup {
  readonly category: string;
  readonly total: number;
  readonly rows: readonly LocalRow[];
}

export interface LocalResults {
  readonly total: number;
  readonly groups: readonly LocalGroup[];
}

export interface LocalPage {
  readonly category: string;
  readonly total: number;
  readonly visible: number;
  readonly rows: readonly LocalRow[];
}

type Answer = Extract<LocalSearchReply, { readonly id: number }>;
type Question =
  | Omit<Extract<LocalSearchRequest, { type: "search" }>, "id">
  | Omit<Extract<LocalSearchRequest, { type: "continue" }>, "id">;

const SaveDataSchema = v.object({ saveData: v.literal(true) });
const reducedData = "(prefers-reduced-data: reduce)";
const initialState: LocalIndexState = {
  status: "idle",
  progress: 0,
  snapshot: "",
  generation: 0,
  regions: null,
};

export function indexReadiness(status: LocalIndexStatus): IndexReadiness {
  if (status === "ready") return "ready";
  return status === "unavailable" || status === "skipped"
    ? "unavailable"
    : "loading";
}

/** Honors the browser's data saver, which Chromium exposes as Save-Data and other engines may expose as a media feature. */
function savesData(): boolean {
  return (
    v.is(SaveDataSchema, Reflect.get(navigator, "connection")) ||
    matchMedia(reducedData).matches
  );
}

/** Owns the search Worker, the index loading state, and request correlation for one page. */
export class LocalIndexClient {
  #state = initialState;
  readonly #listeners = new Set<() => void>();
  #worker: Worker | null = null;
  #requests = 0;
  readonly #pending = new Map<number, (answer: Answer | null) => void>();
  #reloading = false;
  #location: AbortController | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly current = (): LocalIndexState => this.#state;

  start(): void {
    if (this.#state.status !== "idle") return;
    if (typeof Worker === "undefined" || savesData()) {
      this.#update({ status: "skipped" });
      return;
    }
    this.#update({ status: "loading", progress: 0 });
    void this.#locate();
  }

  /** Replaces a stale index after the server reports a changed snapshot; searches keep using the current index meanwhile. */
  reload(): void {
    if (this.#state.status !== "ready" || this.#reloading) return;
    this.#reloading = true;
    void this.#locate();
  }

  async search(query: string): Promise<LocalResults | null> {
    const answer = await this.#ask({ type: "search", query });
    return answer?.type === "results" ? answer : null;
  }

  async page(
    query: string,
    category: Category,
    visible: number,
  ): Promise<LocalPage | null> {
    const answer = await this.#ask({
      type: "continue",
      query,
      category,
      visible,
    });
    return answer?.type === "page" ? answer : null;
  }

  /** Stops an unfinished load when the page is hidden, so leaving the page cancels nothing mid-flight; a shown page starts it again. */
  suspend(): void {
    if (this.#state.status !== "loading") return;
    this.dispose();
    this.#update(initialState);
  }

  dispose(): void {
    this.#location?.abort();
    this.#location = null;
    this.#worker?.terminate();
    this.#worker = null;
    this.#settle();
    this.#reloading = false;
    this.#state = initialState;
  }

  #update(change: Partial<LocalIndexState>): void {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) listener();
  }

  async #locate(): Promise<void> {
    const request = new AbortController();
    this.#location = request;
    try {
      const [index, ranking] = await Promise.all([
        requestJson("/api/search-index", request.signal).then((value) =>
          v.parse(SearchIndexLocationSchema, value),
        ),
        requestJson("/api/search-ranking", request.signal).then((value) =>
          v.parse(SearchRankingLocationSchema, value),
        ),
      ]);
      if (this.#location !== request) return;
      if (index.snapshot !== ranking.snapshot) {
        this.#fail();
        return;
      }
      this.#location = null;
      const message: LocalSearchRequest = { type: "load", index, ranking };
      this.#ensureWorker().postMessage(message);
    } catch {
      if (!request.signal.aborted) this.#fail();
    }
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(
      new URL("./local-search-worker.ts", import.meta.url),
      { name: "local-search" },
    );
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.#receive(event.data);
    });
    worker.addEventListener("error", () => {
      this.#fail();
    });
    this.#worker = worker;
    return worker;
  }

  #receive(data: unknown): void {
    const parsed = v.safeParse(LocalSearchReplySchema, data);
    if (!parsed.success) {
      this.#fail();
      return;
    }
    const reply = parsed.output;
    if (reply.type === "progress") {
      if (this.#state.status === "loading")
        this.#update({
          progress: Math.min(
            indexProgressSteps,
            Math.floor(
              (reply.received * indexProgressSteps) / Math.max(reply.total, 1),
            ),
          ),
        });
      return;
    }
    if (reply.type === "ready") {
      this.#reloading = false;
      this.#update({
        status: "ready",
        progress: indexProgressSteps,
        snapshot: reply.snapshot,
        generation: this.#state.generation + 1,
        regions: catalogRegions(reply),
      });
      return;
    }
    if (reply.type === "unavailable") {
      this.#fail();
      return;
    }
    const resolve = this.#pending.get(reply.id);
    this.#pending.delete(reply.id);
    resolve?.(reply);
  }

  #fail(): void {
    this.#location?.abort();
    this.#location = null;
    this.#worker?.terminate();
    this.#worker = null;
    this.#reloading = false;
    this.#settle();
    this.#update({ status: "unavailable", snapshot: "", regions: null });
  }

  #settle(): void {
    for (const resolve of this.#pending.values()) resolve(null);
    this.#pending.clear();
  }

  async #ask(question: Question): Promise<Answer | null> {
    const worker = this.#worker;
    if (!worker || this.#state.status !== "ready") return null;
    this.#requests += 1;
    const id = this.#requests;
    const message: LocalSearchRequest = { ...question, id };
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      worker.postMessage(message);
    });
  }
}

/** Starts loading the index after the first render and keeps the Worker for the page's lifetime. */
export function useLocalIndex(enabled: boolean): {
  readonly client: LocalIndexClient;
  readonly state: LocalIndexState;
} {
  const [client] = useState(() => new LocalIndexClient());
  const state = useSyncExternalStore(
    client.subscribe,
    client.current,
    () => initialState,
  );
  useEffect(() => {
    if (!enabled) return;
    const start = (): void => client.start();
    const suspend = (): void => client.suspend();
    start();
    window.addEventListener("pageshow", start);
    window.addEventListener("pagehide", suspend);
    return (): void => {
      window.removeEventListener("pageshow", start);
      window.removeEventListener("pagehide", suspend);
      client.dispose();
    };
  }, [client, enabled]);
  return { client, state };
}
