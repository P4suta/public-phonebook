import { createFileRoute } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { ReactElement } from "react";
import {
  planReferenceRequest,
  referenceModel,
  referenceOperations,
  validateReferenceSearch,
} from "../core/api-reference.ts";
import * as referenceCss from "../ui/api-reference.css.ts";
import { ApiReference } from "../ui/api-reference.tsx";
import { referenceCopy, showsContractText } from "../ui/api-reference-copy.ts";
import { BackButton, CopyButton, LinkButton } from "../ui/components.tsx";
import { attemptPlan, browserSender } from "../ui/reference-request.ts";
import * as css from "../ui/styles.css.ts";

const openApiPath = "/api/openapi.json";

const readOrigin = createIsomorphicFn()
  .client((): string => window.location.origin)
  .server(async (): Promise<string> => {
    const { getRequestUrl } = await import("@tanstack/react-start/server");
    return getRequestUrl({ xForwardedHost: false, xForwardedProto: false })
      .origin;
  });

/** Sends a reference request: the server answers it in process, with the visitor's accepted content codings. */
const sendReferenceRequest = createIsomorphicFn()
  .client(browserSender)
  .server(async (target: string): Promise<Response> => {
    const [{ env }, { api }, { getRequestHeader }] = await Promise.all([
      import("cloudflare:workers"),
      import("../server/api.ts"),
      import("@tanstack/react-start/server"),
    ]);
    const encodings = getRequestHeader("accept-encoding");
    return api.fetch(
      new Request(new URL(target, env.PUBLIC_ORIGIN), {
        headers: encodings ? { "Accept-Encoding": encodings } : {},
      }),
      env,
    );
  });

export const Route = createFileRoute("/developers")({
  validateSearch: validateReferenceSearch,
  loaderDeps: ({ search }) => ({ search }),
  loader: async ({ deps }) => {
    const [origin, document] = await Promise.all([
      readOrigin(),
      sendReferenceRequest(openApiPath),
    ]);
    if (!document.ok) throw new Error("The API description is unavailable");
    const model = referenceModel(await document.json());
    const attempt = await attemptPlan(
      planReferenceRequest(referenceOperations(model), deps.search),
      sendReferenceRequest,
    );
    return { origin, model, attempt };
  },
  component: DevelopersPage,
});

function DevelopersPage(): ReactElement {
  const { origin, model, attempt } = Route.useLoaderData();
  const search = Route.useSearch();
  return (
    <main id="main" className={referenceCss.page}>
      <nav aria-label={referenceCopy.pageActions} className={css.actions}>
        <BackButton />
        <LinkButton href={openApiPath} icon="file-braces">
          {referenceCopy.openapi}
        </LinkButton>
        <CopyButton
          value={new URL(openApiPath, origin).href}
          label={referenceCopy.copyOpenapi}
          subject={referenceCopy.openapiSubject}
        />
      </nav>
      <header className={referenceCss.header}>
        <h1 className={css.heading}>{model.title}</h1>
        <p className={referenceCss.body}>{referenceCopy.intro}</p>
        {showsContractText && model.description && (
          <p className={referenceCss.body} lang="en">
            {model.description}
          </p>
        )}
        <p className={referenceCss.meta}>
          {referenceCopy.server}：<code>{origin}</code>
        </p>
        <p className={referenceCss.meta}>
          {referenceCopy.version}：<code>{model.version}</code>
        </p>
      </header>
      <ApiReference
        model={model}
        origin={origin}
        search={search}
        attempt={attempt}
      />
    </main>
  );
}
