import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import {
  BackButton,
  ContactCard,
  LinkButton,
  OfficialLink,
} from "../ui/components.tsx";
import { uiCopy } from "../ui/copy.ts";
import { getRouteContact } from "../ui/route-data.ts";
import * as css from "../ui/styles.css.ts";

export const Route = createFileRoute("/contacts/$id")({
  validateSearch: (raw: Record<string, unknown>) => ({
    from:
      typeof raw.from === "string" && /^\/(?:\?[^#]*)?$/u.test(raw.from)
        ? raw.from
        : "/",
  }),
  loader: ({ params }) => getRouteContact(params.id),
  component: ContactPage,
});

function ContactPage(): ReactElement {
  const contact = Route.useLoaderData();
  const { from } = Route.useSearch();
  const sourcePath = `/contacts/${encodeURIComponent(contact.id)}/source?from=${encodeURIComponent(from)}`;
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton href={from}>検索結果にもどる</BackButton>
        <ContactCard contact={contact} detail />
        {contact.website && (
          <div className={css.actions}>
            <OfficialLink href={contact.website}>
              施設のページを開く
            </OfficialLink>
          </div>
        )}
        <h2 className={css.subheading}>{uiCopy.sourceTitle}</h2>
        {/^\d{4}-\d{2}-\d{2}$/u.test(contact.dataAsOf) && (
          <p>データの日付：{formatDate(contact.dataAsOf)}</p>
        )}
        <div className={css.actions}>
          <LinkButton href={sourcePath}>{uiCopy.sourceAction}</LinkButton>
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
