import {
  ArrowLeft,
  BookUser,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  type LucideIcon,
  MapPin,
  Phone,
  RotateCw,
} from "lucide-react";
import { type ReactElement, type ReactNode, useRef, useState } from "react";
import { categoryDefinitions } from "../core/catalog.ts";
import { copyCompletion } from "../core/copy-policy.ts";
import type { Contact } from "../core/models.ts";
import { formatPhone } from "../core/phone.ts";
import { cleanAddress } from "../core/search.ts";
import { copyText } from "./clipboard.ts";
import { uiCopy } from "./copy.ts";
import { foundation } from "./foundations.ts";
import { CategoryIcon } from "./icons.tsx";
import { opensNewTab } from "./links.ts";
import * as css from "./styles.css.ts";

const copyFeedback = {
  copied: "コピーしました。",
  failed: uiCopy.copyFailed,
} as const;

export function LinkButton({
  href,
  children,
  icon: Icon,
  primary = false,
  download = false,
  accessibleLabel,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly icon: LucideIcon;
  readonly primary?: boolean;
  readonly download?: boolean;
  readonly accessibleLabel?: string;
}): ReactElement {
  const newTab = opensNewTab(href);
  return (
    <a
      className={`${css.button} ${primary ? css.solid : ""}`}
      href={href}
      target={newTab ? "_blank" : undefined}
      rel={newTab ? "noopener noreferrer" : undefined}
      download={download || undefined}
      aria-label={
        accessibleLabel && newTab
          ? `${accessibleLabel}（新しいタブ）`
          : accessibleLabel
      }
    >
      <Icon size={foundation.control.icon} aria-hidden="true" />
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
      <LinkButton href={href} icon={ArrowLeft}>
        {children}
      </LinkButton>
    </div>
  );
}

export function CopyButton({
  value,
  label,
  accessibleLabel,
  feedback,
  presentation = "button",
}: {
  readonly value: string;
  readonly label: string;
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
    state === "copied" ? (
      <Check size={foundation.control.icon} aria-hidden="true" />
    ) : (
      <Copy size={foundation.control.icon} aria-hidden="true" />
    );
  async function copy(trusted: boolean): Promise<void> {
    const request = Symbol();
    requests.current = request;
    const succeeded = await copyText(value, trusted, css.srOnly);
    const outcome = copyCompletion(request === requests.current, succeeded);
    if (outcome === "superseded") return;
    setState(outcome);
    feedback?.announce(copyFeedback[outcome]);
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
          {state === "ready" ? "" : copyFeedback[state]}
        </output>
      )}
    </div>
  );
}

export function ContactCard({
  contact,
  detail = false,
  grouped = false,
  returnTo = "/",
}: {
  readonly contact: Contact;
  readonly detail?: boolean;
  readonly grouped?: boolean;
  readonly returnTo?: string;
}): ReactElement {
  const [feedback, setFeedback] = useState("");
  const copyRequests = useRef<symbol | null>(null);
  const feedbackId = `contact-feedback-${contact.id}`;
  const feedbackControl = {
    id: feedbackId,
    requests: copyRequests,
    announce: setFeedback,
  };
  const category = categoryDefinitions.find(
    (item) => item.id === contact.category,
  );
  const address = cleanAddress(contact.address);
  const information = `/contacts/${encodeURIComponent(contact.id)}?from=${encodeURIComponent(returnTo)}`;
  const ResultHeading = grouped ? "h3" : "h2";
  return (
    <article
      className={css.card}
      data-layout={detail ? "detail" : "result"}
      data-grouped={grouped && !detail ? "true" : undefined}
      aria-labelledby={`contact-${contact.id}`}
    >
      <div className={css.contactHeader}>
        {(detail || !grouped) && (
          <p className={css.category}>
            <CategoryIcon category={contact.category} />
            {category?.label}
          </p>
        )}
        {detail ? (
          <h1 className={css.heading} id={`contact-${contact.id}`}>
            {contact.name}
          </h1>
        ) : (
          <ResultHeading
            className={css.contactName}
            id={`contact-${contact.id}`}
          >
            <a
              className={css.contactLink}
              href={information}
              aria-label={`${contact.name}の情報を見る`}
            >
              <span>{contact.name}</span>
              <ChevronRight size={foundation.control.icon} aria-hidden="true" />
            </a>
          </ResultHeading>
        )}
      </div>
      <div className={css.contactNumbers} data-contact-part="phones">
        {contact.phones.map((phone, index) => {
          const display = formatPhone(phone.e164);
          return (
            <div className={css.phoneGroup} key={phone.e164}>
              <CopyButton
                value={display}
                label={display}
                accessibleLabel={`${display} コピーする（${contact.name}の電話番号）`}
                feedback={feedbackControl}
                presentation="telephone"
              />
              <div className={css.actions}>
                <LinkButton
                  href={`tel:${phone.e164}`}
                  primary
                  accessibleLabel={`${display}に電話をかける`}
                  icon={Phone}
                >
                  電話をかける
                </LinkButton>
                {detail && index === 0 && (
                  <LinkButton
                    href={`/api/contacts/${encodeURIComponent(contact.id)}/contact.vcf`}
                    download
                    icon={BookUser}
                  >
                    電話帳に入れる
                  </LinkButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {address && (
        <div className={css.contactLocation}>
          <a
            className={css.contactLink}
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${address}の地図を開く（新しいタブ）`}
          >
            <MapPin size={foundation.control.icon} aria-hidden="true" />
            <span>{address}</span>
            <ExternalLink size={foundation.control.icon} aria-hidden="true" />
          </a>
        </div>
      )}
      <output
        id={feedbackId}
        className={feedback ? css.cardFeedback : css.srOnly}
      >
        {feedback}
      </output>
    </article>
  );
}

export function OfficialLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <LinkButton href={href} icon={ExternalLink}>
      {children}
    </LinkButton>
  );
}

export function LoadingError({
  retry,
  restartHref,
  title = "検索結果を読みこめませんでした",
}: {
  readonly retry: () => void;
  readonly restartHref?: string | undefined;
  readonly title?: string;
}): ReactElement {
  return (
    <section className={css.stack} role="alert">
      <h2 className={css.subheading}>{title}</h2>
      <div className={css.actions}>
        {restartHref ? (
          <LinkButton href={restartHref} icon={RotateCw}>
            はじめから読みこむ
          </LinkButton>
        ) : (
          <button type="button" className={css.button} onClick={retry}>
            <RotateCw size={foundation.control.icon} aria-hidden="true" />
            もう一度読みこむ
          </button>
        )}
      </div>
    </section>
  );
}
