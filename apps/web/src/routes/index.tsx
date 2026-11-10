import type { GroupedSearchResponse } from "@public-phonebook/directory/models";
import {
  emptyWebSearch,
  hasSearch,
  parseSearchString,
  parseWebSearch,
  webSearchParameters,
} from "@public-phonebook/directory/web-search";
import { createFileRoute } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { DirectoryError, getCatalog, getContactGroups } from "../ui/client.ts";
import { SearchPage } from "../ui/search-page.tsx";

/** Renders the first results on the server; the page searches from the browser after that. */
const serverResults = createIsomorphicFn()
  .server(
    async (params: URLSearchParams): Promise<GroupedSearchResponse | null> =>
      getContactGroups(params),
  )
  .client(async (): Promise<GroupedSearchResponse | null> => null);

export const Route = createFileRoute("/")({
  validateSearch: (raw: Record<string, unknown>) => {
    const { error, ...parameters } = raw;
    const result = parseWebSearch(parameters);
    return result.ok && (error === undefined || error === "")
      ? { ...result.value, error: "" }
      : { ...emptyWebSearch, error: "invalid_query" };
  },
  shouldReload: false,
  loader: async ({ location }) => {
    const catalog = await getCatalog();
    const parsed = parseWebSearch(parseSearchString(location.searchStr));
    const initialSearch = parsed.ok ? parsed.value : emptyWebSearch;
    const first = hasSearch(initialSearch)
      ? await serverResults(webSearchParameters(initialSearch))
      : null;
    if (first && first.meta.snapshot !== catalog.snapshot)
      throw new DirectoryError("snapshot_changed", "");
    return { catalog, first, initialSearch, invalid: !parsed.ok };
  },
  component: SearchPage,
});
