import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { contactReturnHref } from "../core/private-navigation.ts";
import { BackButton, ContactCard, LinkButton } from "../ui/components.tsx";
import { uiCopy } from "../ui/copy.ts";
import { PrivateReturnNavigation } from "../ui/private-return-navigation.tsx";
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
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <PrivateReturnNavigation from={from}>
          {(target) => (
            <BackButton href={target.from}>検索結果にもどる</BackButton>
          )}
        </PrivateReturnNavigation>
        <ContactCard contact={contact} />
        <h2 className={css.subheading}>{uiCopy.sourceTitle}</h2>
        {/^\d{4}-\d{2}-\d{2}$/u.test(contact.dataAsOf) && (
          <p>データの日付：{formatDate(contact.dataAsOf)}</p>
        )}
        <div className={css.actionColumn}>
          <PrivateReturnNavigation from={from}>
            {(target) => (
              <LinkButton
                href={contactReturnHref(
                  `/contacts/${encodeURIComponent(contact.id)}/source`,
                  target,
                )}
                icon="file-search"
              >
                {uiCopy.sourceAction}
              </LinkButton>
            )}
          </PrivateReturnNavigation>
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
