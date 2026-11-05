import type { LocalSearchReply } from "../core/local-search-protocol.ts";
import { localForgivingSearch } from "./local-search-mode.ts";
import {
  type LocalSearchPorts,
  localSearchService,
} from "./local-search-service.ts";

interface LocalSearchScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: LocalSearchReply): void;
}

const scope: LocalSearchScope = self;
const ports: LocalSearchPorts = {
  fetch: async (url): Promise<Response> => fetch(url, { cache: "no-store" }),
  post: (reply): void => scope.postMessage(reply),
};
const handle = localForgivingSearch
  ? import("./forgiving-search-loader.ts").then(({ createRanking }) =>
      localSearchService(ports, createRanking),
    )
  : Promise.resolve(localSearchService(ports));
scope.addEventListener("message", (event) => {
  void handle.then((receive) => receive(event.data));
});
