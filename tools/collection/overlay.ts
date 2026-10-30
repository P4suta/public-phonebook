import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  type Contact,
  ContactSchema,
  type Source,
  SourceSchema,
} from "../../src/core/models.ts";

export interface CollectionOverlay {
  readonly contacts: readonly Contact[];
  readonly sources: readonly Source[];
}

export async function readCollectionOverlay(
  directory: string,
): Promise<CollectionOverlay> {
  const report: unknown = JSON.parse(
    await readFile(join(directory, "collection-report.json"), "utf8"),
  );
  const checked = v.parse(
    v.object({
      complete: v.literal(true),
      contacts: v.number(),
      failures: v.pipe(v.array(v.unknown()), v.length(0)),
    }),
    report,
  );
  const sourceValue: unknown = JSON.parse(
    await readFile(join(directory, "sources.json"), "utf8"),
  );
  const sources = v.parse(v.array(SourceSchema), sourceValue);
  const sourceIds = new Set(sources.map((source) => source.id));
  if (sourceIds.size !== sources.length)
    throw new Error("Duplicate collection source identity");
  const contacts = (await readFile(join(directory, "contacts.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      const contact = v.parse(ContactSchema, value);
      if (!sourceIds.has(contact.sourceId))
        throw new Error(`Missing collection source: ${contact.sourceId}`);
      return contact;
    });
  if (
    contacts.length !== checked.contacts ||
    new Set(contacts.map((contact) => contact.id)).size !== contacts.length
  )
    throw new Error("Collection contact accounting mismatch");
  return {
    contacts: contacts.sort((a, b) =>
      a.id < b.id ? -1 : a.id === b.id ? 0 : 1,
    ),
    sources,
  };
}

export function* mergeContacts(
  baseline: Iterable<Contact>,
  added: readonly Contact[],
): Generator<Contact> {
  let next = 0;
  for (const contact of baseline) {
    while (added[next] && (added[next]?.id ?? "") < contact.id) {
      const item = added[next++];
      if (item) yield item;
    }
    if (added[next]?.id === contact.id)
      throw new Error(
        `Collection overwrites an existing contact: ${contact.id}`,
      );
    yield contact;
  }
  for (const contact of added.slice(next)) yield contact;
}
