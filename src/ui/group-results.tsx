import {
  type InfiniteData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { categoryDefinitions } from "../core/catalog.ts";
import type { GroupedSearchResponse, SearchResponse } from "../core/models.ts";
import { checkPageChain } from "../core/page-chain.ts";
import { canFetchNext } from "../core/search-policy.ts";
import { type WebSearch, webSearchParameters } from "../core/web-search.ts";
import { DirectoryError, getSearch } from "./client.ts";
import { ContactCard, LoadingError } from "./components.tsx";
import { CategoryIcon } from "./icons.tsx";
import * as css from "./styles.css.ts";

export function GroupResults({
  group,
  search,
  snapshot,
  returnTo,
}: {
  readonly group: GroupedSearchResponse["groups"][number];
  readonly search: WebSearch;
  readonly snapshot: string;
  readonly returnTo: string;
}): ReactElement | null {
  const categorySearch = { ...search, category: group.category };
  const key = webSearchParameters(categorySearch).toString();
  const queryKey = ["contact-category", snapshot, key];
  const client = useQueryClient();
  const sentinel = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(Boolean(search.category));
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
    initialData: { pages: [group.results], pageParams: [search.cursor] },
    staleTime: Infinity,
    retry: (count, error) =>
      !(
        error instanceof DirectoryError &&
        ["snapshot_changed", "invalid_page", "invalid_cursor"].includes(
          error.code,
        )
      ) && count < 1,
  });
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  useEffect(() => {
    const node = sentinel.current;
    if (
      !expanded ||
      !node ||
      !canFetchNext(Boolean(hasNextPage), isFetching, isError)
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void fetchNextPage({ cancelRefetch: false });
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [expanded, hasNextPage, isFetching, isError, fetchNextPage]);

  const pages = query.data.pages;
  const rows = pages.flatMap((page) => page.data);
  const total = group.results.meta.total;
  if (total === 0) return null;
  const headingId = `category-${group.category}`;
  const next = pages.at(-1)?.meta.nextCursor ?? "";
  return (
    <section
      className={css.resultGroup}
      data-result-category={group.category}
      aria-labelledby={headingId}
    >
      <h2 className={css.resultGroupHeading} id={headingId}>
        <CategoryIcon category={group.category} />
        <span>{label}</span>
        <span>{total.toLocaleString("ja-JP")}件</span>
      </h2>
      <ol className={css.results}>
        {rows.map((contact) => (
          <li key={contact.id}>
            <ContactCard contact={contact} grouped returnTo={returnTo} />
          </li>
        ))}
      </ol>
      {query.isError && (
        <LoadingError
          restartHref={
            query.error instanceof DirectoryError &&
            ["snapshot_changed", "invalid_page", "invalid_cursor"].includes(
              query.error.code,
            )
              ? `/?${webSearchParameters({ ...search, cursor: "" })}`
              : undefined
          }
          retry={() => {
            void query.fetchNextPage({ cancelRefetch: false });
          }}
        />
      )}
      {query.hasNextPage && (
        <div className={css.actions} ref={sentinel}>
          <a
            className={css.button}
            href={`/?${webSearchParameters({ ...categorySearch, cursor: next })}`}
            aria-disabled={query.isFetchingNextPage}
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
              if (
                !canFetchNext(
                  Boolean(query.hasNextPage),
                  query.isFetching,
                  query.isError,
                )
              )
                return;
              setExpanded(true);
              void query.fetchNextPage({ cancelRefetch: false });
            }}
          >
            <ChevronDown aria-hidden="true" />
            {query.isFetchingNextPage
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
