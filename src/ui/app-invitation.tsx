import type { ReactElement } from "react";
import { LinkButton } from "./components.tsx";
import { uiCopy } from "./copy.ts";
import * as css from "./styles.css.ts";

export function AppInvitation(): ReactElement {
  return (
    <section className={css.stack} aria-labelledby="iphone-app-heading">
      <h2 id="iphone-app-heading" className={css.subheading}>
        {uiCopy.app.heading}
      </h2>
      <p className={`${css.body} ${css.informationCopy}`}>
        {[uiCopy.app.description, uiCopy.app.coverage].join("\n")}
      </p>
      <p className={css.body}>{uiCopy.app.setup}</p>
      <div className={css.actions}>
        <LinkButton
          href="https://apps.apple.com/jp/app/public-phonebook/id6828899028"
          icon="external-link"
          destination="appStore"
        >
          {uiCopy.app.store}
        </LinkButton>
      </div>
    </section>
  );
}
