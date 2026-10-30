import { ExternalLink, X } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { confirmsNavigation } from "../core/navigation-policy.ts";
import { type ExternalDestination, uiCopy } from "./copy.ts";
import { foundation } from "./foundations.ts";
import * as css from "./styles.css.ts";

const primaryButton = 0;

interface Destination {
  readonly href: string;
  readonly host: string;
  readonly description: string;
}

function isDestination(
  value: string | undefined,
): value is ExternalDestination {
  return (
    value !== undefined && Object.hasOwn(uiCopy.external.destinations, value)
  );
}

export function ExternalLinkConfirmation(): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const openAction = useRef<HTMLButtonElement>(null);
  const origin = useRef<HTMLAnchorElement | null>(null);
  const [destination, setDestination] = useState<Destination | null>(null);
  useEffect(() => {
    function confirm(event: MouseEvent): void {
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        !confirmsNavigation(
          link.target === "_blank",
          (link.protocol === "http:" || link.protocol === "https:") &&
            link.origin !== location.origin,
          event.button === primaryButton,
          event.ctrlKey || event.metaKey || event.shiftKey || event.altKey,
          event.defaultPrevented,
        )
      )
        return;
      event.preventDefault();
      const key = link.dataset.externalDestination;
      origin.current = link;
      flushSync(() =>
        setDestination({
          href: link.href,
          host: link.host,
          description:
            uiCopy.external.destinations[isDestination(key) ? key : "other"],
        }),
      );
      dialog.current?.showModal();
      openAction.current?.focus();
    }
    document.addEventListener("click", confirm, { capture: true });
    return (): void =>
      document.removeEventListener("click", confirm, { capture: true });
  }, []);
  return (
    <dialog
      ref={dialog}
      className={css.dialog}
      aria-labelledby="external-link-heading"
      aria-describedby="external-link-description external-link-host external-link-tab"
      onClose={() => {
        const link = origin.current;
        origin.current = null;
        setDestination(null);
        link?.focus();
      }}
    >
      <h2 id="external-link-heading" className={css.subheading}>
        {uiCopy.external.heading}
      </h2>
      <p id="external-link-description" className={css.body}>
        {destination?.description}
      </p>
      <p id="external-link-host" className={css.body}>
        {uiCopy.external.host(destination?.host ?? "")}
      </p>
      <p id="external-link-tab" className={css.body}>
        {uiCopy.external.newTab}
      </p>
      <div className={css.actions}>
        <button
          ref={openAction}
          type="button"
          className={`${css.button} ${css.solid}`}
          onClick={() => {
            if (destination)
              window.open(destination.href, "_blank", "noopener,noreferrer");
            dialog.current?.close();
          }}
        >
          <ExternalLink size={foundation.control.icon} aria-hidden="true" />
          {uiCopy.external.open}
        </button>
        <button
          type="button"
          className={css.button}
          onClick={() => dialog.current?.close()}
        >
          <X size={foundation.control.icon} aria-hidden="true" />
          {uiCopy.external.cancel}
        </button>
      </div>
    </dialog>
  );
}
