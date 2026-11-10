import type { ReactElement } from "react";
import { LinkButton } from "./components.tsx";
import { uiCopy } from "./copy.ts";
import * as css from "./styles.css.ts";

export function OpenSourceInformation(): ReactElement {
  return (
    <section className={css.stack} aria-labelledby="open-source-heading">
      <h2 id="open-source-heading" className={css.subheading}>
        {uiCopy.openSource.heading}
      </h2>
      <p className={css.body}>{uiCopy.openSource.description}</p>
      <div className={css.actions}>
        <LinkButton
          href="https://github.com/P4suta/public-phonebook"
          icon="external-link"
          destination="sourceCode"
        >
          {uiCopy.openSource.source}
        </LinkButton>
      </div>
    </section>
  );
}
