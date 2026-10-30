import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useEffect } from "react";
import { ErrorPage } from "../ui/error-page.tsx";
import "../ui/styles.css.ts";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "format-detection", content: "telephone=no" },
        { title: "Public Phonebook" },
        { name: "description", content: "施設や窓口の電話番号をさがせます。" },
      ],
      links: [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    }),
    shellComponent: Root,
    component: Outlet,
    notFoundComponent: () => <ErrorPage title="ページが見つかりません" />,
    errorComponent: () => <ErrorPage title="ページを読みこめませんでした" />,
  },
);

function Root({ children }: { readonly children: ReactNode }): ReactElement {
  const nonce = useRouter().options.ssr?.nonce;
  useEffect(() => {
    document.documentElement.dataset.enhanced = "true";
  }, []);
  return (
    <html lang="ja">
      <head>
        <meta property="csp-nonce" content={nonce} nonce={nonce} />
        <HeadContent />
      </head>
      <body>
        <a href="#main" className="skip-link">
          本文へ進む
        </a>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
