import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Info, Search as SearchIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import * as v from "valibot";
import {
  CategorySchema,
  MunicipalityCodeSchema,
  PrefectureCodeSchema,
} from "../core/catalog.ts";
import {
  completeTelephone,
  inputScript,
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
import { DirectoryError, getContactGroups } from "./client.ts";
import { LinkButton, LoadingError } from "./components.tsx";
import { uiCopy } from "./copy.ts";
import { ErrorPage } from "./error-page.tsx";
import { foundation } from "./foundations.ts";
import { GroupResults } from "./group-results.tsx";
import * as css from "./styles.css.ts";

const settleMilliseconds = 120;

export function SearchPage(): ReactElement {
  const { catalog, first, initialSearch, invalid } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
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
  const keystrokes = useRef<number[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const restoredInput = useRef(false);
  const active = hasSearch(search);
  const key = webSearchParameters(search).toString();
  const initialKey = webSearchParameters(initialSearch).toString();
  const queryKey = ["contact-groups", catalog.snapshot, key];
  useEffect(() => {
    if (restoredInput.current || !form.current) return;
    restoredInput.current = true;
    const restored = parseWebSearch(
      Object.fromEntries(new FormData(form.current)),
    );
    if (restored.ok && webSearchParameters(restored.value).toString() !== key) {
      void navigate({
        to: "/",
        search: { ...restored.value, error: "" },
        replace: true,
        resetScroll: false,
      });
    }
  }, [key, navigate]);
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
    enabled: active,
    retry: (failureCount, error) =>
      !(error instanceof DirectoryError && error.code === "snapshot_changed") &&
      failureCount < 1,
  });

  useEffect(() => {
    const q = input.trim();
    if (q === search.q) return;
    const script = inputScript(input);
    const intervals = keystrokeIntervals(keystrokes.current);
    const trigger = searchTrigger(
      script,
      draft.event,
      composing,
      script === "telephone" && completeTelephone(input),
      intervals.length,
    );
    if (trigger === "wait") return;
    const timeout = window.setTimeout(
      () => {
        setDraft((previous) => ({ ...previous, submitted: q }));
        void navigate({
          to: "/",
          search: { ...search, q, cursor: "" },
          replace: true,
          resetScroll: false,
        });
      },
      trigger === "search"
        ? 0
        : trigger === "settle"
          ? settleMilliseconds
          : pauseDelay(intervals),
    );
    return (): void => window.clearTimeout(timeout);
  }, [input, draft.event, composing, search, navigate]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDraft((previous) => ({ ...previous, submitted: input.trim() }));
    void navigate({
      to: "/",
      search: { ...search, q: input.trim(), cursor: "" },
      replace: false,
      resetScroll: false,
    });
  }

  function changeRegion(value: string): void {
    const prefecture = value ? v.parse(PrefectureCodeSchema, value) : "";
    void navigate({
      to: "/",
      search: { ...search, prefecture, municipality: "", cursor: "" },
      replace: false,
      resetScroll: false,
    });
  }

  const groups = query.data?.groups ?? [];
  const total = query.data?.meta.total;
  const cities = catalog.municipalities.filter(
    (city) => city.prefectureCode === search.prefecture,
  );
  const returnTo = `/${key ? `?${key}` : ""}`;

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
        <search className={css.searchArea}>
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
                  const inserted =
                    event.nativeEvent instanceof InputEvent
                      ? event.nativeEvent.data
                      : null;
                  edit(
                    event.target.value,
                    inserted && /\s$/u.test(inserted) ? "space" : "change",
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
            </div>
            <div
              className={css.filters}
              data-has-city={Boolean(search.prefecture)}
            >
              <Filter
                label="都道府県"
                name="prefecture"
                value={search.prefecture}
                onChange={changeRegion}
              >
                <option value="">{uiCopy.search.prefecture}</option>
                {catalog.prefectures.map((prefecture) => (
                  <option key={prefecture.code} value={prefecture.code}>
                    {prefecture.name}
                  </option>
                ))}
              </Filter>
              {search.prefecture && (
                <Filter
                  label="市区町村"
                  name="municipality"
                  value={search.municipality}
                  onChange={(value) => {
                    const municipality = value
                      ? v.parse(MunicipalityCodeSchema, value)
                      : "";
                    void navigate({
                      to: "/",
                      search: { ...search, municipality, cursor: "" },
                      resetScroll: false,
                    });
                  }}
                >
                  <option value="">{uiCopy.search.municipality}</option>
                  {cities.map((city) => (
                    <option key={city.code} value={city.code}>
                      {city.name}
                    </option>
                  ))}
                </Filter>
              )}
              <Filter
                label="施設や窓口の種類"
                name="category"
                value={search.category}
                onChange={(value) => {
                  const category = value ? v.parse(CategorySchema, value) : "";
                  void navigate({
                    to: "/",
                    search: { ...search, category, cursor: "" },
                    resetScroll: false,
                  });
                }}
              >
                <option value="">{uiCopy.search.category}</option>
                {catalog.categories
                  .filter((category) => category.contacts > 0)
                  .map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
              </Filter>
            </div>
          </form>
        </search>
        {active && (
          <>
            <div className={css.toolbar}>
              <h1 className={css.srOnly}>検索結果</h1>
              <output>
                {query.isFetching && !query.data
                  ? uiCopy.search.searching
                  : total !== undefined
                    ? uiCopy.search.found(total.toLocaleString("ja-JP"))
                    : ""}
              </output>
            </div>
            {query.isError && (
              <LoadingError
                restartHref={
                  query.error instanceof DirectoryError &&
                  [
                    "snapshot_changed",
                    "invalid_page",
                    "invalid_cursor",
                  ].includes(query.error.code)
                    ? `/?${webSearchParameters({ ...search, cursor: "" })}`
                    : undefined
                }
                retry={() => {
                  void query.refetch();
                }}
              />
            )}
            {!query.isPending && !query.isError && total === 0 && (
              <section className={css.stack}>
                <h2 className={css.subheading}>{uiCopy.search.none}</h2>
                <p className={css.body}>{uiCopy.search.empty}</p>
              </section>
            )}
            <div className={css.resultGroups}>
              {groups.map((group) => (
                <GroupResults
                  key={`${key}:${group.category}`}
                  group={group}
                  search={search}
                  snapshot={catalog.snapshot}
                  returnTo={returnTo}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Filter({
  label,
  name,
  value,
  onChange,
  children,
}: {
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: React.ReactNode;
}): ReactElement {
  return (
    <div className={css.filter}>
      <label className={css.fieldLabel} htmlFor={`filter-${name}`}>
        {label}
      </label>
      <span className={css.selection}>
        <select
          id={`filter-${name}`}
          name={name}
          className={css.select}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {children}
        </select>
        <ChevronDown className={css.chevron} aria-hidden="true" />
      </span>
    </div>
  );
}
