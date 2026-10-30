import { expect, test } from "./fixtures.ts";

test.use({ video: "on", screenshot: "off" });

test("a programmatic click cannot write to either clipboard path", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText(): Promise<void> {
          document.documentElement.dataset.untrustedWrite = "true";
          return Promise.resolve();
        },
      },
    });
    document.addEventListener("copy", () => {
      document.documentElement.dataset.untrustedWrite = "true";
    });
  });
  await page.goto("/?q=高知大学");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const card = page.locator("article").first();
  await card.locator("[data-phone]").evaluate((node) => {
    if (node instanceof HTMLButtonElement) node.click();
  });
  await expect(card.getByRole("status")).toHaveText(
    "コピーできませんでした。文字をえらんでコピーしてください。",
  );
  expect(
    await page.locator("html").getAttribute("data-untrusted-write"),
  ).toBeNull();
});

test("the native selection path copies API URLs when the async clipboard is absent", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined });
    window.addEventListener("copy", (event: ClipboardEvent) => {
      document.documentElement.dataset.selectionCopy =
        event.clipboardData?.getData("text/plain") ?? "";
    });
  });
  await page.goto("/developers");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const button = page.getByRole("button", {
    name: "API仕様書のURLをコピー",
    exact: true,
  });
  await button.click();
  await expect(
    page.getByText("API仕様書のURLをコピーしました。", { exact: true }),
  ).toBeVisible();
  const copied = await page.locator("html").getAttribute("data-selection-copy");
  expect(new URL(copied ?? "").pathname).toBe("/api/openapi.json");
  await expect(button).toBeFocused();
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("native activation loss uses WebKit compatibility and preserves recovery elsewhere", async ({
  page,
  context,
  browserName,
  baseURL,
}) => {
  if (browserName === "chromium") {
    if (!baseURL)
      throw new Error("The native clipboard test needs its server origin");
    await context.grantPermissions(["clipboard-write"], { origin: baseURL });
  }
  await page.addInitScript(() => {
    let consumed = false;
    document.addEventListener(
      "click",
      (event: MouseEvent) => {
        if (
          !(event.target instanceof Element) ||
          !event.target.closest("[data-phone]") ||
          consumed
        )
          return;
        consumed = true;
        const popup = window.open("about:blank");
        if (!popup)
          throw new Error(
            "The activation-consumption control could not open its popup",
          );
        popup.close();
        document.documentElement.dataset.transientActivation = String(
          navigator.userActivation.isActive,
        );
      },
      { capture: true },
    );
    window.addEventListener("copy", (event: ClipboardEvent) => {
      document.documentElement.dataset.selectionCopy =
        event.clipboardData?.getData("text/plain") ?? "";
    });
  });
  await page.goto("/");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill("高知大学");
  const card = page.locator("article").first();
  const number = card.locator("[data-phone]").first();
  await number.locator(":scope > span").first().click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-transient-activation",
    "false",
  );
  if (browserName === "webkit") {
    await expect(card.getByRole("status")).toHaveText(
      "電話番号をコピーしました。",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-selection-copy",
      "088-844-0111",
    );
  } else {
    await expect(card.getByRole("status")).toHaveText(
      "コピーできませんでした。文字をえらんでコピーしてください。",
    );
    expect(
      await page.locator("html").getAttribute("data-selection-copy"),
    ).toBeNull();
    await number.click();
    await expect(card.getByRole("status")).toHaveText(
      "電話番号をコピーしました。",
    );
  }
  await expect(number).toBeFocused();
  await expect(page.locator("textarea")).toHaveCount(0);
});

test("native clipboard accepts clicks on both the number and the copy hint", async ({
  page,
  context,
  browserName,
  baseURL,
}) => {
  if (browserName === "chromium") {
    if (!baseURL)
      throw new Error("The native clipboard test needs its server origin");
    await context.grantPermissions(["clipboard-write"], { origin: baseURL });
  }
  await page.addInitScript(() => {
    const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (value: string): Promise<void> => {
      const context = {
        focused: document.hasFocus(),
        visible: document.visibilityState,
        active: navigator.userActivation.isActive,
      };
      return writeText(value).catch((error: unknown) => {
        document.documentElement.dataset.clipboardFailure = JSON.stringify({
          ...context,
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        });
        throw error;
      });
    };
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page.getByRole("searchbox").fill("高知大学");
  const card = page.locator("article").first();
  const number = card.locator("[data-phone]").first();
  await number.locator(":scope > span").first().click();
  await expect(card.getByRole("status")).not.toBeEmpty();
  await expect(
    card.getByRole("status"),
    (await page.locator("html").getAttribute("data-clipboard-failure")) ??
      "Native clipboard write",
  ).toHaveText("電話番号をコピーしました。");
  await expect(number).toBeFocused();
  await expect(number.locator(":scope > span").first()).toHaveText(
    "088-844-0111",
  );
  await number.locator(":scope > span").last().click();
  await expect(card.getByRole("status")).toHaveText(
    "電話番号をコピーしました。",
  );
  await number.locator(":scope > span").first().dblclick();
  await expect(card.getByRole("status")).toHaveText(
    "電話番号をコピーしました。",
  );
});

test("the map opens in a new tab after confirmation and preserves the current results", async ({
  page,
  context,
}) => {
  await context.route("https://www.google.com/maps/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<title>Map destination</title>",
    });
  });
  await page.goto("/?q=国立国会図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const before = page.url();
  const card = page.locator("article").first();
  const map = card.getByRole("link", { name: /の地図を開く（新しいタブ）$/u });
  await map.click();
  const popupEvent = page.waitForEvent("popup");
  await page
    .getByRole("dialog", { name: "ほかのサイトを開きます" })
    .getByRole("button", { name: "開く", exact: true })
    .click();
  const popup = await popupEvent;
  await popup.waitForLoadState("domcontentloaded");
  expect(new URL(popup.url()).searchParams.get("query")).toBe(
    "東京都千代田区永田町1-10-1",
  );
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(page.url()).toBe(before);
  await expect(card).toBeVisible();
  await popup.close();
});

test("an older clipboard rejection cannot replace a newer successful copy", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    let attempts = 0;
    document.addEventListener("test-reject-first-write", () => {
      rejectFirst?.(new DOMException("Superseded", "NotAllowedError"));
    });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText(): Promise<void> {
          attempts += 1;
          if (attempts > 1) return Promise.resolve();
          return new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        },
      },
    });
  });
  await page.goto("/?q=国立国会図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const card = page.locator("article").first();
  const number = card.locator("[data-phone]").first();
  await number.locator(":scope > span").first().click();
  await number.locator(":scope > span").last().click();
  await expect(card.getByRole("status")).toHaveText(
    "電話番号をコピーしました。",
  );
  await page.evaluate(async () => {
    document.dispatchEvent(new Event("test-reject-first-write"));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(card.getByRole("status")).toHaveText(
    "電話番号をコピーしました。",
  );
});

test("telephone and API URL copies use the complete displayed values", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async writeText(value: string): Promise<void> {
          copied = value;
        },
        async readText(): Promise<string> {
          return copied;
        },
      },
    });
  });
  await page.goto("/?q=国立国会図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page
    .locator("article")
    .first()
    .getByRole("button", {
      name: "03-3581-2331 コピーする（国立国会図書館の電話番号）",
      exact: true,
    })
    .click();
  expect(await page.evaluate(async () => navigator.clipboard.readText())).toBe(
    "03-3581-2331",
  );
  await page.goto("/developers");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await page
    .getByRole("button", { name: "API仕様書のURLをコピー", exact: true })
    .click();
  const copied = await page.evaluate(async () =>
    navigator.clipboard.readText(),
  );
  expect(new URL(copied).pathname).toBe("/api/openapi.json");
  expect(new URL(copied).search).toBe("");
});

test("clipboard denial has a readable recovery message", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        async writeText(): Promise<void> {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto("/?q=国立国会図書館");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  const card = page.locator("article").first();
  await card
    .getByRole("button", {
      name: "03-3581-2331 コピーする（国立国会図書館の電話番号）",
      exact: true,
    })
    .click();
  await expect(card.getByRole("status")).toHaveText(
    "コピーできませんでした。文字をえらんでコピーしてください。",
  );
});
