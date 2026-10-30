import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { getCatalog } from "../ui/client.ts";
import { BackButton, OfficialLink } from "../ui/components.tsx";
import { CategoryIcon } from "../ui/icons.tsx";
import * as css from "../ui/styles.css.ts";

export const Route = createFileRoute("/data")({
  loader: () => getCatalog(),
  component: DataPage,
});

function DataPage(): ReactElement {
  const catalog = Route.useLoaderData();
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton href="/about">サイトの説明にもどる</BackButton>
        <h1 className={css.heading}>データについて</h1>
        <p className={css.body}>施設や窓口が公開した電話番号をさがせます。</p>
        <h2 className={css.subheading}>さがせる施設や窓口</h2>
        <p className={css.body}>
          {catalog.prefectures.length}都道府県、
          {catalog.contacts.toLocaleString("ja-JP")}件の施設や窓口があります。
        </p>
        <div>
          {catalog.categories.map((category) => (
            <section key={category.id} className={css.dataRow}>
              <h3 className={css.category}>
                <CategoryIcon category={category.id} />
                {category.label}
              </h3>
              {category.license === "Source-specific reuse terms" ? (
                <p>
                  公開した機関や使うときの決まりは、施設ごとの画面にあります。
                </p>
              ) : (
                <>
                  <p>{category.publisher}</p>
                  <div className={css.actions}>
                    <OfficialLink href={category.licenseUrl}>
                      データを使うときの決まりを見る（{category.license}）
                    </OfficialLink>
                  </div>
                </>
              )}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
