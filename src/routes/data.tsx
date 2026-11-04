import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import type { DatasetFileListing } from "../core/dataset-storage.ts";
import { getCatalog, getDatasets } from "../ui/client.ts";
import { BackButton, LinkButton, OfficialLink } from "../ui/components.tsx";
import { CategoryIcon } from "../ui/icons.tsx";
import * as css from "../ui/styles.css.ts";

const datasetFormats: Readonly<
  Record<DatasetFileListing["files"][number]["file"], string>
> = {
  "contacts.jsonl.gz": "JSON Lines（1行に1件のJSON）、gzipで圧縮",
  "contacts.csv.gz": "CSV（表計算ソフトで開ける形式）、gzipで圧縮",
  "contacts.vcf.gz": "vCard（電話帳の形式）、gzipで圧縮",
  "directory.tsv.br": "iPhoneアプリが読む形式、Brotliで圧縮",
};

export const Route = createFileRoute("/data")({
  loader: async () => {
    const [catalog, datasets] = await Promise.all([
      getCatalog(),
      getDatasets(),
    ]);
    return { catalog, datasets };
  },
  component: DataPage,
});

function DataPage(): ReactElement {
  const { catalog, datasets } = Route.useLoaderData();
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton href="/about">サイトの説明にもどる</BackButton>
        <h1 className={css.heading}>データについて</h1>
        <p className={css.body}>施設が公開した電話番号をさがせます。</p>
        <h2 className={css.subheading}>すべてのデータをダウンロードする</h2>
        <p className={css.body}>
          すべての施設のデータを、だれでも登録せずにダウンロードできます。
          使うときの決まりは、施設ごとにファイルの中にあります。
        </p>
        <div>
          {datasets.files.map((file) => (
            <section key={file.file} className={css.dataRow}>
              <h3>{file.file}</h3>
              <p>形式：{datasetFormats[file.file]}</p>
              <p>大きさ：{file.bytes.toLocaleString("ja-JP")}バイト</p>
              <p className={css.status}>SHA-256：{file.sha256}</p>
              <div className={css.actions}>
                <LinkButton
                  href={file.url}
                  icon="download"
                  accessibleLabel={`${file.file}をダウンロードする`}
                >
                  ダウンロードする
                </LinkButton>
              </div>
            </section>
          ))}
        </div>
        <h2 className={css.subheading}>さがせる施設</h2>
        <p className={css.body}>
          {catalog.prefectures.length}都道府県、
          {catalog.contacts.toLocaleString("ja-JP")}件の施設があります。
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
                    <OfficialLink
                      href={category.licenseUrl}
                      destination="license"
                    >
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
