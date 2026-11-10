# Verified place readings

Web, iPhone, and Android share `apps/ios/Sources/PhonebookKit/PlaceReadings.json`.
The resource contains 47 prefectures and 32 reading forms for 27 category identifiers.
The website imports the JSON, Swift Package Manager copies the package resource, and Gradle copies the same file into Android resources.
The [decision](adr/match-verified-place-readings-without-a-ranking-companion.md) keeps the publication format and saved generations compatible.
Native version selection treats the resource and shared cases as shared source.
Both native input inventories and version preparation include the shared reading files.

## Matching

The existing search normalization folds width, katakana, and hiragana before comparison.
A reading prefix must contain at least two characters, use only folded kana or hyphen-minus, and contain a kana character.
Every matching prefecture or category remains eligible.
For example, `ふく` retains Fukushima, Fukui, and Fukuoka, while `やくしょ` retains both office categories.
`とうきょう としょかん` matches the Tokyo prefecture and library category together.
Reading substrings would also match Tokyo input inside the secondary-school reading, so reading matches use prefixes.

Literal facility names, written place names, and written category labels keep substring matching.
Literal name matches keep their existing exact, prefix, and substring tiers ahead of place matches.
Complete telephone numbers keep exact matching.
Municipal and facility-name readings require separate source coverage and remain outside the resource.
The explicitly enabled local fuzzy-search experiment retains its frozen matching contract.

Android bypasses its saved full-text prefilter for words with a known reading match.
Bound category identifiers and the prefecture prefix of each validated archive row supply the reading predicates.
Other words still use the full-text prefilter.
The query evaluates every word and preserves the existing ranking, category, and continuation constraints.
Existing archives, databases, and caller indexes need no reading migration.

## Prefecture source

The [Japan Post UTF-8 postal dataset](https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html) supplies the prefecture names and fullwidth katakana readings.
Japan Post published the checked national ZIP on October 30, 2026.
Source review retrieved the ZIP on November 8, 2026.
The [column specification](https://www.post.japanpost.jp/service/search/zipcode/download/utf-readme.html) identifies the municipal Japanese Industrial Standards (JIS) code, prefecture kana, and prefecture name as columns 1, 4, and 7.
Deduplication by prefecture and sorting by the code prefix yields the 47 ordered pairs in the resource.
Japan Post permits redistribution of the postal data under the terms on the download page.
The stored spelling follows Japan Post's fullwidth katakana convention and the app's existing comparison folding.
The feature defines no romanized spelling convention.

## Category lexical records

Source review checked the identified dictionary records on November 8, 2026.
Only headword readings and their applicable facility senses supply aliases.
Definitions and examples remain on the source pages.
Modern kana forms supply the stored readings, while bracketed historical spellings remain excluded.

Shogakukan's `デジタル大辞泉` records [hospital](https://kotobank.jp/word/%E7%97%85%E9%99%A2-121200), [clinic](https://kotobank.jp/word/%E8%A8%BA%E7%99%82%E6%89%80-82741), and [pharmacy](https://kotobank.jp/word/%E8%96%AC%E5%B1%80-143798).
The clinic entry explicitly records both `シンリョウジョ` and `シンリョウショ`.
Shogakukan's `精選版 日本国語大辞典` records the clinic sense of [dentist](https://kotobank.jp/word/%E6%AD%AF%E5%8C%BB%E8%80%85-598786).

`デジタル大辞泉` records [library](https://kotobank.jp/word/%E5%9B%B3%E6%9B%B8%E9%A4%A8-105194), [art museum](https://kotobank.jp/word/%E7%BE%8E%E8%A1%93%E9%A4%A8-119729), [public archive](https://kotobank.jp/word/%E5%85%AC%E6%96%87%E6%9B%B8%E9%A4%A8-63122), and [nursery](https://kotobank.jp/word/%E4%BF%9D%E8%82%B2%E6%89%80-131605).
Shogakukan's `プログレッシブ和英中辞典`, fourth edition, records [government office](https://kotobank.jp/jeword/%E5%BD%B9%E6%89%80), [museum](https://kotobank.jp/jeword/%E5%8D%9A%E7%89%A9%E9%A4%A8), and [kindergarten](https://kotobank.jp/jeword/%E5%B9%BC%E7%A8%9A%E5%9C%92).

`デジタル大辞泉` records [university](https://kotobank.jp/word/%E5%A4%A7%E5%AD%A6-90876), [junior college](https://kotobank.jp/word/%E7%9F%AD%E6%9C%9F%E5%A4%A7%E5%AD%A6-94934), and [high school](https://kotobank.jp/word/%E9%AB%98%E6%A0%A1-495063).
The high-school entry links its abbreviation with the complete headword `高等学校`.
`精選版 日本国語大辞典` records [technical college](https://kotobank.jp/word/%E9%AB%98%E7%AD%89%E5%B0%82%E9%96%80%E5%AD%A6%E6%A0%A1-62903).
The fourth edition of `プログレッシブ和英中辞典` records [elementary school](https://kotobank.jp/jeword/%E5%B0%8F%E5%AD%A6%E6%A0%A1) and [junior high school](https://kotobank.jp/jeword/%E4%B8%AD%E5%AD%A6%E6%A0%A1).

`デジタル大辞泉` records [secondary school](https://kotobank.jp/word/%E4%B8%AD%E7%AD%89%E6%95%99%E8%82%B2%E5%AD%A6%E6%A0%A1-178511), [special-needs school](https://kotobank.jp/word/%E7%89%B9%E5%88%A5%E6%94%AF%E6%8F%B4%E5%AD%A6%E6%A0%A1-178523), [vocational school](https://kotobank.jp/word/%E5%B0%82%E4%BF%AE%E5%AD%A6%E6%A0%A1-155072), and [miscellaneous school](https://kotobank.jp/word/%E5%90%84%E7%A8%AE%E5%AD%A6%E6%A0%A1-43648).
`デジタル大辞泉` records [education board](https://kotobank.jp/word/%E6%95%99%E8%82%B2%E5%A7%94%E5%93%A1%E4%BC%9A-52369), [health center](https://kotobank.jp/word/%E4%BF%9D%E5%81%A5%E6%89%80-132862), [fire station](https://kotobank.jp/word/%E6%B6%88%E9%98%B2%E7%BD%B2-533316), [police station](https://kotobank.jp/word/%E8%AD%A6%E5%AF%9F%E7%BD%B2-58802), and [community center](https://kotobank.jp/word/%E5%85%AC%E6%B0%91%E9%A4%A8-63220).
The fourth edition of `プログレッシブ和英中辞典` records [police box](https://kotobank.jp/jeword/%E4%BA%A4%E7%95%AA) and [customs office](https://kotobank.jp/jeword/%E7%A8%8E%E9%96%A2).
Heibonsha's `改訂新版　世界大百科事典` records the institutional sense of [court](https://kotobank.jp/word/%E8%A3%81%E5%88%A4%E6%89%80-68185).

## Interface and checks

Each search start screen explains the supported prefecture and common-category readings.
The Web field associates the visible help with `aria-describedby`, following the [W3C form-instructions guidance](https://www.w3.org/WAI/tutorials/forms/instructions/).
Native screens keep their platform text and search controls.

`PlaceReadingContract.json` supplies the same positive, ambiguous, normalized, and excluded inputs to TypeScript, Swift, and Kotlin tests.
Generated Web differential cases compare ranking and category counts with an independent reference.
Native tests exercise the actual saved indexes, and browser tests verify offline matching without a ranking download.
The national parity queries include kana, combined place and category input, short input, and a misspelling.
The build gate retains the existing worker budget.
