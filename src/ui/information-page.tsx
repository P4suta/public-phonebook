import type { ReactElement } from "react";
import { BackButton, LinkButton } from "./components.tsx";
import type { ServiceInformation } from "./service-information.ts";
import * as css from "./styles.css.ts";

export function InformationPage({
  information,
}: {
  readonly information: ServiceInformation;
}): ReactElement {
  return (
    <main id="main" className={css.page}>
      <div className={css.stack}>
        <BackButton />
        <h1 className={css.heading}>Public Phonebookの{information.title}</h1>
        {information.updated ? (
          <p className={css.body}>{information.updated}</p>
        ) : null}
        {information.sections.map((section) => (
          <section
            key={section.title}
            className={css.stack}
            aria-label={section.title}
          >
            <h2 className={css.subheading}>{section.title}</h2>
            <p className={`${css.body} ${css.informationCopy}`}>
              {section.paragraphs.join("\n")}
            </p>
          </section>
        ))}
        <nav className={css.actions} aria-label="使い方とプライバシーの説明">
          {information.links.map((link) => (
            <LinkButton key={link.href} href={link.href}>
              {link.label}
            </LinkButton>
          ))}
        </nav>
      </div>
    </main>
  );
}
