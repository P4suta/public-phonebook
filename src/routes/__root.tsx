import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useMatches,
  useRouter,
} from "@tanstack/react-router";
import { type ReactElement, type ReactNode, useEffect } from "react";
import { environments } from "../core/environment.ts";
import { ErrorPage } from "../ui/error-page.tsx";
import { ExternalLinkConfirmation } from "../ui/external-link-dialog.tsx";
import { siteIcons } from "../ui/icon-catalog.ts";
import { IconSprite } from "../ui/icons.tsx";
import { pageIcons } from "../ui/route-icons.ts";
import { iconSprite } from "../ui/styles.css.ts";

const siteName = "Public Phonebook";
const siteDescription = "施設や窓口の電話番号をさがせます。";
const { favicon, vectorFavicon, appleTouchIcon, maskIcon, socialPreview } =
  siteIcons;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "format-detection", content: "telephone=no" },
        { title: siteName },
        { name: "description", content: siteDescription },
        { property: "og:type", content: "website" },
        { property: "og:title", content: siteName },
        { property: "og:description", content: siteDescription },
        {
          property: "og:image",
          content: new URL(socialPreview.href, environments.production.origin)
            .href,
        },
        { property: "og:image:width", content: String(socialPreview.width) },
        { property: "og:image:height", content: String(socialPreview.height) },
        { property: "og:image:alt", content: siteName },
        { name: "twitter:card", content: "summary_large_image" },
      ],
      links: [
        { rel: "icon", href: favicon.href, sizes: favicon.sizes },
        { rel: "icon", href: vectorFavicon.href, type: vectorFavicon.type },
        {
          rel: "apple-touch-icon",
          href: appleTouchIcon.href,
          sizes: appleTouchIcon.sizes,
        },
        { rel: "mask-icon", href: maskIcon.href, color: maskIcon.color },
        { rel: "manifest", href: siteIcons.manifest.href },
      ],
    }),
    shellComponent: Root,
    component: Outlet,
    notFoundComponent: () => <ErrorPage title="ページが見つかりません" />,
    errorComponent: () => <ErrorPage title="ページを読みこめませんでした" />,
  },
);

function Root({ children }: { readonly children: ReactNode }): ReactElement {
  const nonce = useRouter().options.ssr?.nonce;
  const icons = useMatches({ select: pageIcons, structuralSharing: true });
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
        <IconSprite className={iconSprite} names={icons} />
        <a href="#main" className="skip-link">
          本文へ進む
        </a>
        {children}
        <ExternalLinkConfirmation />
        <Scripts />
      </body>
    </html>
  );
}
