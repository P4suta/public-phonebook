import type { APIRequestContext } from "@playwright/test";
import {
  type Contact,
  SearchResponseSchema,
} from "@public-phonebook/directory/models";
import * as v from "valibot";

/** The check fixture and the national data both hold this facility. */
const knownFacility = "国立国会図書館";

/** Looks the known facility up in the data the server serves, so a check runs on the fixture and national data alike. */
export async function knownContact(
  request: APIRequestContext,
): Promise<Contact> {
  const body: unknown = await (
    await request.get(
      `/api/contacts?${new URLSearchParams({ q: knownFacility })}`,
    )
  ).json();
  const contact = v
    .parse(SearchResponseSchema, body)
    .data.find((item) => item.name === knownFacility);
  if (!contact) throw new Error(`The served data has no ${knownFacility}`);
  return contact;
}
