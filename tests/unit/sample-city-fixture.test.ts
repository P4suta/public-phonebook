import { brotliDecompressSync } from "node:zlib";
import { DatasetFileListingSchema } from "@public-phonebook/directory/dataset-storage";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { directoryFixture } from "../../tools/directory-fixture.ts";
import { fixtureScenario } from "../../tools/native-fixture.ts";
import { sampleCityDirectory } from "../../tools/sample-city.ts";

describe("product image fixture", () => {
  it("keeps sample facilities, regions, and provenance in the same fictional city", () => {
    const { contacts, catalog, source } = sampleCityDirectory;
    expect(contacts.map((contact) => contact.name)).toContain(
      "みほん市民図書館",
    );
    expect(
      contacts.every(
        (contact) =>
          contact.address.includes("みほん市") &&
          contact.address.includes("サンプル"),
      ),
    ).toBe(true);
    expect(
      contacts.every((contact) =>
        contact.phones.every((phone) => phone.display === "03-0000-0000"),
      ),
    ).toBe(true);
    expect(
      contacts.every((contact) => contact.dataAsOf.startsWith("2099-")),
    ).toBe(true);
    expect(
      catalog.prefectures
        .filter((region) => region.contacts > 0)
        .map((region) => region.name),
    ).toEqual(["みほん県（サンプル）"]);
    expect(catalog.municipalities.map((region) => region.name)).toEqual([
      "みほん市",
    ]);
    expect(source.publisher).toBe("みほん市（サンプル）");
    for (const contact of contacts) {
      for (const url of [...contact.sourceUrls, contact.website].filter(
        (value) => value !== null,
      ))
        expect(new URL(url).hostname).toBe("sample-city.example.invalid");
    }
  });

  it("rejects live fixture overrides before sample capture", () => {
    expect(fixtureScenario({})).toBe("contract");
    expect(fixtureScenario({ PHONEBOOK_FIXTURE_SCENARIO: "sample-city" })).toBe(
      "sample-city",
    );
    for (const name of [
      "PHONEBOOK_FIXTURE_CONTACTS",
      "PHONEBOOK_FIXTURE_CATALOG",
      "PHONEBOOK_FIXTURE_PUBLIC_ORIGIN",
    ]) {
      expect(() =>
        fixtureScenario({
          PHONEBOOK_FIXTURE_SCENARIO: "sample-city",
          [name]: "",
        }),
      ).toThrow();
    }
    expect(() =>
      fixtureScenario({
        PHONEBOOK_FIXTURE_SCENARIO: "sample-city",
        PHONEBOOK_FIXTURE_REVISION: "updated",
      }),
    ).toThrow();
    expect(() =>
      fixtureScenario({ PHONEBOOK_FIXTURE_SCENARIO: "production" }),
    ).toThrow();
  });

  it("serves a sample archive and matching catalog through the actual API", async () => {
    const fixture = await directoryFixture({
      revision: "baseline",
      scenario: "sample-city",
    });
    try {
      const listingResponse = await fixture.fetch(
        new Request("https://contract.example/api/datasets"),
      );
      const listing = v.parse(
        DatasetFileListingSchema,
        await listingResponse.json(),
      );
      expect(listing.contacts).toBe(sampleCityDirectory.contacts.length);
      const archive = listing.files.find(
        (file) => file.format === "public-phonebook-directory/1",
      );
      expect(archive).toBeDefined();
      const response = await fixture.fetch(
        new Request(new URL(archive?.url ?? "", "https://contract.example")),
      );
      const text = new TextDecoder().decode(
        brotliDecompressSync(new Uint8Array(await response.arrayBuffer())),
      );
      expect(text).toContain("みほん市民図書館");
      expect(text).toContain("みほん市（サンプル）");
      expect(text).not.toContain("Test facility");
      expect(text).not.toContain("公開図書館");
    } finally {
      await fixture.dispose();
    }
  });
});
