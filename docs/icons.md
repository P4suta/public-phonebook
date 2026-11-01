# Shared icons

The [Figma icon library](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=317-1020) owns the editable vector masters.
The brand combines an open phonebook and a telephone handset.
Open pages are the intended cue for publicly readable information.
A user study would need to establish recognition of that meaning.
The mark uses black and white and has separate optical drawings for small favicons.

`design/icons.json` records each exported SVG's Figma node, dimensions, SHA-256 digest, category mapping, and native resource name.
The checked-in sources comprise 58 product icons and 16 brand variants.
Production uses an unbadged app icon for both App Store and TestFlight.
Development and verification builds use `DEV` and `QA` badges in all three appearances.
The product icons keep their [Lucide and Feather notices](../design/licenses/Lucide.txt).
The custom brand mark is separate from those third-party glyphs.

Run `mise x -- just icons` after changing a checked-in vector.
Run `mise x -- just icons-check` to reject changed source digests, unsupported SVG content, missing mappings, or stale derived files.
Import a complete Figma export with `mise x -- cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- icons --import PATH`.
An import contains `format`, `fileKey`, `reviewNode`, `assets`, `categories`, and `aliases`.
Every asset carries `id`, `name`, `kind`, `width`, `height`, and `svg`.
Inspect the Figma source and actual-size previews before replacing the import.

The generator produces the native app icon appearances, category image sets, and category catalog.
The primary app icon uses opaque red, green, and blue channels.
The dark appearance retains its intended transparency.
Unit tests decode generated images independently to check their dimensions, color type, and depth.

Native category mappings cover the 39 catalog categories.
`ios-generate` generates native resource images.
The native build verifies ignored image sets.
`icons-check` includes the tracked native AppIcon assets.
These checks establish asset consistency and packaging.
