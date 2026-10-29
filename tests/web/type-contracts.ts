import { FeedPage, type FeedState } from "../../web/app.ts";

export function invalidStatesMustFailCompilation(page: FeedPage): void {
  // @ts-expect-error Only the runtime validator can construct a feed page.
  const fabricated: FeedPage = {
    snapshot: "",
    total: -1,
    page: 0,
    pages: 0,
    shown: -1,
    html: "",
  };
  // @ts-expect-error The constructor is private.
  const unchecked = new FeedPage({});
  // @ts-expect-error Validated page properties are immutable.
  page.page = -1;
  // @ts-expect-error Loading requires ownership of its cancellation controller.
  const loading: FeedState = { kind: "loading", page: 1, mode: "automatic" };
  // @ts-expect-error Suspended states retain a resumable state.
  const suspended: FeedState = { kind: "suspended" };
  void [fabricated, unchecked, loading, suspended];
}
