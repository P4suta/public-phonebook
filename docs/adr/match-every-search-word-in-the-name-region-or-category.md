---
date: 2026-11-04
---

# Match every search word in the name, region, or category

## Status

Accepted.
It extends the name ranking in [Search the saved directory on the device](search-the-saved-directory-on-the-device.md) and [Search in the browser once the index loads](search-in-the-browser-once-the-index-loads.md).
[Identify each D1 database by its dataset and import transformation](identify-each-d1-database-by-its-dataset-and-import-transformation.md) amends its consequence for the folded names in D1, because a changed fold table now names a new database.

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

Build the kanji table with `tools/kanji-variants.ts` from the Joyo Kanji Table notice of 2010-11-30 and Unihan 18.0.0, which the tool pins by URL and SHA-256 and fetches into `target/`.
The tool joins characters in a fixed order of evidence.
It first joins each traditional form that the notice prints in round brackets beside a standard character, so no later Unihan edge can pull that form into another group.
It then joins the kJoyoKanji and kJinmeiyoKanji entries that point a variant at its standard form, and then the kZVariant pairs.
It then joins the kSemanticVariant entries that a source marks as z-variants, and last a nonstandard character's only kSemanticVariant that is a standard form.
No join puts two 常用漢字 or 人名用漢字 standard forms in one group, so `崎` and `埼` stay apart.
The representative is the group's standard form, or else its lowest code point, so a representative never folds again.
The semantic variants are part of the rule because the list pointers and z-variants alone join neither `﨑` with `崎` nor `髙` with `高`, and the owner requires both.
Every traditional form must fold into its standard character, or the generation stops.
The tool writes the same pairs into `src/core/kanji-variants.ts` and `ios/Sources/PhonebookCore/KanjiVariants.swift`, and it writes the notice's traditional forms into `tools/joyo-traditional-forms.ts`.
`just check` stays offline and requires both tables to carry the same pairs under the pinned provenance and to fold every committed traditional form into its standard character.
`just check-build` fetches both pinned files, verifies their digests, regenerates the three files, and requires the committed bytes.

The tool reads the notice's main table from the Agency for Cultural Affairs PDF through pdf.js, and it refuses any text in the bracket column that isn't a bracketed form.
It requires the notice's 2136 characters, which must equal Unihan's kJoyoKanji list, and 364 traditional forms beside 362 of them.
The notice draws the form beside `亀` as outlines, so the tool supplies `龜` for those empty brackets, and it reads the three forms that `弁` stacks inside one pair of drawn brackets.
The square brackets beside five characters give permitted printed forms with the same code points, so they stay out, and `餅` carries its traditional form `餠` in round brackets on the next line.
Unihan 18.0.0's kJapaneseNewVariant and kJapaneseOldVariant list the same 364 pairs, and the generation requires both equalities, so a form that the layout hides stops it.

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
A query typed with `澤`, `邊`, or `齋` finds `沢`, `辺`, or `斎`, and the reverse, on every path, and so does every other traditional form that the notice brackets.
Unihan's list pointers, z-variants, and semantic variants join none of those three pairs, which is why the notice's forms come first.
The table grows from 1033 to 1133 pairs.
Nine variants change representative, because the notice's forms now join before any Unihan edge.
`壹` folds into `壱` instead of `一`, `貳` into `弐` instead of `二`, `豫` into `予` instead of `預`, and `濱` into `浜` instead of `瀕`.
`歸`, `總`, `縂`, `遲`, and `樓` move from a nonstandard representative to `帰`, `総`, `総`, `遅`, and `楼`.
`邉` stays apart from `辺` and `邊`, because neither the notice nor these Unihan fields join it.
The variant pairs of the name kanji table in the Family Register Act's enforcement regulations come only from Unihan's kJinmeiyoKanji pointers.
No primary machine-readable publication of that table exists, because e-Gov's law XML carries it as images and the Ministry of Justice publishes it as a vertically set PDF.
The app raises its saved format from 3 to 4, so an app that saved comparison names under the earlier table saves the bundled archive again on its next launch.
A D1 database keeps the `folded_name` values of its import, and a release that reuses a database by its dataset digest keeps them too.
Until a release imports a dataset with a new digest, the server matches a name that holds a newly folded form by neither form.
The build gate downloads the notice from the Agency for Cultural Affairs, and Unihan's kJapaneseNewVariant alone would give the same pairs if that download stopped working.
The table also folds some simplified Chinese forms, such as U+4E1C, into their Japanese standard forms, which only widens a query that uses them.
