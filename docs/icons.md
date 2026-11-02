# Shared icons

The [Figma icon library](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=317-1020) owns the editable vector masters.
The brand combines an open phonebook and a telephone handset.
Open pages are the intended cue for publicly readable information.
A user study would need to establish recognition of that meaning.
The mark uses black and white and has separate optical drawings for small favicons.

`design/icons.json` records each exported SVG's Figma node, dimensions, SHA-256 digest, category mapping, and native resource name.
The checked-in sources comprise 92 product icons and 16 brand variants.
Production uses an unbadged app icon for both App Store and TestFlight.
Development and verification builds use `DEV` and `QA` badges in all three appearances.
The product icons keep their [Lucide and Feather notices](../design/licenses/Lucide.txt).
The custom brand mark is separate from those third-party glyphs.

Run `mise x -- just icons` after changing a checked-in vector.
Run `mise x -- just icons-check` to reject changed source digests, unsupported SVG content, missing mappings, or stale and unexpected derived files.
Import a complete Figma export with `mise x -- cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- icons --import PATH`.
An import contains `format`, `fileKey`, `reviewNode`, `assets`, `categories`, and `aliases`.
Every asset carries `id`, `name`, `kind`, `width`, `height`, and `svg`.
Inspect the Figma source and actual-size previews before replacing the import.

## Native outputs

The generator produces the native app icon appearances, category image sets, and category catalog.
The primary app icon uses opaque red, green, and blue channels.
The dark appearance retains its intended transparency.
Unit tests decode generated images independently to check their dimensions, color type, and depth.

Native category mappings cover all 65 catalog categories.
The app keeps the `file` icon for a category without a mapping.
`ios-generate` generates native resource images.
The native build verifies ignored image sets.
`icons-check` includes the tracked native AppIcon assets.
These checks establish asset consistency and packaging.

## Web outputs

The same command writes the website's assets from the same masters.

| Output | Master | Use |
| --- | --- | --- |
| `src/ui/icon-catalog.ts` | Every product icon and `design/icons.json` | Typed icon names, the sprite's symbols, category mappings, and head declarations |
| `public/icons/NAME.svg` | Each product icon | The unchanged Figma export |
| `public/icons/LICENSE.txt` | `design/licenses/Lucide.txt` | The Lucide and Feather notices beside the glyphs |
| `public/favicon.ico` | `favicon-16`, `favicon-32` | Windows icon file with 32-bit Portable Network Graphics (PNG) images |
| `public/favicon.svg` | `favicon-32`, `favicon-dark-32` | Vector favicon that follows the light or dark color scheme |
| `public/apple-touch-icon.png` | `app-icon-default` | Apple home-screen icon at 180 pixels |
| `public/app-icon-SIZE.png` | `app-icon-default` | Installation icons at 192 and 512 pixels |
| `public/app-icon-maskable-SIZE.png` | `app-icon-default` | Maskable installation icons at 192 and 512 pixels |
| `public/mask-icon.svg` | `mark-ink` | Safari pinned-tab icon |
| `public/social-preview.png` | `social-preview` | Open Graph image at 1200 by 630 pixels |
| `public/manifest.webmanifest` | The installation icons | Install manifest |

The sprite has one `<symbol>` per product icon, painted with `currentColor`.
A clip path in a symbol keeps only its shape, because its paint never draws.
Every page defines it once at the start of the document, so an icon needs no request and still draws offline.
`src/ui/icons.tsx` draws every symbol from that sprite, so each icon takes the text color of its control.
The website resolves a category's icon from the same mappings as the app, including the `file` fallback.
Unit tests compare the web mappings with `IconCatalog.swift` and with the catalog's intended icon names.
They also require a distinct master for every category.

Rasters other than the dark native appearance must be opaque.
Every pixel of a maskable icon outside the central circle with 40% of the icon's width as its radius must be paper white.
Unit tests read the Windows icon directory by hand and decode each embedded PNG.
A browser check reads the directory again and decodes each image with the browser's own decoder.
It also confirms that the server returns each declared icon, the manifest, and the sharing image at its declared size.
Every browser test refuses a symbol that doesn't come from the sprite and an external link without exactly one new-tab icon.
