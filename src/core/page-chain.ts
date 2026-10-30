import type { SearchResponse } from "./models.ts";
import type { Result } from "./result.ts";

export function checkPageChain(
  page: SearchResponse,
  previous: readonly SearchResponse[],
  requestedCursor: string,
  expectedSnapshot: string,
): Result<SearchResponse, "snapshot_changed" | "invalid_page"> {
  if (page.meta.snapshot !== expectedSnapshot)
    return { ok: false, error: "snapshot_changed" };
  const last = previous.at(-1);
  const seen = new Set(
    previous.flatMap((item) => item.data.map((contact) => contact.id)),
  );
  if (
    (last &&
      (last.meta.nextCursor !== requestedCursor ||
        last.meta.total !== page.meta.total)) ||
    page.data.some((contact) => seen.has(contact.id)) ||
    new Set(page.data.map((contact) => contact.id)).size !== page.data.length ||
    (page.meta.nextCursor !== null &&
      (page.data.length === 0 ||
        page.meta.nextCursor === requestedCursor ||
        previous.some((item) => item.meta.nextCursor === page.meta.nextCursor)))
  )
    return { ok: false, error: "invalid_page" };
  return { ok: true, value: page };
}
