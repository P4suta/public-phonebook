import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { categoryDefinitions } from "../core/catalog.ts";
import { copyCompletion } from "../core/copy-policy.ts";
import { mapSearchUrl } from "../core/map-link.ts";
import type { Contact } from "../core/models.ts";
import { formatPhone } from "../core/phone.ts";
import { cleanAddress } from "../core/search.ts";
import { copyText } from "./clipboard.ts";
import { type ExternalDestination, uiCopy } from "./copy.ts";
import type { IconName } from "./icon-catalog.ts";
import { CategoryIcon, Icon } from "./icons.tsx";
import { opensNewTab } from "./links.ts";
import type { ResultCardView } from "./result-cards.ts";
import * as css from "./styles.css.ts";

function copyFeedback(outcome: "copied" | "failed", subject: string): string {
  return outcome === "copied" ? uiCopy.copied(subject) : uiCopy.copyFailed;
}

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

export function CopyButton({
  value,
  label,
  subject,
  accessibleLabel,
  feedback,
  presentation = "button",
}: {
  readonly value: string;
  readonly label: string;
  readonly subject: string;
  readonly accessibleLabel?: string;
  readonly presentation?: "button" | "telephone";
  readonly feedback?: {
    readonly id: string;
    readonly requests: { current: symbol | null };
    readonly announce: (message: string) => void;
  };
}): ReactElement {
  const [state, setState] = useState<"ready" | "copied" | "failed">("ready");
  const latest = useRef<symbol | null>(null);
  const requests = feedback?.requests ?? latest;
  const icon =
    state === "copied" ? <Icon name="check" /> : <Icon name="copy" />;
  async function copy(trusted: boolean): Promise<void> {
    const request = Symbol();
    requests.current = request;
    const succeeded = await copyText(value, trusted, css.srOnly);
    const outcome = copyCompletion(request === requests.current, succeeded);
    if (outcome === "superseded") return;
    setState(outcome);
    feedback?.announce(copyFeedback(outcome, subject));
  }
  return (
    <div className={css.group}>
      <button
        type="button"
        className={presentation === "telephone" ? css.telephone : css.button}
        data-phone={presentation === "telephone" ? "" : undefined}
        aria-label={accessibleLabel}
        aria-describedby={feedback?.id}
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          void copy(event.nativeEvent.isTrusted);
        }}
      >
        {presentation === "telephone" ? (
          <>
            <span>{label}</span>{" "}
            <span className={css.numberCopyHint} aria-hidden="true">
              {icon}
              {uiCopy.copy}
            </span>
          </>
        ) : (
          <>
            {icon}
            {label}
          </>
        )}
      </button>
      {!feedback && (
        <output className={state === "ready" ? css.srOnly : css.status}>
          {state === "ready" ? "" : copyFeedback(state, subject)}
        </output>
      )}
    </div>
  );
}

interface CopyFeedback {
  readonly id: string;
  readonly message: string;
  readonly control: {
    readonly id: string;
    readonly requests: { current: symbol | null };
    readonly announce: (message: string) => void;
  };
}

function useCopyFeedback(key: string): CopyFeedback {
  const [message, setMessage] = useState("");
  const requests = useRef<symbol | null>(null);
  const id = `contact-feedback-${key}`;
  return { id, message, control: { id, requests, announce: setMessage } };
}

function PhoneActions({
  phones,
  name,
  feedback,
  vcard,
}: {
  readonly phones: readonly string[];
  readonly name: string;
  readonly feedback: CopyFeedback;
  readonly vcard?: string;
}): ReactElement {
  return (
    <div className={css.contactNumbers} data-contact-part="phones">
      {phones.map((e164, index) => {
        const display = formatPhone(e164);
        return (
          <div className={css.phoneGroup} key={e164}>
            <CopyButton
              value={display}
              label={display}
              subject="電話番号"
              accessibleLabel={`${display} コピーする（${name}の電話番号）`}
              feedback={feedback.control}
              presentation="telephone"
            />
            <div className={css.actions}>
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

function FeedbackRow({
  feedback,
}: {
  readonly feedback: CopyFeedback;
}): ReactElement {
  return (
    <output
      id={feedback.id}
      className={feedback.message ? css.cardFeedback : css.srOnly}
    >
      {feedback.message}
    </output>
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

/** Shows a search result with its place and telephone actions; the address stays on the detail page. */
export function ResultCard({
  card,
  onOpenRow,
}: {
  readonly card: ResultCardView;
  readonly onOpenRow: (card: ResultCardView) => void;
}): ReactElement {
  const feedback = useCopyFeedback(card.key);
  const headingId = `contact-${card.key}`;
  return (
    <article
      className={css.card}
      data-layout="result"
      data-grouped="true"
      aria-labelledby={headingId}
    >
      <div className={css.contactHeader}>
        <h3 className={css.contactName} id={headingId}>
          <a
            className={css.contactLink}
            href={card.href}
            aria-label={`${card.name}の情報を見る`}
            onClick={(event) => {
              if (!card.row || !plainActivation(event)) return;
              event.preventDefault();
              onOpenRow(card);
            }}
          >
            <span>{card.name}</span>
            <Icon name="chevron-right" />
          </a>
        </h3>
        {card.region && <p className={css.region}>{card.region}</p>}
      </div>
      <PhoneActions phones={card.phones} name={card.name} feedback={feedback} />
      <FeedbackRow feedback={feedback} />
    </article>
  );
}

export function ContactCard({
  contact,
}: {
  readonly contact: Contact;
}): ReactElement {
  const feedback = useCopyFeedback(contact.id);
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
        name={contact.name}
        feedback={feedback}
        vcard={`/api/contacts/${encodeURIComponent(contact.id)}/contact.vcf`}
      />
      {address && (
        <div className={css.contactLocation}>
          {map ? (
            <a
              className={css.contactLink}
              href={map}
              target="_blank"
              rel="noopener noreferrer"
              data-external-destination={
                "address" satisfies ExternalDestination
              }
              aria-label={`${address}の地図を開く（新しいタブ）`}
            >
              <Icon name="map-pin" />
              <span>
                {address}
                <Icon name="external-link" className={css.trailingIcon} />
              </span>
            </a>
          ) : (
            <p>{address}</p>
          )}
        </div>
      )}
      <FeedbackRow feedback={feedback} />
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
