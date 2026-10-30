import type { ReactElement } from "react";
import { BackButton } from "./components.tsx";
import * as css from "./styles.css.ts";

export function ErrorPage({ title }: { readonly title: string }): ReactElement {
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton />
        <h1 className={css.heading}>{title}</h1>
      </div>
    </main>
  );
}
