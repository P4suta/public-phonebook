import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { AppInvitation } from "../ui/app-invitation.tsx";
import { BackButton, LinkButton } from "../ui/components.tsx";
import { OpenSourceInformation } from "../ui/open-source-information.tsx";
import * as css from "../ui/styles.css.ts";

export const Route = createFileRoute("/about")({ component: AboutPage });

function AboutPage(): ReactElement {
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton />
        <h1 className={css.heading}>Public Phonebookについて</h1>
        <p className={css.body}>役所や学校、病院などの電話番号をさがせます。</p>
        <h2 className={css.subheading}>電話番号をさがす</h2>
        <p className={css.body}>検索欄に施設の名前を入れてください。</p>
        <AppInvitation />
        <OpenSourceInformation />
        <h2 className={css.subheading}>データをたしかめる・使う</h2>
        <p className={css.body}>
          電話番号のもとの情報や、データを使うときの決まりをたしかめられます。
          データをダウンロードできます。
        </p>
        <nav aria-label="データの説明" className={css.actions}>
          <LinkButton href="/data" icon="database">
            データについてくわしく知る
          </LinkButton>
        </nav>
        <nav aria-label="使い方とプライバシーの説明" className={css.actions}>
          <LinkButton href="/support" icon="life-buoy">
            使い方とお問い合わせ
          </LinkButton>
          <LinkButton href="/privacy" icon="shield-check">
            プライバシーについて読む
          </LinkButton>
        </nav>
      </div>
    </main>
  );
}
