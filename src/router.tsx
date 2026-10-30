import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, type Router } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { parseSearchString, stringifySearchValues } from "./core/web-search.ts";
import { routeTree } from "./routeTree.gen.ts";

const readNonce = createIsomorphicFn()
  .server(async (): Promise<string | undefined> => {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    return getRequestHeader("x-dial-nonce");
  })
  .client(
    (): string | undefined =>
      document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')
        ?.content,
  );

export async function getRouter(): Promise<
  ReturnType<typeof createDirectoryRouter>
> {
  return createDirectoryRouter(await readNonce());
}

function createDirectoryRouter(
  nonce: string | undefined,
): Router<typeof routeTree> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 60000, retry: 1, refetchOnWindowFocus: false },
    },
  });
  return createRouter({
    routeTree,
    parseSearch: parseSearchString,
    stringifySearch: stringifySearchValues,
    context: { queryClient },
    defaultPreload: "intent",
    scrollRestoration: true,
    ssr: nonce ? { nonce } : {},
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createDirectoryRouter>;
  }
}
