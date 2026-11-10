import type { Page, Request } from "@playwright/test";
import { SearchIndexLocationSchema } from "@public-phonebook/directory/dataset-storage";
import { GroupedSearchResponseSchema } from "@public-phonebook/directory/models";
import * as v from "valibot";
import { expect, test } from "./fixtures.ts";
import { recordFullPage } from "./full-page-screenshot.ts";
import {
  contactLinks,
  holdIndex,
  saveData,
  searchSource,
  waitForLocalSearch,
} from "./search-sources.ts";

const query = "国立国会図書館";
const announcementDelay = 600;
const indexReloadTimeout = 60_000;
const indexLocation = "/api/search-index";
const loadedAt = new Date("2026-11-02T00:00:00Z");
const typingFrom = new Date("2026-11-02T01:00:00Z");

async function temporaryDirectories(page: Page): Promise<readonly string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle("public-phonebook-search");
    const names: string[] = [];
    for await (const name of parent.keys()) names.push(name);
    return names;
  });
}

test("temporary search files preserve active tabs and remove terminated workers", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await waitForLocalSearch(page);
  const second = await context.newPage();
  await second.goto("/");
  await waitForLocalSearch(second);
  await expect
    .poll(async () => (await temporaryDirectories(page)).length)
    .toBe(2);
  await second.close();
  const third = await context.newPage();
  try {
    await third.goto("/");
    await waitForLocalSearch(third);
    await expect
      .poll(async () => (await temporaryDirectories(page)).length)
      .toBe(2);
    await page.getByRole("searchbox").fill(query);
    await expect(
      page.locator("article").first().getByRole("heading"),
    ).toHaveText(query);
    await third.getByRole("searchbox").fill(query);
    await expect(
      third.locator("article").first().getByRole("heading"),
    ).toHaveText(query);
  } finally {
    await third.close();
  }
});

test("WebKit private browsing uses the server when search storage is unavailable", async ({
  browser,
  browserName,
}) => {
  test.skip(
    browserName !== "webkit",
    "WebKit private browsing denies the storage API",
  );
  const privateContext = await browser.newContext();
  try {
    const page = await privateContext.newPage();
    await page.goto("/");
    await expect(searchSource(page)).toHaveAttribute(
      "data-local-search",
      "unavailable",
    );
    await page.getByRole("searchbox").fill(query);
    await expect(
      page.locator("article").first().getByRole("heading"),
    ).toHaveText(query);
  } finally {
    await privateContext.close();
  }
});

test("built device search matches verified place readings with only the name index", async ({
  page,
  request,
}, testInfo) => {
  const companions: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/search-ranking"))
      companions.push(request.url());
  });
  await page.route("**/api/search-ranking**", (route) => route.abort());
  await page.goto("/");
  await waitForLocalSearch(page);
  await expect(page.getByRole("searchbox")).toHaveAccessibleDescription(
    "都道府県名と主な分類名は、2文字以上の読み仮名でもさがせます。",
  );
  const library = page.locator('[data-result-category="library"]');
  for (const text of [
    "図書館",
    "としょかん",
    "東京 図書館",
    "とうきょう としょかん",
  ] as const) {
    const response: unknown = await (
      await request.get(
        `/api/contact-groups?${new URLSearchParams({ q: text })}`,
      )
    ).json();
    const expected = v
      .parse(GroupedSearchResponseSchema, response)
      .groups.find((group) => group.category === "library");
    if (!expected)
      throw new Error(`The served data has no libraries for ${text}`);
    expect(expected.results.data.length).toBeGreaterThan(0);
    await page.getByRole("searchbox").fill(text);
    await expect(
      library.getByRole("heading", { level: 2 }),
    ).toHaveAccessibleName(
      `図書館 ${expected.results.meta.total.toLocaleString("ja-JP")}件`,
    );
    await expect(library.locator("article").getByRole("heading")).toHaveText(
      expected.results.data.map((contact) => contact.name),
    );
    await page.getByRole("searchbox").fill("");
    await expect(page.locator("article")).toHaveCount(0);
  }
  await page.getByRole("searchbox").fill("とうきょう としょかん");
  await expect(library.locator("article")).not.toHaveCount(0);
  await recordFullPage(page, testInfo, "place-readings");
  await page.getByRole("searchbox").fill(query);
  await expect(page.locator("article")).toHaveCount(3);
  expect(companions).toEqual([]);
});

function contactRequest(request: Request): boolean {
  return new URL(request.url()).pathname.startsWith("/api/contact");
}

function carriesQuery(request: Request, text: string): boolean {
  const parts = [
    request.url(),
    request.postData() ?? "",
    ...Object.values(request.headers()),
  ];
  return parts.some((part) => {
    let decoded = part;
    for (let nesting = 0; nesting < 4; nesting += 1) {
      if (decoded.includes(text)) return true;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        return false;
      }
    }
    return false;
  });
}

test("facility, source, and return navigation keep local queries out of requests", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await waitForLocalSearch(page);
  await page.getByRole("searchbox").fill(query);
  await expect(contactLinks(page).first()).toBeVisible();
  const requests: Request[] = [];
  const record = (request: Request): void => {
    requests.push(request);
  };
  context.on("request", record);
  try {
    await contactLinks(page).first().click();
    await expect(page).toHaveURL(/\/contacts\/[^/?#]+#from=/u);
    await page
      .getByRole("link", { name: "電話番号のもとの情報を見る", exact: true })
      .click();
    await expect(page).toHaveURL(/\/source#from=/u);
    await page
      .getByRole("link", { name: "施設の情報にもどる", exact: true })
      .click();
    await page
      .getByRole("link", { name: "検索結果にもどる", exact: true })
      .click();
    await waitForLocalSearch(page);
    await expect(page.getByRole("searchbox")).toHaveValue(query);
    const href = await contactLinks(page).first().getAttribute("href");
    if (!href) throw new Error("The local detail link is missing");
    const another = await context.newPage();
    try {
      await another.goto(href);
      await expect(
        another.getByRole("heading", { level: 1, name: query }),
      ).toBeVisible();
    } finally {
      await another.close();
    }
    expect(
      requests
        .filter((request) => carriesQuery(request, query))
        .map((request) => request.url()),
    ).toEqual([]);
  } finally {
    context.off("request", record);
  }
});

test("after the index loads, searching sends no term and no contact request", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLocalSearch(page);
  const requests: Request[] = [];
  page.on("request", (request) => requests.push(request));
  const input = page.getByRole("searchbox");
  for (const text of ["国立", query, `${query}関西館`, query]) {
    await input.fill(text);
    await expect(page).toHaveURL(`/?q=${encodeURIComponent(text)}`);
    await expect(contactLinks(page).first()).toHaveAttribute(
      "href",
      /^\/contacts\/row\//u,
    );
  }
  const first = page.locator("article").first();
  await expect(first.getByRole("heading")).toHaveText(query);
  await expect(first.getByRole("heading").getByRole("link")).toHaveCount(0);
  await expect(
    first.getByRole("link", { name: `${query}の住所などを見る`, exact: true }),
  ).toHaveText("住所などを見る");
  await expect(
    first.getByText("東京都千代田区", { exact: true }),
  ).toBeVisible();
  await expect(
    first.getByRole("link", { name: "03-3581-2331に電話をかける" }),
  ).toHaveAttribute("href", "tel:+81335812331");
  await expect(first.getByRole("link", { name: /地図/u })).toHaveCount(0);
  expect(requests.filter(contactRequest).map((item) => item.url())).toEqual([]);
  expect(
    requests
      .filter((item) => carriesQuery(item, "国立"))
      .map((item) => item.url()),
  ).toEqual([]);
});

test("the server answers until the index loads, and the switch keeps focus and results", async ({
  page,
}) => {
  const release = await holdIndex(page);
  const searches: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/contact-groups")
      searches.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await expect(searchSource(page)).toHaveAttribute(
    "data-local-search",
    "loading",
  );
  await page.getByRole("searchbox").fill(query);
  const link = contactLinks(page).first();
  await expect(link).toHaveAttribute("href", /^\/contacts\/[^/]+\?/u);
  expect(searches).toHaveLength(1);
  const firstName = await page.locator("article h3").first().textContent();
  await link.focus();
  const focused = await link.elementHandle();
  if (!focused) throw new Error("The first result link is missing");
  release();
  await waitForLocalSearch(page);
  await expect(link).toHaveAttribute("href", /^\/contacts\/row\//u);
  expect(await page.locator("article h3").first().textContent()).toBe(
    firstName,
  );
  expect(
    await focused.evaluate(
      (node) => node.isConnected && document.activeElement === node,
    ),
  ).toBe(true);
  expect(searches).toHaveLength(1);
});

test("a local result names its detail action by the address its details show", async ({
  page,
}) => {
  await page.goto("/");
  await waitForLocalSearch(page);
  for (const { facility, label } of [
    { facility: query, label: "住所などを見る" },
    { facility: "いなべ警察署　東員交番", label: "くわしい情報を見る" },
  ]) {
    await page.getByRole("searchbox").fill(facility);
    const card = page.locator("article").first();
    await expect(card.getByRole("heading")).toHaveText(facility);
    const detail = card.getByRole("link", {
      name: `${facility}の${label}`,
      exact: true,
    });
    await expect(detail).toHaveText(label);
    await expect(detail).toHaveAttribute("href", /^\/contacts\/row\//u);
  }
});

test("search keeps working offline after the index loads", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await waitForLocalSearch(page);
  await context.setOffline(true);
  try {
    await page.getByRole("searchbox").fill(`${query}関西館`);
    await expect(
      page.locator("article").first().getByRole("heading"),
    ).toHaveText(`${query}関西館`);
  } finally {
    await context.setOffline(false);
  }
});

for (const category of ["", "library"] as const)
  test(`a private return restores its query before the index loads: ${category || "all categories"}`, async ({
    page,
  }) => {
    const release = await holdIndex(page);
    const searches: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/contact-groups")
        searches.push(request.url());
    });
    const parameters = new URLSearchParams({ q: query });
    if (category) parameters.set("category", category);
    try {
      await page.goto(`/#${parameters}`);
      await expect(page.getByRole("searchbox")).toHaveValue(query);
      await expect(searchSource(page)).toHaveAttribute(
        "data-local-search",
        "loading",
      );
      expect(searches).toEqual([]);
    } finally {
      release();
    }
    await waitForLocalSearch(page);
    await expect(
      page.locator("article").first().getByRole("heading"),
    ).toHaveText(query);
    await expect(page).toHaveURL(`/?${parameters}`);
    expect(searches).toEqual([]);
  });

test("editing a private return while the index loads preserves the edited query", async ({
  page,
}) => {
  const release = await holdIndex(page);
  const searches: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/contact-groups")
      searches.push(request.url());
  });
  const edited = `${query}関西館`;
  try {
    await page.goto(`/#${new URLSearchParams({ q: query })}`);
    await expect(page.getByRole("searchbox")).toHaveValue(query);
    await page.getByRole("searchbox").fill(edited);
    await expect(searchSource(page)).toHaveAttribute(
      "data-local-search",
      "loading",
    );
    expect(searches).toEqual([]);
  } finally {
    release();
  }
  await waitForLocalSearch(page);
  await expect(page.getByRole("searchbox")).toHaveValue(edited);
  await expect(page.locator("article").first().getByRole("heading")).toHaveText(
    edited,
  );
  expect(searches).toEqual([]);
});

test("a private return falls back to the server when the index is unavailable", async ({
  page,
  httpFailures,
}) => {
  httpFailures.add(503);
  await page.route("**/api/search-index", (route) =>
    route.fulfill({
      status: 503,
      body: "{}",
      contentType: "application/problem+json",
    }),
  );
  await page.goto(`/#${new URLSearchParams({ q: query })}`);
  await expect(page.getByRole("searchbox")).toHaveValue(query);
  await expect(searchSource(page)).toHaveAttribute(
    "data-local-search",
    "unavailable",
  );
  await expect(page.locator("article").first().getByRole("heading")).toHaveText(
    query,
  );
});

test("a local result opens its facility, and a changed snapshot reloads the index", async ({
  page,
  httpFailures,
}) => {
  httpFailures.add(409);
  await page.goto("/");
  await waitForLocalSearch(page);
  await page.getByRole("searchbox").fill(query);
  const link = contactLinks(page).first();
  await expect(link).toHaveAttribute("href", /^\/contacts\/row\//u);
  const locations: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === indexLocation)
      locations.push(request.url());
  });
  await page.route("**/api/contacts/row/**", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "https://example.org/snapshot_changed",
        title: "Dataset changed",
        status: 409,
        code: "snapshot_changed",
        requestId: "fixture",
      }),
    });
  });
  await link.click();
  await expect(
    page.getByRole("heading", { name: "電話番号のデータが新しくなりました" }),
  ).toBeVisible();
  await expect.poll(() => locations.length).toBe(1);
  await expect(searchSource(page)).toHaveAttribute(
    "data-index-generation",
    "2",
    { timeout: indexReloadTimeout },
  );
  await waitForLocalSearch(page);
  await expect(page).toHaveURL(`/?q=${encodeURIComponent(query)}`);
  await expect(page.locator("article").first().getByRole("heading")).toHaveText(
    query,
  );
  await page.unroute("**/api/contacts/row/**");
  await contactLinks(page).first().click();
  await expect(page).toHaveURL(/\/contacts\/[^/?#]+#from=/u);
  await expect(
    page.getByRole("heading", { level: 1, name: query }),
  ).toBeVisible();
  await page.getByRole("link", { name: "検索結果にもどる" }).click();
  await expect(page.getByRole("searchbox")).toHaveValue(query);
});

for (const artifact of ["search-index"] as const)
  test(`an artifact that fails its published digest falls back to the server search: ${artifact}`, async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === `/api/${artifact}`,
      async (route) => {
        const response = await route.fetch();
        const location = v.parse(
          SearchIndexLocationSchema,
          await response.json(),
        );
        await route.fulfill({
          response,
          json: { ...location, uncompressedSha256: "0".repeat(64) },
        });
      },
    );
    const searches: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/contact-groups")
        searches.push(request.url());
    });
    await page.goto("/");
    await expect(searchSource(page)).toHaveAttribute(
      "data-local-search",
      "unavailable",
    );
    await page.getByRole("searchbox").fill(query);
    await expect(contactLinks(page).first()).toHaveAttribute(
      "href",
      /^\/contacts\/[^/]+\?/u,
    );
    expect(searches).toHaveLength(1);
  });

test("a browser that saves data searches on the server without the index", async ({
  page,
}) => {
  await saveData(page);
  const locations: string[] = [];
  page.on("request", (request) => {
    if (
      /^\/api\/search-(?:index|ranking)/u.test(new URL(request.url()).pathname)
    )
      locations.push(request.url());
  });
  await page.goto("/");
  await expect(searchSource(page)).toHaveAttribute(
    "data-local-search",
    "skipped",
  );
  await page.getByRole("searchbox").fill(query);
  await expect(contactLinks(page).first()).toHaveAttribute(
    "href",
    /^\/contacts\/[^/]+\?/u,
  );
  expect(locations).toEqual([]);
});

test("the server sends the stored Brotli bytes, and the browser admits the decoded index", async ({
  page,
  request,
}) => {
  const location = v.parse(
    SearchIndexLocationSchema,
    await (await request.get(indexLocation)).json(),
  );
  const index = await request.get(location.url, {
    headers: { "Accept-Encoding": "br" },
  });
  expect(index.status()).toBe(200);
  expect(index.headers()["content-encoding"]).toBe("br");
  expect(index.headers()["cache-control"]).toContain("immutable");
  await page.goto("/");
  await waitForLocalSearch(page);
});

test("the total count has no visible line and is announced after typing stops", async ({
  page,
}) => {
  await page.clock.install({ time: loadedAt });
  await page.goto("/");
  await waitForLocalSearch(page);
  await page.clock.pauseAt(typingFrom);
  const status = page.locator("#search-status");
  await page.getByRole("searchbox").fill(query);
  await page.clock.runFor(1);
  await expect(contactLinks(page).first()).toHaveAttribute(
    "href",
    /^\/contacts\/row\//u,
  );
  await expect(
    page.locator("main :not(output)", { hasText: /見つかりました/u }),
  ).toHaveCount(0);
  await page.clock.runFor(announcementDelay - 1);
  await expect(status).toHaveText("");
  await page.clock.runFor(1);
  await expect(status).toHaveText(/件 見つかりました$/u);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the form searches on the server and links to the facility", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("searchbox").fill(query);
    await page.getByRole("button", { name: "電話番号をさがす" }).click();
    await expect(page).toHaveURL(`/?q=${encodeURIComponent(query)}`);
    await expect(contactLinks(page).first()).toHaveAttribute(
      "href",
      /^\/contacts\/[^/]+\?from=/u,
    );
    await expect(page.locator("#search-status")).toHaveText(
      /件 見つかりました$/u,
    );
  });

  test("old region filters redirect to the search without them", async ({
    page,
    request,
  }) => {
    for (const [from, to] of [
      [
        `/?q=${query}&prefecture=13&municipality=13101`,
        `/?q=${encodeURIComponent(query)}`,
      ],
      [
        `/?q=${query}&prefecture=13&category=library&cursor=abc`,
        `/?q=${encodeURIComponent(query)}&category=library`,
      ],
      ["/?prefecture=13", "/"],
      ["/?category=library", "/"],
    ] as const) {
      const response = await request.get(from, { maxRedirects: 0 });
      expect(response.status(), from).toBe(301);
      expect(response.headers().location, from).toBe(to);
    }
    await page.goto(`/?q=${query}&prefecture=13`);
    await expect(page).toHaveURL(`/?q=${encodeURIComponent(query)}`);
    await expect(page.locator("article").first()).toBeVisible();
  });
});
