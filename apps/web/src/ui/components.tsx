import { categoryDefinitions } from "@public-phonebook/directory/catalog";
import { mapSearchUrl } from "@public-phonebook/directory/map-link";
import type { Contact } from "@public-phonebook/directory/models";
import { formatPhone } from "@public-phonebook/directory/phone";
import { cleanAddress } from "@public-phonebook/directory/search";
import type { MouseEvent, ReactElement, ReactNode } from "react";
import { type ExternalDestination, uiCopy } from "./copy.ts";
import type { IconName } from "./icon-catalog.ts";
import { CategoryIcon, Icon } from "./icons.tsx";
import { opensNewTab } from "./links.ts";
import type { ResultCardView } from "./result-cards.ts";
import * as css from "./styles.css.ts";

export function LinkButton({
  href,
  children,
  icon,
  primary = false,
  download = false,
  accessibleLabel,
  destination,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly icon: IconName;
  readonly primary?: boolean;
  readonly download?: boolean;
  readonly accessibleLabel?: string;
  readonly destination?: ExternalDestination | undefined;
}): ReactElement {
  const newTab = opensNewTab(href);
  return (
    <a
      className={`${css.button} ${primary ? css.solid : ""}`}
      href={href}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener noreferrer" : undefined}
      data-external-destination={newTab ? destination : undefined}
      download={download || undefined}
      aria-label={
        accessibleLabel && newTab
          ? `${accessibleLabel}（新しいタブ）`
          : accessibleLabel
      }
    >
      <Icon name={icon} />
      {children}
      {newTab && !accessibleLabel && (
        <span className={css.srOnly}>（新しいタブ）</span>
      )}
    </a>
  );
}

export function BackButton({
  href = "/",
  children = uiCopy.searchReturn,
}: {
  readonly href?: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className={css.actions}>
      <LinkButton href={href} icon="arrow-left">
        {children}
      </LinkButton>
    </div>
  );
}

/** Shows each number as selectable text above its call action, and offers contact saving once. */
function PhoneActions({
  phones,
  vcard,
}: {
  readonly phones: readonly string[];
  readonly vcard?: string;
}): ReactElement {
  return (
    <div className={css.contactNumbers} data-contact-part="phones">
      {phones.map((e164, index) => {
        const display = formatPhone(e164);
        return (
          <div className={css.phoneGroup} key={e164}>
            <p className={css.telephone} data-phone="">
              {display}
            </p>
            <div className={css.actionColumn}>
              <LinkButton
                href={`tel:${e164}`}
                primary
                accessibleLabel={`${display}に電話をかける`}
                icon="phone"
              >
                電話をかける
              </LinkButton>
              {vcard && index === 0 && (
                <LinkButton href={vcard} download icon="book-user">
                  電話帳に入れる
                </LinkButton>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function plainActivation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Shows a search result with its place, telephone actions, and one labelled detail action; the address stays on the detail page. */
export function ResultCard({
  card,
  onOpenRow,
}: {
  readonly card: ResultCardView;
  readonly onOpenRow: (card: ResultCardView) => void;
}): ReactElement {
  const headingId = `contact-${card.key}`;
  const detail = uiCopy.resultDetail.label(card.hasAddress);
  return (
    <article
      className={css.card}
      data-layout="result"
      data-grouped="true"
      aria-labelledby={headingId}
    >
      <div className={css.contactHeader}>
        <h3 className={css.contactName} id={headingId} tabIndex={-1}>
          {card.name}
        </h3>
        {card.region && <p className={css.region}>{card.region}</p>}
      </div>
      <PhoneActions phones={card.phones} />
      <a
        className={css.detailAction}
        href={card.href}
        aria-label={uiCopy.resultDetail.name(card.name, detail)}
        onClick={(event) => {
          if (!card.row || !plainActivation(event)) return;
          event.preventDefault();
          onOpenRow(card);
        }}
      >
        <Icon name="chevron-right" />
        {detail}
      </a>
    </article>
  );
}

/**
 * Shows a facility's category, name, and telephone actions, then its address as plain text above a map action.
 * The facility's homepage action closes the card.
 */
export function ContactCard({
  contact,
}: {
  readonly contact: Contact;
}): ReactElement {
  const category = categoryDefinitions.find(
    (item) => item.id === contact.category,
  );
  const address = cleanAddress(contact.address);
  const map = address ? mapSearchUrl(contact.name, address) : null;
  return (
    <article
      className={css.card}
      data-layout="detail"
      aria-labelledby={`contact-${contact.id}`}
    >
      <div className={css.contactHeader}>
        <p className={css.category}>
          <CategoryIcon category={contact.category} />
          {category?.label}
        </p>
        <h1 className={css.heading} id={`contact-${contact.id}`}>
          {contact.name}
        </h1>
      </div>
      <PhoneActions
        phones={contact.phones.map((phone) => phone.e164)}
        vcard={`/api/contacts/${encodeURIComponent(contact.id)}/contact.vcf`}
      />
      {address && (
        <div className={css.contactLocation}>
          <div className={css.contactAddress}>
            <h2 className={css.addressHeading}>{uiCopy.address.heading}</h2>
            <p className={css.body}>{address}</p>
          </div>
          {map && (
            <div className={css.actionColumn}>
              <LinkButton
                href={map}
                icon="map-pin"
                destination="address"
                accessibleLabel={uiCopy.address.mapName(contact.name)}
              >
                {uiCopy.address.map}
              </LinkButton>
            </div>
          )}
        </div>
      )}
      {contact.website && (
        <div className={css.actionColumn}>
          <OfficialLink href={contact.website} destination="facility">
            {uiCopy.facilityHomepage}
          </OfficialLink>
        </div>
      )}
    </article>
  );
}

export function OfficialLink({
  href,
  destination,
  children,
}: {
  readonly href: string;
  readonly destination: ExternalDestination;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <LinkButton href={href} icon="external-link" destination={destination}>
      {children}
    </LinkButton>
  );
}

export function LoadingError({
  retry,
  restartHref,
  subject = "検索結果",
}: {
  readonly retry: () => void;
  readonly restartHref?: string | undefined;
  readonly subject?: string;
}): ReactElement {
  return (
    <section className={css.stack} role="alert">
      <h2 className={css.subheading}>{uiCopy.loadFailed(subject)}</h2>
      <div className={css.actions}>
        {restartHref ? (
          <LinkButton href={restartHref} icon="rotate-cw">
            {uiCopy.reloadFromStart(subject)}
          </LinkButton>
        ) : (
          <button type="button" className={css.button} onClick={retry}>
            <Icon name="rotate-cw" />
            {uiCopy.reload(subject)}
          </button>
        )}
      </div>
    </section>
  );
}
