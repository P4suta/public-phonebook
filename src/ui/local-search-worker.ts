import type { LocalSearchReply } from "../core/local-search-protocol.ts";
import { fileSearchService } from "./file-search-service.ts";
import { localForgivingSearch } from "./local-search-mode.ts";
import {
  type LocalSearchPorts,
  localSearchService,
} from "./local-search-service.ts";
import { temporarySearchFiles } from "./search-files.ts";

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
  yield: (): Promise<void> =>
    new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (): void => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    }),
};
const handle = localForgivingSearch
  ? import("./forgiving-search-loader.ts").then(({ createRanking }) =>
      localSearchService(ports, createRanking),
    )
  : Promise.resolve(
      fileSearchService({
        ...ports,
        files: temporarySearchFiles,
        yield: ports.yield ?? ((): Promise<void> => Promise.resolve()),
      }),
    );
scope.addEventListener("message", (event) => {
  void handle.then((receive) => receive(event.data));
});
