import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type ReactElement,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Category, categoryDefinitions } from "../core/catalog.ts";
import type { Contact, SearchResponse } from "../core/models.ts";
import { checkPageChain } from "../core/page-chain.ts";
import { canFetchNext } from "../core/search-policy.ts";
import { type WebSearch, webSearchParameters } from "../core/web-search.ts";
import { DirectoryError, getSearch } from "./client.ts";
import { LoadingError, ResultCard } from "./components.tsx";
import { CategoryIcon, Icon } from "./icons.tsx";
import type { ResultCardView } from "./result-cards.ts";
import * as css from "./styles.css.ts";

export type ResultSource = "server" | "local";

export interface GroupView {
  readonly category: Category;
  readonly total: number;
  readonly rows: readonly ResultCardView[];
  readonly server: SearchResponse | null;
}

export type Continuation = (
  category: Category,
  visible: number,
) => Promise<readonly ResultCardView[] | null>;

type LocalProgress = "idle" | "loading" | "failed";

const restartCodes: readonly string[] = [
  "snapshot_changed",
  "invalid_page",
  "invalid_cursor",
];

/**
 * Shows one category and continues it from the server or the device.
 * Rows are keyed by position, so the same ranking from either source keeps its elements and focus.
 */
export function GroupResults({
  group,
  source,
  search,
  snapshot,
  toCard,
  more,
  onOpenRow,
}: {
  readonly group: GroupView;
  readonly source: ResultSource;
  readonly search: WebSearch;
  readonly snapshot: string;
  readonly toCard: (contact: Contact) => ResultCardView;
  readonly more: Continuation;
  readonly onOpenRow: (card: ResultCardView) => void;
}): ReactElement | null {
  const categorySearch = { ...search, category: group.category };
  const key = webSearchParameters(categorySearch).toString();
  const queryKey = ["contact-category", snapshot, key];
  const client = useQueryClient();
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const focusFrom = useRef<number | null>(null);
  const [expanded, setExpanded] = useState(Boolean(search.category));
  const [localExtra, setLocalExtra] = useState<readonly ResultCardView[]>([]);
  const [localProgress, setLocalProgress] = useState<LocalProgress>("idle");
  const label =
    categoryDefinitions.find((category) => category.id === group.category)
      ?.label ?? group.category;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam, signal }) => {
      const params = webSearchParameters(categorySearch);
      if (pageParam) params.set("cursor", pageParam);
      const page = await getSearch(params, signal);
      if (page.data.some((contact) => contact.category !== group.category))
        throw new DirectoryError("invalid_page", "");
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
    ...(group.server
      ? { initialData: { pages: [group.server], pageParams: [search.cursor] } }
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
    () => [...group.rows, ...localExtra],
    [group.rows, localExtra],
  );
  const catchingUp = source === "local" && localRows.length < serverRows.length;
  const rows = source === "server" || catchingUp ? serverRows : localRows;
  const hasMore =
    source === "server"
      ? Boolean(query.hasNextPage)
      : !catchingUp && rows.length < group.total;
  const pending =
    source === "server" ? query.isFetching : localProgress === "loading";
  const failed =
    source === "server" ? query.isError : localProgress === "failed";

  /** Continues the device rows in pages until they reach the target count. */
  async function appendLocal(target: number): Promise<void> {
    let extra = localExtra;
    do {
      const page = await more(group.category, group.rows.length + extra.length);
      if (!page || page.length === 0) {
        setLocalProgress("failed");
        return;
      }
      extra = [...extra, ...page];
    } while (group.rows.length + extra.length < target);
    setLocalExtra(extra);
    setLocalProgress("idle");
  }

  const catchingUpNow = useRef(false);
  const catchUp = useEffectEvent(async (): Promise<void> => {
    if (catchingUpNow.current || localProgress !== "idle") return;
    catchingUpNow.current = true;
    await appendLocal(serverRows.length);
    catchingUpNow.current = false;
  });
  useEffect(() => {
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
    else setLocalProgress("idle");
  }

  useEffect(() => {
    const from = focusFrom.current;
    if (from === null || rows.length <= from) return;
    focusFrom.current = null;
    list.current?.children.item(from)?.querySelector("h3")?.focus();
  }, [rows.length]);

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

  if (group.total === 0) return null;
  const headingId = `category-${group.category}`;
  const next =
    source === "server"
      ? (query.data?.pages.at(-1)?.meta.nextCursor ?? "")
      : "";
  const loadingNext = hasMore && pending;
  return (
    <section
      className={css.resultGroup}
      data-result-category={group.category}
      aria-labelledby={headingId}
    >
      <h2 className={css.resultGroupHeading} id={headingId}>
        <CategoryIcon category={group.category} />
        <span>{label}</span>
        <span>{group.total.toLocaleString("ja-JP")}件</span>
      </h2>
      <ol className={css.results} ref={list}>
        {rows.map((card, position) => (
          <li key={position}>
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
            href={`/?${webSearchParameters({ ...categorySearch, cursor: next })}`}
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
              ? `${label}を読みこんでいます。`
              : `${label}をもっと見る`}
          </a>
        </div>
      )}
      {expanded && (
        <output className={css.srOnly}>
          {label}を{rows.length.toLocaleString("ja-JP")}件、読みこみました。
        </output>
      )}
    </section>
  );
}
