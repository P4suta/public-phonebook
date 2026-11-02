import { expect, type Page, test } from "@playwright/test";
import { waitForLocalSearch } from "./search-sources.ts";

test.use({ trace: "off", video: "off", screenshot: "off" });

type Attempt = "attribute" | "style" | "empty-style" | "script" | "worker";

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
        } else if (kind === "worker") {
          const source = URL.createObjectURL(
            new Blob(['postMessage("injected")'], { type: "text/javascript" }),
          );
          void Promise.resolve()
            .then(() => {
              new Worker(source).addEventListener("message", () => {
                document.documentElement.dataset.injected = "true";
              });
            })
            .catch((error: unknown) => {
              document.documentElement.dataset.workerRefusal = String(error);
            });
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

test("the search Worker runs without CSP violations and the permitted style hash is exact", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const response = await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
  await waitForLocalSearch(page);
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
  "worker",
] as const) {
  test(`CSP rejects an untrusted ${attempt}`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    expect(await blockedAttempt(page, attempt)).toBe(
      {
        attribute: "style-src-attr",
        script: "script-src-elem",
        worker: "worker-src",
        style: "style-src-elem",
        "empty-style": "style-src-elem",
      }[attempt],
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.injected),
    ).toBeUndefined();
    expect(
      await page.evaluate(() => getComputedStyle(document.body).color),
    ).toBe("rgb(0, 0, 0)");
  });
}

for (const attempt of ["attribute", "style", "script"] as const) {
  test(`the API reference keeps the strict policy and rejects an untrusted ${attempt}`, async ({
    page,
  }) => {
    const response = await page.goto("/developers");
    await expect(page.locator("html")).toHaveAttribute("data-enhanced", "true");
    if (!response) throw new Error("Missing reference response");
    const csp = (await response.allHeaders())["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+';/u);
    expect(csp).toMatch(/style-src 'self' 'nonce-[^']+';/u);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(await blockedAttempt(page, attempt)).toBe(
      {
        attribute: "style-src-attr",
        style: "style-src-elem",
        script: "script-src-elem",
      }[attempt],
    );
    expect(
      await page.evaluate(() => document.documentElement.dataset.injected),
    ).toBeUndefined();
  });
}
