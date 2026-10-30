import { createFileRoute } from "@tanstack/react-router";
import {
  emptyWebSearch,
  hasSearch,
  parseSearchString,
  parseWebSearch,
  webSearchParameters,
} from "../core/web-search.ts";
import { DirectoryError, getCatalog, getContactGroups } from "../ui/client.ts";
import { SearchPage } from "../ui/search-page.tsx";

export const Route = createFileRoute("/")({
  validateSearch: (raw: Record<string, unknown>) => {
    const { error, ...parameters } = raw;
    const result = parseWebSearch(parameters);
    return result.ok && (error === undefined || error === "")
      ? { ...result.value, error: "" }
      : { ...emptyWebSearch, error: "invalid_query" };
  },
  staleTime: 60000,
  loader: async ({ location }) => {
    const catalog = await getCatalog();
    const parsed = parseWebSearch(parseSearchString(location.searchStr));
    const initialSearch = parsed.ok ? parsed.value : emptyWebSearch;
    const first = hasSearch(initialSearch)
      ? await getContactGroups(webSearchParameters(initialSearch))
      : null;
    if (first && first.meta.snapshot !== catalog.snapshot)
      throw new DirectoryError("snapshot_changed", "");
    return { catalog, first, initialSearch, invalid: !parsed.ok };
  },
  component: SearchPage,
});
