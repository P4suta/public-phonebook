import { expect, test } from "@playwright/test";
import {
  backToResults,
  categories,
  categoryLabel,
  checkCards,
  contacts,
  contents,
  coverage,
  download,
  openSource,
  publisherLabel,
  serviceCategories,
} from "./support.js";

test("added national datasets can be searched and show their actual publisher and file formats", async ({
  page,
  request,
}, info) => {
  const report = coverage(await (await request.get("/coverage.json")).json());
  const datasets = [
    [
      "nursing_care",
      "Ministry of Health, Labour and Welfare",
      "https://www.mhlw.go.jp/stf/kaigo-kouhyou_opendata.html",
      "CSV",
    ],
    [
      "disability_support",
      "WAM NET",
      "https://www.wam.go.jp/content/wamnet/pcpub/top/sfkopendata/",
      "ZIP",
    ],
    [
      "library",
      "National Diet Library",
      "https://www.ndl.go.jp/library/isil",
      "CSV",
    ],
    [
      "museum",
      "National Diet Library",
      "https://www.ndl.go.jp/library/isil",
      "CSV",
    ],
    [
      "archive",
      "National Diet Library",
      "https://www.ndl.go.jp/library/isil",
      "CSV",
    ],
  ] as const;
  for (const [category, , index, format] of datasets) {
    const cell = report.cells.find(
      (entry) => entry.category === category && entry.prefecture_code === "13",
    );
    expect(cell?.contacts).toBeGreaterThan(0);
    await page.goto(`/?prefecture=13&category=${category}`);
    await expect(page.locator(".contact")).toHaveCount(
      Math.min(50, cell?.contacts ?? 0),
    );
    await openSource(page);
    await expect(
      page
        .locator(".source-description")
        .getByRole("heading", { name: publisherLabel(category), exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "公開元のページを見る", exact: true }),
    ).toHaveAttribute("href", index);
    await expect(
      page.getByRole("link", {
        name: `元のファイルを開く（${format}）`,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        (): boolean =>
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`${category}-source.png`),
      fullPage: true,
    });
  }
});

test("a published compatibility-hyphen telephone remains searchable and preserves its original form", async ({
  page,
}) => {
  const published = "080ｰ9443-9583";
  await page.goto(`/?category=nursing_care&q=${encodeURIComponent(published)}`);
  await expect(
    page.locator('a.phone[href="tel:+818094439583"]').first(),
  ).toBeVisible();
  const records = contacts(await contents(await download(page, "JSON ↓")));
  expect(
    records.some((record) =>
      record.phones.some(
        (phone) =>
          phone.original === published && phone.e164 === "+818094439583",
      ),
    ),
  ).toBe(true);
});

test("real medical source links open context before the original spreadsheet or archive", async ({
  page,
}, info) => {
  const downloads: string[] = [];
  page.on("download", (file): void => {
    downloads.push(file.suggestedFilename());
  });
  await page.goto("/?prefecture=13&category=medical");
  await openSource(page);
  await expect(
    page.getByRole("heading", { name: "この番号の出典", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "公開元のページを見る", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://kouseikyoku.mhlw.go.jp/kantoshinetsu/chousa/shitei.html",
  );
  await expect(
    page.getByRole("link", { name: "元のファイルを開く（ZIP）", exact: true }),
  ).toHaveAttribute(
    "href",
    /https:\/\/kouseikyoku\.mhlw\.go\.jp\/kantoshinetsu\/.*\.zip/,
  );
  expect(downloads).toEqual([]);
  await page.screenshot({
    path: info.outputPath("medical-source-details.png"),
    fullPage: true,
  });
});

test("the installed snapshot reconciles all 47 prefectures and every category", async ({
  request,
}) => {
  const result = await request.get("/coverage.json");
  expect(result.status()).toBe(200);
  const report = coverage(await result.json());
  expect(report.complete).toBe(true);
  expect(report.prefectures_covered).toBe(47);
  expect(report.total_contacts).toBeGreaterThan(588_159);
  expect(report.cells).toHaveLength(47 * categories.length);
  expect(new Set(report.cells.map((cell) => cell.prefecture_code)).size).toBe(
    47,
  );
  expect(report.cells.reduce((sum, cell) => sum + cell.contacts, 0)).toBe(
    report.total_contacts,
  );
  expect(report.sources.reduce((sum, source) => sum + source.accepted, 0)).toBe(
    report.total_contacts,
  );
  for (const source of report.sources)
    expect(source.rows).toBe(
      source.accepted +
        source.invalid +
        source.duplicate +
        source.missing_phone,
    );
  for (let code = 1; code <= 47; code += 1) {
    for (const category of categories) {
      const cell = report.cells.find(
        (value) =>
          value.prefecture_code === String(code).padStart(2, "0") &&
          value.category === category,
      );
      expect(cell?.contacts).toBeGreaterThanOrEqual(0);
      if (
        [
          "medical",
          "dental",
          "pharmacy",
          "municipal_office",
          "prefectural_office",
          "nursing_care",
          "disability_support",
          "library",
        ].includes(category)
      )
        expect(cell?.contacts).toBeGreaterThan(0);
      if (["medical", "dental", "pharmacy"].includes(category))
        expect(cell?.contacts).toBeGreaterThan(100);
    }
  }
  for (const category of categories) {
    expect(
      report.cells
        .filter((cell) => cell.category === category)
        .reduce((sum, cell) => sum + cell.contacts, 0),
      category,
    ).toBeGreaterThan(0);
  }
});

for (const [category, , publisher] of serviceCategories) {
  test(`real ${category} contacts support search, all exports, and readable source navigation`, async ({
    page,
    request,
  }, info) => {
    const report = coverage(await (await request.get("/coverage.json")).json());
    const cell = report.cells.find(
      (value) => value.category === category && value.contacts > 0,
    );
    expect(cell, category).toBeDefined();
    const query = `prefecture=${cell?.prefecture_code}&category=${category}`;
    await page.goto(`/?${query}`);
    await expect(page.locator(".tags").first()).toContainText(
      categoryLabel(category),
    );
    const records = contacts(await contents(await download(page, "JSON ↓")));
    expect(records).toHaveLength(cell?.contacts ?? -1);
    expect(
      records.every(
        (record) =>
          record.category === category &&
          record.prefecture_code === cell?.prefecture_code &&
          record.attribution?.includes(publisher),
      ),
    ).toBe(true);
    checkCards(await contents(await download(page, "VCF ↓")), records.length);
    const csv = await contents(await download(page, "CSV ↓"));
    expect(csv).toContain(publisher);
    const first = records[0];
    expect(first).toBeDefined();
    const number = first?.phones[0]?.e164 ?? "Missing telephone";
    await page.goto(`/?${query}&q=${encodeURIComponent(number)}`);
    await expect(
      page.locator(`a.phone[href="tel:${number}"]`).first(),
    ).toBeVisible();
    const downloads: string[] = [];
    page.on("download", (file): void => {
      downloads.push(file.suggestedFilename());
    });
    await openSource(page);
    await expect(
      page
        .locator(".source-description")
        .getByRole("heading", { name: publisherLabel(category), exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "公開元のページを見る", exact: true }),
    ).toHaveAttribute("href", /^https:\/\//);
    const format = new URL(
      first?.source_url ?? "https://invalid.example",
    ).pathname
      .match(/\.(csv|xlsx|zip|pdf)$/i)?.[1]
      ?.toUpperCase();
    if (format)
      await expect(
        page.getByRole("link", {
          name: `元のファイルを開く（${format}）`,
          exact: true,
        }),
      ).toBeVisible();
    expect(downloads).toEqual([]);
    expect(
      await page.evaluate(
        (): boolean =>
          document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`${category}-source.png`),
      fullPage: true,
    });
    await backToResults(page);
    await expect(page.getByLabel("種類", { exact: true })).toHaveValue(
      category,
    );
    await expect(page.getByLabel("都道府県", { exact: true })).toHaveValue(
      cell?.prefecture_code ?? "Missing prefecture",
    );
    await expect(page.getByLabel("施設名か電話番号")).toHaveValue(number);
  });
}

test("all 47 prefectures can be selected and show their actual medical contacts", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180_000);
  const report = coverage(await (await request.get("/coverage.json")).json());
  await page.goto("/");
  for (let code = 1; code <= 47; code += 1) {
    const value = String(code).padStart(2, "0");
    const cell = report.cells.find(
      (entry) =>
        entry.prefecture_code === value && entry.category === "medical",
    );
    expect(cell).toBeDefined();
    await page.getByLabel("都道府県", { exact: true }).selectOption(value);
    await page.getByLabel("種類", { exact: true }).selectOption("medical");
    await page.getByRole("button", { name: "さがす" }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(
      `${cell?.contacts.toLocaleString("ja-JP")} 件`,
    );
    await expect(page.locator(".contact")).toHaveCount(50);
    await expect(page.locator(".tags").first()).toContainText(
      cell?.prefecture ?? "Missing prefecture",
    );
  }
  await page.screenshot({
    path: info.outputPath("okinawa-medical.png"),
    fullPage: true,
  });
});

test("a real municipal office can be found, called by link, and saved", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("施設名か電話番号").fill("横浜市役所");
  await page
    .getByLabel("種類", { exact: true })
    .selectOption("municipal_office");
  await page.getByRole("button", { name: "さがす" }).click();
  await expect(page.locator(".contact")).toHaveCount(1);
  await expect(page.locator(".tags")).toContainText("神奈川県");
  await expect(page.locator("a.phone").first()).toHaveAttribute(
    "href",
    /^tel:\+81[0-9]+$/,
  );
  const exported = contacts(await contents(await download(page, "JSON ↓")));
  expect(exported[0]?.name).toBe("横浜市役所");
  expect(exported[0]?.prefecture_code).toBe("14");
  checkCards(await contents(await download(page, "連絡先に保存")), 1);
});

test("an actual representative phone supports domestic and international lookup", async ({
  page,
  request,
}) => {
  const response = await request.get(
    "/export?format=json&prefecture=13&category=prefectural_office",
  );
  const record = contacts(await response.text())[0];
  expect(record).toBeDefined();
  const phone = record?.phones[0];
  expect(phone).toBeDefined();
  for (const query of [
    phone?.original ?? "Missing number",
    phone?.e164 ?? "Missing number",
  ]) {
    await page.goto(`/?q=${encodeURIComponent(query)}`);
    await expect(
      page.getByRole("heading", {
        name: record?.name ?? "Missing office",
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("filtered national exports include every pharmacy beyond the first page", async ({
  page,
  request,
}) => {
  const report = coverage(await (await request.get("/coverage.json")).json());
  const total = report.cells.find(
    (cell) => cell.prefecture_code === "47" && cell.category === "pharmacy",
  )?.contacts;
  expect(total).toBeGreaterThan(50);
  await page.goto("/?prefecture=47&category=pharmacy&page=2");
  const json = contacts(await contents(await download(page, "JSON ↓")));
  expect(json).toHaveLength(total ?? -1);
  expect(
    json.every(
      (contact) =>
        contact.prefecture_code === "47" && contact.category === "pharmacy",
    ),
  ).toBe(true);
  checkCards(await contents(await download(page, "VCF ↓")), total ?? -1);
});

test("real national results and all export controls fit a phone screen", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?prefecture=13&category=medical");
  await page.locator("details.exports > summary").click();
  expect(
    await page.evaluate(
      (): boolean => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("link", { name: "VCF ↓", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("tokyo-mobile.png"),
    fullPage: true,
  });
});
