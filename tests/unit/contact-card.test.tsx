import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as v from "valibot";
import { expect, it, vi } from "vitest";
import { ContactSchema } from "../../src/core/models.ts";
import { ContactCard, LinkButton } from "../../src/ui/components.tsx";

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
  heading: "heading",
  solid: "solid",
  srOnly: "srOnly",
  status: "status",
  telephone: "telephone",
}));

it("renders external web resources with isolated tabs and an accessible announcement before hydration", () => {
  const external = renderToStaticMarkup(
    <LinkButton href="https://example.org/terms">利用条件を見る</LinkButton>,
  );
  expect(external).toContain('target="_blank"');
  expect(external).toContain('rel="noopener noreferrer"');
  expect(external).toContain("lucide-external-link");
  expect(external).toContain("（新しいタブ）");
  const local = renderToStaticMarkup(
    <LinkButton href="/data">データについて</LinkButton>,
  );
  expect(local).not.toContain("target=");
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
  for (const detail of [false, true]) {
    const markup = renderToStaticMarkup(
      createElement(ContactCard, { contact, detail }),
    );
    expect(markup.match(/href="tel:/g)).toHaveLength(2);
    expect(markup.match(/data-phone/g)).toHaveLength(2);
    expect(markup.match(/<button[^>]*data-phone/g)).toHaveLength(2);
    expect(markup).not.toMatch(/<a[^>]*data-phone/u);
    expect(markup.match(/電話をかける<\/a>/g)).toHaveLength(2);
    for (const phone of contact.phones)
      expect(markup).toContain(`href="tel:${phone.e164}"`);
    expect(markup.match(/contact\.vcf/g) ?? []).toHaveLength(detail ? 1 : 0);
  }
});
