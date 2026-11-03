import * as fc from "fast-check";
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
import { uiCopy } from "../../src/ui/copy.ts";
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
  actionColumn: "actionColumn",
  actions: "actions",
  addressHeading: "addressHeading",
  body: "body",
  button: "button",
  card: "card",
  category: "category",
  contactAddress: "contactAddress",
  contactHeader: "contactHeader",
  contactLocation: "contactLocation",
  contactName: "contactName",
  contactNumbers: "contactNumbers",
  detailAction: "detailAction",
  phoneGroup: "phoneGroup",
  region: "region",
  heading: "heading",
  solid: "solid",
  srOnly: "srOnly",
  stack: "stack",
  subheading: "subheading",
  telephone: "telephone",
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
const propertyRuns = 200;
const propertySeed = 160;

it("shows every telephone action and one contact-save action for a multi-number facility", () => {
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
    for (const phone of contact.phones)
      expect(markup).toContain(
        `<p class="telephone" data-phone="">${phone.display}</p>`,
      );
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<output");
    expect(markup).not.toContain("コピー");
    expect(markup.match(/電話をかける<\/a>/g)).toHaveLength(2);
    for (const phone of contact.phones)
      expect(markup).toContain(`href="tel:${phone.e164}"`);
    expect(markup.match(/contact\.vcf/g) ?? []).toHaveLength(detail ? 1 : 0);
    if (detail)
      expect(markup).toMatch(
        /<a[^>]*contact\.vcf[^>]*><svg[^>]*data-icon="book-user"/u,
      );
    if (detail) {
      expect(markup).toContain(
        '<h2 class="addressHeading">住所</h2><p class="body">Tokyo</p>',
      );
      expect(markup).not.toMatch(/<a[^>]*>[^<]*Tokyo/u);
      expect(markup).toMatch(
        /<a class="button " href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=Public%20library%2CTokyo"[^>]*data-external-destination="address" aria-label="Public libraryを地図で見る（新しいタブ）"><svg[^>]*data-icon="map-pin"[^>]*>.*?<\/svg>地図で見る<\/a>/u,
      );
      expect(markup.indexOf("地図で見る")).toBeGreaterThan(
        markup.indexOf("Tokyo"),
      );
    } else {
      expect(markup).not.toContain("Tokyo");
      expect(markup).not.toContain("google.com/maps");
      expect(markup).toContain('<p class="region">東京都千代田区</p>');
      expect(markup).toContain(
        'href="/contacts/fixture%3Amultiple-phones?from=%2F%3Fq%3Dlibrary"',
      );
    }
  }
});

it("orders the contact card from the name to the homepage and leaves out the address block without an address", () => {
  const website = "https://example.org/library";
  const markup = renderToStaticMarkup(
    createElement(ContactCard, { contact: { ...contact, website } }),
  );
  const order = [
    "図書館",
    "Public library",
    "03-3581-2331",
    "電話をかける",
    "電話帳に入れる",
    "住所",
    "Tokyo",
    "地図で見る",
    "施設のホームページを開く",
    "</article>",
  ].map((text) => markup.indexOf(text));
  expect(order.every((position) => position >= 0)).toBe(true);
  expect(order).toEqual(order.toSorted((a, b) => a - b));
  expect(markup).toMatch(
    /<a class="button " href="https:\/\/example\.org\/library"[^>]*data-external-destination="facility"><svg[^>]*data-icon="external-link"[^>]*>.*?<\/svg>施設のホームページを開く<span class="srOnly">（新しいタブ）<\/span><\/a>/u,
  );
  for (const address of ["", "　"]) {
    const bare = renderToStaticMarkup(
      createElement(ContactCard, { contact: { ...contact, address } }),
    );
    expect(bare).not.toContain("住所");
    expect(bare).not.toContain("地図で見る");
    expect(bare).not.toContain("google.com/maps");
    expect(bare).not.toContain("施設のホームページを開く");
  }
});

it("names the map action after the facility and ends its name with the visible label", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), (name) => {
      const accessible = uiCopy.address.mapName(name);
      expect(uiCopy.address.map).toBe("地図で見る");
      expect(accessible).toBe(`${name}を地図で見る`);
      expect(accessible.endsWith(uiCopy.address.map)).toBe(true);
    }),
    { numRuns: propertyRuns, seed: propertySeed },
  );
});

it("keeps a result's name as heading text and labels its one detail action by the address the details show", () => {
  const cases = [
    { address: "Tokyo", label: "住所などを見る" },
    { address: "", label: "くわしい情報を見る" },
    { address: "　", label: "くわしい情報を見る" },
  ] as const;
  for (const { address, label } of cases) {
    const card = serverCard({ ...contact, address }, regions, "/?q=library");
    const markup = renderToStaticMarkup(
      createElement(ResultCard, { card, onOpenRow: () => undefined }),
    );
    expect(markup).toContain(
      `<h3 class="contactName" id="contact-${contact.id}" tabindex="-1">Public library</h3>`,
    );
    expect(markup.match(/href="\/contacts\//gu)).toHaveLength(1);
    expect(markup).toMatch(
      new RegExp(
        `<a class="detailAction" href="/contacts/[^"]+" aria-label="Public libraryの${label}"><svg[^>]*data-icon="chevron-right"[^>]*>.*?</svg>${label}</a>`,
        "u",
      ),
    );
    expect(markup.indexOf("detailAction")).toBeGreaterThan(
      markup.lastIndexOf('href="tel:'),
    );
  }
});

it("puts the facility name before the visible detail label in the accessible name", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1 }), fc.boolean(), (name, address) => {
      const label = uiCopy.resultDetail.label(address);
      const accessible = uiCopy.resultDetail.name(name, label);
      expect(label).toBe(address ? "住所などを見る" : "くわしい情報を見る");
      expect(accessible).toBe(`${name}の${label}`);
    }),
    { numRuns: propertyRuns, seed: propertySeed },
  );
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
    hasAddress: true,
    href: `/contacts/row/${"a".repeat(64)}/41?from=%2F%3Fq%3D%E5%9B%B3%E6%9B%B8%E9%A4%A8`,
    row: { snapshot: "a".repeat(64), row: 41 },
  });
  expect(regionLabel("13999", regions)).toBe("東京都");
  expect(regionLabel("99", regions)).toBe("");
});
