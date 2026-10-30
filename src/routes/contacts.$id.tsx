import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { categoryDefinitions } from "../core/catalog.ts";
import { getCatalog } from "../ui/client.ts";
import {
  BackButton,
  ContactCard,
  LinkButton,
  OfficialLink,
} from "../ui/components.tsx";
import { getRouteContact } from "../ui/route-data.ts";
import * as css from "../ui/styles.css.ts";

export const Route = createFileRoute("/contacts/$id")({
  validateSearch: (raw: Record<string, unknown>) => ({
    from:
      typeof raw.from === "string" && /^\/(?:\?[^#]*)?$/u.test(raw.from)
        ? raw.from
        : "/",
  }),
  loader: async ({ params }) => {
    const [contact, catalog] = await Promise.all([
      getRouteContact(params.id),
      getCatalog(),
    ]);
    return { contact, catalog };
  },
  component: ContactPage,
});

function ContactPage(): ReactElement {
  const { contact, catalog } = Route.useLoaderData();
  const { from } = Route.useSearch();
  const publisher = catalog.categories.find(
    (category) => category.id === contact.category,
  )?.publisher;
  const sourcePath = `/contacts/${encodeURIComponent(contact.id)}/source?from=${encodeURIComponent(from)}`;
  const category = categoryDefinitions.find(
    (category) => category.id === contact.category,
  );
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
        <h2 className={css.subheading}>この電話番号の出典</h2>
        <p className={css.body}>
          {publisher ?? category?.label}が公開したデータです。
        </p>
        {/^\d{4}-\d{2}-\d{2}$/u.test(contact.dataAsOf) && (
          <p>データの日付：{formatDate(contact.dataAsOf)}</p>
        )}
        <div className={css.actions}>
          <LinkButton href={sourcePath}>電話番号の出典を見る</LinkButton>
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
