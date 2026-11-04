---
date: 2026-11-04
---

# Match every search word in the name, region, or category

## Status

Accepted.
It extends the name ranking in [Search the saved directory on the device](search-the-saved-directory-on-the-device.md) and [Search in the browser once the index loads](search-in-the-browser-once-the-index-loads.md).

## Context

The owner searched `市川 図書館` for `市川市中央図書館` and got nothing.
Every search path compared the whole normalized query as one substring of the normalized name, so a space between words never matched.
A word that named the facility's city or category instead of appearing in its name never matched either.
The comparison also told apart input variants that people trip over, such as katakana and hiragana, long-vowel and dash marks, and small `ヶ` and `ヵ`.
The iPhone app, the D1 server search, and the browser index each implement search, and they must keep returning the same rows in the same order.

## Decision

Read a query that spells a complete Japanese telephone number through the existing telephone path before anything splits it.
Fold any other query into a comparison form and split it into words at runs of any Unicode White_Space character.
The comparison form applies compatibility composition and lowercase as before.
It then turns katakana from `ァ` to `ヶ` and the iteration marks `ヽ` and `ヾ` into hiragana, turns small `ゕ`, `ゖ`, `ヵ`, and `ヶ` into `か` and `け`, and turns every long-vowel and dash mark in `ー`, `ｰ`, `-`, `‐`, `‑`, `‒`, `–`, `—`, `―`, `−`, `﹣`, and `－` into a hyphen-minus.
Canonical composition runs last, so a folded small kana joins a following voiced mark the way the first composition would have, and folding twice changes nothing.
Before compatibility composition, the comparison form drops the variation selectors from U+FE00 to U+FE0F and from U+E0100 to U+E01EF, so a selector can't stop a composition.
After lowercase, it turns each kanji variant into its group's representative through a generated table.
Apply the same folding to each row's name, prefecture name, municipality name, and category label, and never change displayed text.
Keep the 512-byte query limit and reject a name query of more than eight words as an invalid query.
Eight words keep a D1 search within its limit of 100 bound parameters.
Each word adds a name condition and up to three code lists, and the page query repeats each word in its rank expression for the selection, the order, and the continuation.
A test pins that worst case below the limit, because the local D1 runtime doesn't enforce it.

Match a row when every word occurs in its comparison name or in its prefecture name, municipality name, or category label.
Rank a one-word query by its exact, prefix, and substring position in the comparison name.
Give a row whose name holds every word of a longer query the substring tier.
Place every row that needs its region or category for some word in a fourth tier after every name match.
Keep the normalized name in UTF-8 order and then the identifier as the order within a tier, and keep the category groups and their continuation pages.
Keep the existing normalized name as the sort key, because the row numbers, the browser index positions, and the archive order all follow it, and keep the comparison form beside it.

Build the kanji table with `tools/kanji-variants.ts` from Unihan 18.0.0, which the tool pins by URL and SHA-256 and fetches into `target/`.
The tool joins characters in a fixed order of evidence.
It first joins the kJoyoKanji and kJinmeiyoKanji entries that point a variant at its standard form, and then the kZVariant pairs.
It then joins the kSemanticVariant entries that a source marks as z-variants, and last a nonstandard character's only kSemanticVariant that is a standard form.
No join puts two 常用漢字 or 人名用漢字 standard forms in one group, so `崎` and `埼` stay apart.
The representative is the group's standard form, or else its lowest code point, so a representative never folds again.
The semantic variants are part of the rule because the list pointers and z-variants alone join neither `﨑` with `崎` nor `髙` with `高`, and the owner requires both.
The tool writes the same pairs into `src/core/kanji-variants.ts` and `ios/Sources/PhonebookCore/KanjiVariants.swift`.
`just check` stays offline and requires both files to carry the same pairs under the pinned provenance.
`just check-build` fetches the pinned archive, verifies its digest, regenerates both files, and requires the committed bytes.

Define the comparison form once per platform and pin the two definitions together.
`src/core/search-text.ts` defines it for the website, and `SearchInput` defines it for the app.
`tools/search-contract.ts` writes the website's answers for every folded character, edge whitespace characters, seeded texts, and seeded match-and-rank cases into `ios/Tests/PhonebookCoreTests/SearchContract.json`.
The app's tests must give the same answers, and a website test requires the committed file to match a fresh one.
The rank decision lives in the annotated `wordRank` policy, which Dafny proves with a negative control that ranks a region match among the name matches.

D1 gains a `folded_name` column and builds its full-text terms from it.
The import derives both from the display name, so a bundle built before the column existed still seeds them.
The server resolves each word to the prefecture codes, municipality codes, and category identifiers whose comparison form holds it, and passes each list as one JSON parameter.
It narrows the rows through one word: the rarest full-text term of that word, joined with the rows its region or category holds, choosing the word with the fewest estimated rows.
The browser index keeps its format and derives each row's comparison name while it decodes.
The app writes a file of comparison names and a file of row region indexes into each generation and raises the saved format from 2 to 3.

## Consequences

`市川 図書館` finds `市川市中央図書館` and also a `中央図書館` in `市川市`, and `市ケ谷` finds `市ヶ谷`.
A one-word query that names a region or a category now lists that region's or category's other rows after its name matches, so a query such as `図書館` returns every library.
Broad region queries such as `東京` can match tens of thousands of rows, and the server counts and ranks them inside D1.
The search cache keys on the Worker version, so no cached response from the earlier rule survives a deployment.
The search identity of a word query changes, so a continuation cursor issued for a name query before the change fails as an invalid cursor, while searches without words keep their identity and cursors.
An app that saved a generation in format 2 counts as having no saved directory, so its next launch saves the bundled archive again before it catches up through deltas.
A query typed with `山﨑` finds `山崎`, and a query typed with `髙田` finds `高田`, in both directions on every path.
Unihan 18.0.0 joins neither `澤` with `沢`, `邊` or `邉` with `辺`, nor `齋` with `斎` through these fields, so those pairs still differ until a curated table adds them.
The table also folds some simplified Chinese forms, such as U+4E1C, into their Japanese standard forms, which only widens a query that uses them.
