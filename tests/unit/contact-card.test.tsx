import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as v from "valibot";
import { expect, it, vi } from "vitest";
import { ContactSchema } from "../../src/core/models.ts";
import {
  BackButton,
  ContactCard,
  LinkButton,
  LoadingError,
  OfficialLink,
  ResultCard,
} from "../../src/ui/components.tsx";
import {
  catalogRegions,
  localCard,
  regionLabel,
  serverCard,
} from "../../src/ui/result-cards.ts";

const regions = catalogRegions({
  prefectures: [
    { code: "13", name: "東京都" },
    { code: "26", name: "京都府" },
  ],
  municipalities: [{ code: "13101", prefectureCode: "13", name: "千代田区" }],
});

vi.mock("../../src/ui/styles.css.ts", () => ({
  actions: "actions",
  body: "body",
  button: "button",
  numberCopyHint: "numberCopyHint",
  card: "card",
  category: "category",
  contactHeader: "contactHeader",
  contactLocation: "contactLocation",
  contactName: "contactName",
  contactLink: "contactLink",
  contactNumbers: "contactNumbers",
  cardFeedback: "cardFeedback",
  phoneGroup: "phoneGroup",
  group: "group",
  region: "region",
  heading: "heading",
  solid: "solid",
  srOnly: "srOnly",
  stack: "stack",
  status: "status",
  subheading: "subheading",
  telephone: "telephone",
  trailingIcon: "trailingIcon",
}));

it("renders external web resources with isolated tabs and an accessible announcement before hydration", () => {
  const external = renderToStaticMarkup(
    <OfficialLink href="https://example.org/terms" destination="license">
      利用条件を見る
    </OfficialLink>,
  );
  expect(external).toContain('target="_blank"');
  expect(external).toContain('rel="noopener noreferrer"');
  expect(external).toContain('data-external-destination="license"');
  expect(external).toMatch(/^<a[^>]*><svg[^>]*data-icon="external-link"/u);
  expect(external.match(/data-icon="external-link"/gu)).toHaveLength(1);
  expect(external).toContain("（新しいタブ）");
  const local = renderToStaticMarkup(
    <LinkButton href="/data" icon="info" destination="license">
      データについて
    </LinkButton>,
  );
  expect(local).not.toContain("target=");
  expect(local).not.toContain("data-external-destination");
  expect(local).toContain('data-icon="info"');
});

it("shows every telephone action and one contact-save action for a multi-number facility", () => {
  const contact = v.parse(ContactSchema, {
    id: "fixture:multiple-phones",
    name: "Public library",
    category: "library",
    prefectureCode: "13",
    municipalityCode: "13101",
    address: "Tokyo",
    phones: [
      { display: "03-3581-2331", e164: "+81335812331" },
      { display: "03-3827-2053", e164: "+81338272053" },
    ],
    website: null,
    sourceId: "fixture",
    sourceRecordId: "1",
    sourceUrls: ["https://example.org/data"],
    license: "CC0-1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    dataAsOf: "2026-10-01",
    retrievedAt: "2026-10-29T00:00:00Z",
    phoneConfirmed: false,
    phoneConfirmationUrl: null,
  });
  const result = serverCard(contact, regions, "/?q=library");
  for (const markup of [
    renderToStaticMarkup(createElement(ContactCard, { contact })),
    renderToStaticMarkup(
      createElement(ResultCard, { card: result, onOpenRow: () => undefined }),
    ),
  ]) {
    const detail = markup.includes('data-layout="detail"');
    expect(markup.match(/href="tel:/g)).toHaveLength(2);
    expect(markup.match(/data-phone/g)).toHaveLength(2);
    expect(markup.match(/<button[^>]*data-phone/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<a[^>]*data-phone/u);
    expect(markup.match(/電話をかける<\/a>/g)).toHaveLength(2);
    for (const phone of contact.phones)
      expect(markup).toContain(`href="tel:${phone.e164}"`);
    expect(markup.match(/contact\.vcf/g) ?? []).toHaveLength(detail ? 1 : 0);
    if (detail)
      expect(markup).toMatch(
        /<a[^>]*contact\.vcf[^>]*><svg[^>]*data-icon="book-user"/u,
      );
    if (detail)
      expect(markup).toMatch(
        /<a[^>]*data-external-destination="address"[^>]*><svg[^>]*data-icon="map-pin"[^>]*>.*?<\/svg><span>Tokyo<svg[^>]*data-icon="external-link"/u,
      );
    else {
      expect(markup).not.toContain("Tokyo");
      expect(markup).not.toContain("google.com/maps");
      expect(markup).toContain('<p class="region">東京都千代田区</p>');
      expect(markup).toContain(
        'href="/contacts/fixture%3Amultiple-phones?from=%2F%3Fq%3Dlibrary"',
      );
    }
  }
});

it("draws the back and reload actions with their own masters", () => {
  const drawn = (markup: string): string[] =>
    [...markup.matchAll(/data-icon="([\w-]+)"/gu)].map(
      (match) => match[1] ?? "",
    );
  expect(drawn(renderToStaticMarkup(createElement(BackButton)))).toEqual([
    "arrow-left",
  ]);
  for (const restartHref of ["/", undefined])
    expect(
      drawn(
        renderToStaticMarkup(
          createElement(LoadingError, { retry: () => undefined, restartHref }),
        ),
      ),
    ).toEqual(["rotate-cw"]);
});

it("links a device result through its index row and keeps the national number's digits", () => {
  const card = localCard(
    {
      row: 41,
      name: "市立図書館",
      category: "library",
      region: "26",
      phones: ["0774981200"],
    },
    "a".repeat(64),
    regions,
    "/?q=図書館",
  );
  expect(card).toEqual({
    key: "row-41",
    name: "市立図書館",
    region: "京都府",
    phones: ["+81774981200"],
    href: `/contacts/row/${"a".repeat(64)}/41?from=%2F%3Fq%3D%E5%9B%B3%E6%9B%B8%E9%A4%A8`,
    row: { snapshot: "a".repeat(64), row: 41 },
  });
  expect(regionLabel("13999", regions)).toBe("東京都");
  expect(regionLabel("99", regions)).toBe("");
});
