import type { LocalSearchReply } from "../core/local-search-protocol.ts";
import { localSearchService } from "./local-search-service.ts";

interface LocalSearchScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: LocalSearchReply): void;
}

const scope: LocalSearchScope = self;
const handle = localSearchService({
  fetch: async (url) => fetch(url),
  post: (reply) => scope.postMessage(reply),
});
scope.addEventListener("message", (event) => {
  void handle(event.data);
});
