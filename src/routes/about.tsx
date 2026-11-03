import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { BackButton, LinkButton } from "../ui/components.tsx";
import * as css from "../ui/styles.css.ts";

export const Route = createFileRoute("/about")({ component: AboutPage });

function AboutPage(): ReactElement {
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton />
        <h1 className={css.heading}>Public Phonebookについて</h1>
        <p className={css.body}>
          学校や役所などの電話番号を、名前でさがせます。
        </p>
        <h2 className={css.subheading}>電話番号をさがす</h2>
        <p className={css.body}>
          名前の一部を入れると、候補が出ます。 地域や施設の種類もえらべます。
        </p>
        <h2 className={css.subheading}>データをたしかめる・使う</h2>
        <p className={css.body}>
          電話番号のもとの情報や、データを使うときの決まりをたしかめられます。
          すべてのデータを、だれでも登録せずにダウンロードできます。
        </p>
        <nav aria-label="データの説明" className={css.actions}>
          <LinkButton href="/data" icon="database">
            データについてくわしく知る
          </LinkButton>
        </nav>
        <nav aria-label="使い方とプライバシーの説明" className={css.actions}>
          <LinkButton href="/support" icon="life-buoy">
            使い方と、声を伝える方法を見る
          </LinkButton>
          <LinkButton href="/privacy" icon="shield-check">
            プライバシーについて読む
          </LinkButton>
        </nav>
      </div>
    </main>
  );
}
