import {
  privateReturnTarget,
  type ReturnTarget,
} from "@public-phonebook/directory/private-navigation";
import { ClientOnly } from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useSyncExternalStore } from "react";

interface ReturnNavigationProps {
  readonly from: string;
  readonly children: (target: ReturnTarget) => ReactNode;
}

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useLocationHash(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
}

function HydratedReturnNavigation({
  from,
  children,
}: ReturnNavigationProps): ReactNode {
  const hash = useLocationHash();
  return children(privateReturnTarget(hash) ?? { from, local: false });
}

export function PrivateReturnNavigation(
  props: ReturnNavigationProps,
): ReactElement {
  return (
    <ClientOnly
      fallback={
        <noscript>
          {props.children({ from: props.from, local: false })}
        </noscript>
      }
    >
      <HydratedReturnNavigation from={props.from}>
        {props.children}
      </HydratedReturnNavigation>
    </ClientOnly>
  );
}
