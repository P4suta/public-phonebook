import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Info, Search as SearchIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as v from "valibot";
import { CategorySchema } from "../core/catalog.ts";
import { searchSource } from "../core/local-search-policy.ts";
import type { LocalRow } from "../core/local-search-protocol.ts";
import type { Contact, GroupedSearchResponse } from "../core/models.ts";
import {
  completeTelephone,
  inputScript,
  insertionEvent,
  keystrokeIntervals,
  pauseDelay,
} from "../core/search-input.ts";
import {
  type SearchEvent,
  searchTrigger,
} from "../core/search-trigger-policy.ts";
import {
  hasSearch,
  parseWebSearch,
  webSearchParameters,
} from "../core/web-search.ts";
import { Route } from "../routes/index.tsx";
import { DirectoryError, getContactGroups, getRowLocation } from "./client.ts";
import { LinkButton, LoadingError } from "./components.tsx";
import { uiCopy } from "./copy.ts";
import { ErrorPage } from "./error-page.tsx";
import { foundation } from "./foundations.ts";
import {
  type Continuation,
  GroupResults,
  type GroupView,
  type ResultSource,
} from "./group-results.tsx";
import {
  indexReadiness,
  type LocalIndexClient,
  type LocalResults,
  useLocalIndex,
} from "./local-index.ts";
import {
  catalogRegions,
  localCard,
  type RegionNames,
  type ResultCardView,
  serverCard,
} from "./result-cards.ts";
import * as css from "./styles.css.ts";

const settleMilliseconds = 120;
const announcementDelayMilliseconds = 600;
const restartCodes: readonly string[] = [
  "snapshot_changed",
  "invalid_page",
  "invalid_cursor",
];

interface ResultsView {
  readonly key: string;
  readonly epoch: number;
  readonly source: ResultSource;
  readonly total: number;
  readonly groups: readonly GroupView[];
  readonly more: Continuation;
}

interface LocalView {
  readonly key: string;
  readonly generation: number;
  readonly query: string;
  readonly snapshot: string;
  readonly regions: RegionNames;
  readonly results: LocalResults;
}

// Server results share the first index's epoch, so the first switch keeps each group mounted.
const firstIndexGeneration = 1;
const noContinuation = async (): Promise<null> => null;

export function SearchPage(): ReactElement {
  const { catalog, first, initialSearch, invalid } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const { client, state: index } = useLocalIndex(!invalid && !search.error);
  const [draft, setDraft] = useState<{
    readonly input: string;
    readonly observed: string;
    readonly submitted: string;
    readonly event: SearchEvent;
  }>({
    input: search.q,
    observed: search.q,
    submitted: search.q,
    event: "change",
  });
  if (draft.observed !== search.q) {
    setDraft({
      ...draft,
      observed: search.q,
      input: search.q === draft.submitted ? draft.input : search.q,
    });
  }
  const input = draft.input;
  function edit(value: string, event: SearchEvent): void {
    setDraft((previous) => ({ ...previous, input: value, event }));
  }
  const [composing, setComposing] = useState(false);
  const [rowUpdatedFor, setRowUpdatedFor] = useState<string | null>(null);
  const [localView, setLocalView] = useState<LocalView | null>(null);
  const keystrokes = useRef<number[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const restoredInput = useRef(false);
  const active = hasSearch(search);
  const key = webSearchParameters(search).toString();
  const localKey = webSearchParameters({ ...search, cursor: "" }).toString();
  const initialKey = webSearchParameters(initialSearch).toString();
  const queryKey = ["contact-groups", catalog.snapshot, key];
  const readiness = indexReadiness(index.status);
  const local = index.status === "ready" && !search.cursor;
  const returnTo = `/${key ? `?${key}` : ""}`;
  const regions = useMemo(() => catalogRegions(catalog), [catalog]);
  const toCard = useCallback(
    (contact: Contact) => serverCard(contact, regions, returnTo),
    [regions, returnTo],
  );

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const result = await getContactGroups(
        webSearchParameters(search),
        signal,
      );
      if (result.meta.snapshot !== catalog.snapshot)
        throw new DirectoryError("snapshot_changed", "");
      return result;
    },
    ...(first && key === initialKey ? { initialData: first } : {}),
    enabled: active && !local,
    retry: (failureCount, error) =>
      !(error instanceof DirectoryError && error.code === "snapshot_changed") &&
      failureCount < 1,
  });

  useEffect(() => {
    if (!local || !active || !index.regions) return;
    let current = true;
    const { snapshot, generation, regions: names } = index;
    const view = (results: LocalResults): void => {
      if (current)
        setLocalView({
          key: localKey,
          generation,
          query: search.q,
          snapshot,
          regions: names,
          results,
        });
    };
    if (search.category)
      void client.page(search.q, search.category, 0).then((page) => {
        if (page)
          view({
            total: page.total,
            groups: [
              { category: page.category, total: page.total, rows: page.rows },
            ],
          });
      });
    else
      void client.search(search.q).then((results) => {
        if (results) view(results);
      });
    return (): void => {
      current = false;
    };
  }, [local, active, localKey, search.q, search.category, index, client]);

  const searchFor = useCallback(
    (q: string, replace: boolean): void => {
      setDraft((previous) => ({ ...previous, submitted: q }));
      if (!q) setLocalView(null);
      void navigate({
        to: "/",
        search: { q, category: "", cursor: "", error: "" },
        replace,
        resetScroll: false,
      });
    },
    [navigate],
  );

  useEffect(() => {
    if (restoredInput.current || !form.current) return;
    restoredInput.current = true;
    const restored = parseWebSearch(
      Object.fromEntries(new FormData(form.current)),
    );
    if (restored.ok && restored.value.q !== search.q)
      void navigate({
        to: "/",
        search: { q: restored.value.q, category: "", cursor: "", error: "" },
        replace: true,
        resetScroll: false,
      });
  }, [search.q, navigate]);

  useEffect(() => {
    const q = input.trim();
    if (q === search.q) return;
    const script = inputScript(input);
    const intervals = keystrokeIntervals(keystrokes.current);
    const trigger =
      searchSource(q !== "", composing, readiness) === "local"
        ? "search"
        : searchTrigger(
            script,
            draft.event,
            composing,
            script === "telephone" && completeTelephone(input),
            intervals.length,
          );
    if (trigger === "wait") return;
    const timeout = window.setTimeout(
      () => searchFor(q, true),
      trigger === "search"
        ? 0
        : trigger === "settle"
          ? settleMilliseconds
          : pauseDelay(intervals),
    );
    return (): void => window.clearTimeout(timeout);
  }, [input, draft.event, composing, search.q, readiness, searchFor]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    searchFor(input.trim(), false);
  }

  const openRow = useCallback(
    (card: ResultCardView): void => {
      const { row } = card;
      if (!row) return;
      void (async (): Promise<void> => {
        try {
          const located = await getRowLocation(row.snapshot, String(row.row));
          window.location.assign(
            `/contacts/${encodeURIComponent(located.id)}?from=${encodeURIComponent(returnTo)}`,
          );
        } catch (error) {
          if (
            error instanceof DirectoryError &&
            error.code === "snapshot_changed"
          ) {
            setRowUpdatedFor(search.q);
            client.reload();
            return;
          }
          window.location.assign(card.href);
        }
      })();
    },
    [client, returnTo, search.q],
  );

  const serverView = useMemo(
    (): ResultsView | null =>
      query.data ? fromServer(query.data, key, toCard) : null,
    [query.data, key, toCard],
  );
  const view = useMemo((): ResultsView | null => {
    const localResults = localView
      ? fromLocal(localView, client, returnTo)
      : null;
    if (!local) return serverView;
    if (localView?.key === localKey) return localResults;
    if (serverView?.key === localKey) return serverView;
    return localResults;
  }, [local, localView, localKey, serverView, client, returnTo]);

  const countText = !active
    ? ""
    : view
      ? uiCopy.search.found(view.total.toLocaleString("ja-JP"))
      : query.isFetching
        ? uiCopy.search.searching
        : "";
  const [announced, setAnnounced] = useState(countText);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setAnnounced(countText),
      announcementDelayMilliseconds,
    );
    return (): void => window.clearTimeout(timeout);
  }, [countText, input]);

  if (invalid || search.error)
    return <ErrorPage title={uiCopy.search.invalid} />;

  return (
    <main id="main" className={`${css.page} ${!active ? css.home : ""}`}>
      <div className={css.searchLayout}>
        <div className={css.searchIntro}>
          {!active && (
            <div className={css.homeHeading}>
              <h1 className={css.brand}>Public Phonebook</h1>
              <nav aria-label="サービスの情報" className={css.actions}>
                <LinkButton href="/about" icon={Info}>
                  {uiCopy.about}
                </LinkButton>
              </nav>
            </div>
          )}
          <div className={css.searchGroup}>
            <label className={css.fieldLabel} htmlFor="directory-search">
              {uiCopy.search.label}
            </label>
            <p id="directory-search-hint" className={css.searchHint}>
              {uiCopy.search.hint.join("\n")}
            </p>
          </div>
        </div>
        <search
          className={css.searchArea}
          data-local-search={index.status}
          data-index-generation={index.generation}
        >
          <form
            ref={form}
            method="get"
            action="/"
            className={css.searchForm}
            onSubmit={submit}
          >
            <div className={css.searchField}>
              <input
                id="directory-search"
                name="q"
                className={css.input}
                aria-describedby="directory-search-hint"
                enterKeyHint="search"
                value={input}
                onFocus={() => {
                  keystrokes.current = [];
                }}
                onChange={(event) => {
                  keystrokes.current.push(performance.now());
                  const native = event.nativeEvent;
                  edit(
                    event.target.value,
                    native instanceof InputEvent
                      ? insertionEvent(native.inputType, native.data)
                      : "change",
                  );
                }}
                onBlur={() =>
                  setDraft((previous) => ({ ...previous, event: "blur" }))
                }
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={(event) => {
                  setComposing(false);
                  edit(event.currentTarget.value, "change");
                }}
                autoComplete="off"
                type="search"
              />
              <button className={css.searchButton} type="submit">
                <SearchIcon size={foundation.control.icon} aria-hidden="true" />
                {uiCopy.search.action}
              </button>
              {index.status === "loading" && (
                <span className={css.indexProgress} aria-hidden="true">
                  <span
                    className={css.indexProgressFill[index.progress] ?? ""}
                  />
                </span>
              )}
            </div>
          </form>
        </search>
        {active && (
          <>
            <div className={css.toolbar}>
              <h1 className={css.srOnly}>検索結果</h1>
              <p className={css.body} aria-hidden="true">
                {countText}
              </p>
              <output id="search-status" className={css.srOnly}>
                {announced}
              </output>
            </div>
            {rowUpdatedFor === search.q && (
              <section className={css.stack}>
                <h2 className={css.subheading}>{uiCopy.rowUpdated.title}</h2>
                <output className={css.body}>
                  {uiCopy.rowUpdated.searchedAgain}
                </output>
              </section>
            )}
            {!local && query.isError && (
              <LoadingError
                restartHref={
                  query.error instanceof DirectoryError &&
                  restartCodes.includes(query.error.code)
                    ? `/?${webSearchParameters({ ...search, cursor: "" })}`
                    : undefined
                }
                retry={() => {
                  void query.refetch();
                }}
              />
            )}
            {view?.total === 0 && (
              <section className={css.stack}>
                <h2 className={css.subheading}>{uiCopy.search.none}</h2>
                <p className={css.body}>{uiCopy.search.empty}</p>
              </section>
            )}
            <div className={css.resultGroups}>
              {view?.groups.map((group) => (
                <GroupResults
                  key={`${view.key}:${view.epoch}:${group.category}`}
                  group={group}
                  source={view.source}
                  search={
                    view.source === "local" ? { ...search, cursor: "" } : search
                  }
                  snapshot={catalog.snapshot}
                  toCard={toCard}
                  more={view.more}
                  onOpenRow={openRow}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function fromServer(
  response: GroupedSearchResponse,
  key: string,
  toCard: (contact: Contact) => ResultCardView,
): ResultsView {
  return {
    key,
    epoch: firstIndexGeneration,
    source: "server",
    total: response.meta.total,
    groups: response.groups.map((group) => ({
      category: group.category,
      total: group.results.meta.total,
      rows: group.results.data.map(toCard),
      server: group.results,
    })),
    more: noContinuation,
  };
}

function fromLocal(
  view: LocalView,
  client: LocalIndexClient,
  returnTo: string,
): ResultsView {
  const card = (row: LocalRow): ResultCardView =>
    localCard(row, view.snapshot, view.regions, returnTo);
  return {
    key: view.key,
    epoch: Math.max(view.generation, firstIndexGeneration),
    source: "local",
    total: view.results.total,
    groups: view.results.groups.map((group) => ({
      category: v.parse(CategorySchema, group.category),
      total: group.total,
      rows: group.rows.map(card),
      server: null,
    })),
    more: async (category, visible) => {
      const page = await client.page(view.query, category, visible);
      return page ? page.rows.map(card) : null;
    },
  };
}
