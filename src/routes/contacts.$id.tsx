import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { BackButton, ContactCard, LinkButton } from "../ui/components.tsx";
import { uiCopy } from "../ui/copy.ts";
import { getRouteContact } from "../ui/route-data.ts";
import * as css from "../ui/styles.css.ts";

export interface ReturnSearch {
  readonly from?: string;
}

export function validateReturnSearch(
  raw: Record<string, unknown>,
): ReturnSearch {
  return typeof raw.from === "string" && /^\/(?:\?[^#]*)?$/u.test(raw.from)
    ? { from: raw.from }
    : {};
}

export const Route = createFileRoute("/contacts/$id")({
  validateSearch: validateReturnSearch,
  loader: ({ params }) => getRouteContact(params.id),
  component: ContactPage,
});

function ContactPage(): ReactElement {
  const contact = Route.useLoaderData();
  const { from = "/" } = Route.useSearch();
  const sourcePath = `/contacts/${encodeURIComponent(contact.id)}/source?from=${encodeURIComponent(from)}`;
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton href={from}>検索結果にもどる</BackButton>
        <ContactCard contact={contact} />
        <h2 className={css.subheading}>{uiCopy.sourceTitle}</h2>
        {/^\d{4}-\d{2}-\d{2}$/u.test(contact.dataAsOf) && (
          <p>データの日付：{formatDate(contact.dataAsOf)}</p>
        )}
        <div className={css.actionColumn}>
          <LinkButton href={sourcePath} icon="file-search">
            {uiCopy.sourceAction}
          </LinkButton>
        </div>
      </div>
    </main>
  );
}

export function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  return match
    ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日`
    : value;
}
