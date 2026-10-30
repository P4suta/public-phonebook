import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { createClientOnlyFn, createIsomorphicFn } from "@tanstack/react-start";
import { FileBraces } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { config as configureZod } from "zod/v4/core";
import { browserCredentials } from "../core/staging-access-policy.ts";
import * as referenceCss from "../ui/api-reference.css.ts";
import {
  BackButton,
  CopyButton,
  LinkButton,
  LoadingError,
} from "../ui/components.tsx";
import * as css from "../ui/styles.css.ts";

type ReferenceComponent = typeof import("../ui/api-reference.tsx").default;
const loadReference = createClientOnlyFn(async () => {
  configureZod({ jitless: true });
  return import("../ui/api-reference.tsx");
});
export const Route = createFileRoute("/developers")({
  loader: async () => ({ origin: await readOrigin() }),
  component: DevelopersPage,
});
const readOrigin = createIsomorphicFn()
  .client((): string => window.location.origin)
  .server(async (): Promise<string> => {
    const { getRequestUrl } = await import("@tanstack/react-start/server");
    return getRequestUrl({ xForwardedHost: false, xForwardedProto: false })
      .origin;
  });

function DevelopersPage(): ReactElement {
  const { origin } = Route.useLoaderData();
  const [Reference, setReference] = useState<ReferenceComponent | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const onReady = useCallback((): void => setReady(true), []);
  const document = useQuery({
    queryKey: ["openapi-reference"],
    enabled: Reference !== null,
    retry: false,
    queryFn: async ({ signal }): Promise<string> => {
      const response = await fetch("/api/openapi.json", {
        signal,
        credentials: browserCredentials(window.location.origin),
      });
      if (!response.ok) throw new Error("The API description is unavailable");
      return response.text();
    },
  });
  useEffect(() => {
    let current = true;
    void loadReference()
      .then((module) => {
        if (current) setReference(() => module.default);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return (): void => {
      current = false;
    };
  }, []);
  return (
    <div id="main" className={referenceCss.page}>
      <nav aria-label="APIドキュメントの操作" className={css.actions}>
        <BackButton />
        <LinkButton href="/api/openapi.json" icon={FileBraces}>
          OpenAPI（JSON）を見る
        </LinkButton>
        <CopyButton
          value={new URL("/api/openapi.json", origin).href}
          label="仕様書のURLをコピー"
        />
      </nav>
      {(!ready || failed || document.isError) && (
        <main>
          <h1 className={css.heading}>Public Phonebook API</h1>
          {failed || document.isError ? (
            <LoadingError
              title="APIの説明を読みこめませんでした"
              retry={() => {
                if (failed) window.location.reload();
                else void document.refetch();
              }}
            />
          ) : (
            <p className={referenceCss.loading}>
              APIの説明を読みこんでいます。
            </p>
          )}
          <noscript>
            <p>APIの説明を操作するには、JavaScriptを有効にしてください。</p>
          </noscript>
        </main>
      )}
      <div
        className={referenceCss.reference}
        data-api-reference=""
        data-ready={ready}
      >
        {Reference && document.data && !document.isError && (
          <Reference content={document.data} onReady={onReady} />
        )}
      </div>
    </div>
  );
}
