import { expect, type Page, test } from "@playwright/test";

test.use({ trace: "off", video: "off", screenshot: "off" });

type Attempt = "attribute" | "style" | "empty-style" | "script";

async function blockedAttempt(page: Page, attempt: Attempt): Promise<string> {
  return page.evaluate(
    (kind: Attempt) =>
      new Promise<string>((resolve) => {
        document.addEventListener(
          "securitypolicyviolation",
          (event) => resolve(event.violatedDirective),
          { once: true },
        );
        if (kind === "attribute") {
          const element = document.createElement("p");
          element.setAttribute("style", "color:red");
          document.body.appendChild(element);
        } else if (kind === "script") {
          const script = document.createElement("script");
          script.textContent =
            'document.documentElement.dataset.injected = "true"';
          document.body.appendChild(script);
        } else {
          const style = document.createElement("style");
          style.textContent =
            kind === "empty-style" ? "body {}" : "body { color:red }";
          document.head.appendChild(style);
        }
      }),
    attempt,
  );
}

test("native selects work without CSP violations and the permitted style hash is exact", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const response = await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await expect(page.getByRole("combobox")).toHaveCount(2);
  expect(errors).toEqual([]);
  if (!response) throw new Error("Missing page response");
  const hash = await page.evaluate(async () =>
    btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode("text-overflow:inherit"),
          ),
        ),
      ),
    ),
  );
  expect((await response.allHeaders())["content-security-policy"]).toContain(
    `'sha256-${hash}'`,
  );
  const inherited = await page.evaluate(() => {
    const parent = document.createElement("div");
    parent.style.textOverflow = "ellipsis";
    const child = document.createElement("p");
    parent.appendChild(child);
    document.body.appendChild(parent);
    child.setAttribute("style", "text-overflow:inherit");
    return getComputedStyle(child).textOverflow;
  });
  expect(inherited).toBe("ellipsis");
  expect(errors).toEqual([]);
});

for (const attempt of [
  "attribute",
  "style",
  "empty-style",
  "script",
] as const) {
  test(`CSP rejects an untrusted ${attempt}`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    expect(await blockedAttempt(page, attempt)).toBe(
      attempt === "attribute"
        ? "style-src-attr"
        : attempt === "script"
          ? "script-src-elem"
          : "style-src-elem",
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.injected),
    ).toBeUndefined();
    expect(
      await page.evaluate(() => getComputedStyle(document.body).color),
    ).toBe("rgb(0, 0, 0)");
  });
}

for (const attempt of ["script"] as const) {
  test(`the API reference rejects an untrusted ${attempt}`, async ({
    page,
  }) => {
    const response = await page.goto("/developers");
    await expect(page.locator("[data-api-reference]")).toHaveAttribute(
      "data-ready",
      "true",
    );
    if (!response) throw new Error("Missing reference response");
    const csp = (await response.allHeaders())["content-security-policy"] ?? "";
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+';/u);
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
    expect(csp).not.toContain("unsafe-eval");
    expect(await blockedAttempt(page, attempt)).toBe("script-src-elem");
    expect(
      await page.evaluate(() => document.documentElement.dataset.injected),
    ).toBeUndefined();
  });
}
