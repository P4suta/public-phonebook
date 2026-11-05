import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type ReactElement,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Contact, SearchResponse } from "../core/models.ts";
import { checkPageChain } from "../core/page-chain.ts";
import { canFetchNext } from "../core/search-policy.ts";
import { type WebSearch, webSearchParameters } from "../core/web-search.ts";
import { DirectoryError, getSearch } from "./client.ts";
import { LoadingError, ResultCard } from "./components.tsx";
import { Icon } from "./icons.tsx";
import { type ResultCardView, resultIdentity } from "./result-cards.ts";
import * as css from "./styles.css.ts";

export type ResultSource = "server" | "local";

export interface RankedView {
  readonly total: number;
  readonly rows: readonly ResultCardView[];
  readonly server: SearchResponse | null;
}

export type Continuation = (
  visible: number,
) => Promise<readonly ResultCardView[] | null>;

type LocalProgress = "idle" | "loading" | "failed";

const restartCodes: readonly string[] = [
  "snapshot_changed",
  "invalid_page",
  "invalid_cursor",
];

/**
 * Continues one ranked list from the server or the device.
 * Matching card content keeps its elements and focus across engine changes.
 */
export function RankedResults({
  result,
  source,
  search,
  snapshot,
  toCard,
  more,
  onOpenRow,
}: {
  readonly result: RankedView;
  readonly source: ResultSource;
  readonly search: WebSearch;
  readonly snapshot: string;
  readonly toCard: (contact: Contact) => ResultCardView;
  readonly more: Continuation;
  readonly onOpenRow: (card: ResultCardView) => void;
}): ReactElement | null {
  const key = webSearchParameters(search).toString();
  const queryKey = ["contact-list", snapshot, key];
  const client = useQueryClient();
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const focusFrom = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [localExtra, setLocalExtra] = useState<readonly ResultCardView[]>([]);
  const [localProgress, setLocalProgress] = useState<LocalProgress>("idle");
  const focused = useRef<HTMLElement | null>(null);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const params = webSearchParameters(search);
      if (pageParam) params.set("cursor", pageParam);
      const page = await getSearch(params, signal);
      const cached =
        client.getQueryData<InfiniteData<SearchResponse, string>>(queryKey);
      const index = cached?.pageParams.indexOf(pageParam) ?? -1;
      const previous =
        pageParam === search.cursor
          ? []
          : (cached?.pages.slice(0, index < 0 ? undefined : index) ?? []);
      const checked = checkPageChain(page, previous, pageParam, snapshot);
      if (!checked.ok) throw new DirectoryError(checked.error, "");
      return checked.value;
    },
    initialPageParam: search.cursor,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    ...(result.server
      ? { initialData: { pages: [result.server], pageParams: [search.cursor] } }
      : {}),
    enabled: false,
    staleTime: Infinity,
    retry: (count, error) =>
      !(error instanceof DirectoryError && restartCodes.includes(error.code)) &&
      count < 1,
  });
  const serverRows = useMemo(
    () => query.data?.pages.flatMap((page) => page.data.map(toCard)) ?? [],
    [query.data, toCard],
  );
  const localRows = useMemo(
    () => [...result.rows, ...localExtra],
    [result.rows, localExtra],
  );
  const catchUpTarget = Math.min(serverRows.length, result.total);
  const catchingUp = source === "local" && localRows.length < catchUpTarget;
  const rows = source === "server" || catchingUp ? serverRows : localRows;
  const hasMore =
    source === "server"
      ? Boolean(query.hasNextPage)
      : !catchingUp && rows.length < result.total;
  const pending =
    source === "server" ? query.isFetching : localProgress === "loading";
  const failed =
    source === "server" ? query.isError : localProgress === "failed";

  /** Continues the device rows in pages until they reach the target count. */
  async function appendLocal(target: number): Promise<void> {
    let extra = localExtra;
    do {
      const page = await more(result.rows.length + extra.length);
      if (!page || page.length === 0) {
        setLocalProgress("failed");
        return;
      }
      extra = [...extra, ...page];
    } while (result.rows.length + extra.length < target);
    setLocalExtra(extra);
    setLocalProgress("idle");
  }

  const catchingUpNow = useRef(false);
  const catchUp = useEffectEvent(async (): Promise<void> => {
    if (catchingUpNow.current || localProgress !== "idle") return;
    catchingUpNow.current = true;
    await appendLocal(catchUpTarget);
    catchingUpNow.current = false;
  });
  useLayoutEffect(() => {
    if (catchingUp) void catchUp();
  }, [catchingUp]);

  async function loadMore(explicit: boolean): Promise<void> {
    if (!canFetchNext(hasMore, pending, failed)) return;
    focusFrom.current = explicit ? rows.length : null;
    if (source === "server") {
      await query.fetchNextPage({ cancelRefetch: false });
      return;
    }
    setLocalProgress("loading");
    await appendLocal(rows.length + 1);
  }

  function retry(): void {
    if (source === "server") void query.fetchNextPage({ cancelRefetch: false });
    else {
      setLocalProgress("loading");
      void appendLocal(rows.length + 1);
    }
  }

  useLayoutEffect(() => {
    const from = focusFrom.current;
    if (from === null || rows.length <= from) return;
    focusFrom.current = null;
    list.current?.children.item(from)?.querySelector("h2")?.focus();
  }, [rows.length]);
  useLayoutEffect(() => {
    if (
      focused.current &&
      !focused.current.isConnected &&
      document.activeElement === document.body
    )
      document.getElementById("directory-search")?.focus();
  }, [rows]);

  const continueOnView = useEffectEvent((): void => {
    void loadMore(false);
  });
  const observing = expanded && canFetchNext(hasMore, pending, failed);
  useEffect(() => {
    const node = sentinel.current;
    if (!observing || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) continueOnView();
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [observing]);

  const keyedRows = useMemo(() => {
    const occurrences = new Map<string, number>();
    return rows.map((card) => {
      const identity = resultIdentity(card);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return { card, key: `${identity}:${occurrence}` };
    });
  }, [rows]);
  if (result.total === 0) return null;
  const next =
    source === "server"
      ? (query.data?.pages.at(-1)?.meta.nextCursor ?? "")
      : "";
  const loadingNext = hasMore && pending;
  return (
    <section
      className={css.stack}
      data-result-list={source}
      aria-label="検索結果"
      onFocusCapture={(event) => {
        focused.current = event.target;
      }}
    >
      <ol className={css.results} ref={list}>
        {keyedRows.map(({ card, key }) => (
          <li key={key}>
            <ResultCard card={card} onOpenRow={onOpenRow} />
          </li>
        ))}
      </ol>
      {failed && (
        <LoadingError
          restartHref={
            source === "server" &&
            query.error instanceof DirectoryError &&
            restartCodes.includes(query.error.code)
              ? `/?${webSearchParameters({ ...search, cursor: "" })}`
              : undefined
          }
          retry={retry}
        />
      )}
      {hasMore && (
        <div className={css.actions} ref={sentinel}>
          <a
            className={css.button}
            href={`/?${webSearchParameters({ ...search, cursor: next })}`}
            aria-disabled={loadingNext}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              setExpanded(true);
              void loadMore(true);
            }}
          >
            <Icon name="chevron-down" />
            {loadingNext
              ? "検索結果を読みこんでいます。"
              : "検索結果をもっと見る"}
          </a>
        </div>
      )}
      {expanded && (
        <output className={css.srOnly}>
          検索結果を{rows.length.toLocaleString("ja-JP")}件、読みこみました。
        </output>
      )}
    </section>
  );
}
