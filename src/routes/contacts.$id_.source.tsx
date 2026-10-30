import { createFileRoute } from "@tanstack/react-router";
import { FileBraces } from "lucide-react";
import type { ReactElement } from "react";
import { getCatalog, getSource } from "../ui/client.ts";
import { BackButton, LinkButton, OfficialLink } from "../ui/components.tsx";
import { uiCopy } from "../ui/copy.ts";
import { getRouteContact } from "../ui/route-data.ts";
import * as css from "../ui/styles.css.ts";
import { formatDate, validateReturnSearch } from "./contacts.$id.tsx";

export const Route = createFileRoute("/contacts/$id_/source")({
  validateSearch: validateReturnSearch,
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
  const { from = "/" } = Route.useSearch();
  const publisher =
    source.publisher ??
    catalog.categories.find((category) => category.id === contact.category)
      ?.publisher;
  const publicationUrls = contact.sourceUrls.filter(
    (url) => url !== source.url,
  );
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton
          href={`/contacts/${encodeURIComponent(contact.id)}?from=${encodeURIComponent(from)}`}
        >
          施設の情報にもどる
        </BackButton>
        <h1 className={css.heading}>{uiCopy.sourceTitle}</h1>
        <h2 className={css.subheading}>{contact.name}</h2>
        {contact.phones.map((phone) => (
          <p className={css.heading} key={phone.e164}>
            {phone.display}
          </p>
        ))}
        {publisher && (
          <p className={css.body}>{publisher}が公開したデータです。</p>
        )}
        <div className={css.actions}>
          {publicationUrls.map((url, index) => (
            <OfficialLink href={url} key={url} destination="publication">
              {publicationUrls.length === 1
                ? "データを公開したページを見る"
                : `データを公開したページを見る（${index + 1}）`}
            </OfficialLink>
          ))}
        </div>
        {/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(contact.dataAsOf) && (
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
          <OfficialLink href={contact.licenseUrl} destination="license">
            データを使うときの決まりを見る
          </OfficialLink>
          <OfficialLink href={source.url} destination="source">
            もとの資料を開く
          </OfficialLink>
          <LinkButton
            href={`/api/sources/${encodeURIComponent(source.id)}`}
            icon={FileBraces}
          >
            開発者向けの記録を見る
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
