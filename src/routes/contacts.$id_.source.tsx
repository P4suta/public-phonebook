import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { getCatalog, getSource } from "../ui/client.ts";
import { BackButton, LinkButton, OfficialLink } from "../ui/components.tsx";
import { getRouteContact } from "../ui/route-data.ts";
import * as css from "../ui/styles.css.ts";
import { formatDate } from "./contacts.$id.tsx";

export const Route = createFileRoute("/contacts/$id_/source")({
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
    return { contact, catalog, source: await getSource(contact.sourceId) };
  },
  component: SourcePage,
});

function SourcePage(): ReactElement {
  const { contact, catalog, source } = Route.useLoaderData();
  const { from } = Route.useSearch();
  const publisher = catalog.categories.find(
    (category) => category.id === contact.category,
  )?.publisher;
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton
          href={`/contacts/${encodeURIComponent(contact.id)}?from=${encodeURIComponent(from)}`}
        >
          施設の情報にもどる
        </BackButton>
        <h1 className={css.heading}>この電話番号の出典</h1>
        <h2 className={css.subheading}>{contact.name}</h2>
        {contact.phones.map((phone) => (
          <p className={css.heading} key={phone.e164}>
            {phone.display}
          </p>
        ))}
        <p className={css.body}>{publisher}が公開したデータです。</p>
        <div className={css.actions}>
          {contact.sourceUrls.map((url, index) => (
            <OfficialLink href={url} key={url}>
              {contact.sourceUrls.length === 1
                ? "データを公開したページを見る"
                : `データを公開したページを見る（${index + 1}）`}
            </OfficialLink>
          ))}
        </div>
        {contact.dataAsOf && (
          <p>データの日付：{formatDate(contact.dataAsOf)}</p>
        )}
        <p>データを集めた日：{formatDate(contact.retrievedAt)}</p>
        <p>
          使うときの決まり：
          {contact.license === "Public Domain"
            ? "パブリックドメイン"
            : contact.license}
        </p>
        <div className={css.actions}>
          <OfficialLink href={contact.licenseUrl}>利用条件を見る</OfficialLink>
          <OfficialLink href={source.url}>もとのファイルを開く</OfficialLink>
          <LinkButton href={`/api/sources/${encodeURIComponent(source.id)}`}>
            データの識別情報を見る
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
