# Interface design and verification

The design source is [Public Phonebook in Figma](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook).
Work updates the existing Web Desktop, Web Mobile, and iPhone app pages.
Shared components define typography, controls, contact cards, category icons, and source rows.

| Screen | Desktop frame | Mobile frame |
| --- | --- | --- |
| Initial search | 197:145 | 198:145 |
| Compact initial search | — | 233:1676 |
| Results | 142:2 | 141:2 |
| Contact | 144:2 | 143:2 |
| Source | 146:2 | 145:2 |
| No results | 148:2 | 147:2 |
| Data information | 152:2 | 151:2 |
| Invalid search | 228:1670 | 150:2 |
| Missing page | 228:1698 | 228:1781 |
| Unavailable page | 228:1726 | 228:1809 |

## Figma file organization

The four original pages retain their original identities, and the file also holds the iPhone app page and the Brand & icons page.
Native sections separate current screens, reusable masters, foundations, future concepts, and archived studies.
Of the 91 artifacts that were directly on the original page canvases, 89 remain present with their original IDs and node types.
Later work removed the API explorer frames `202:1073` and `203:594`.

| Purpose | Section |
| --- | --- |
| Desktop screens | [Current web](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=257-1902) |
| Mobile screens | [Current mobile web](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=258-849) |
| Typography, states, and category icons | [Foundations](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=257-1903) |
| Shared component masters | [Reusable masters](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=257-1904) |
| Future native concepts | [Concepts](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=258-851) |
| Earlier design notes | [Archive](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=258-852) |
| iPhone app screens | [Current iPhone app](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=468-1283) |
| iPhone app component masters | [iPhone app components](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=468-1284) |
| iPhone QA build screens | [QA screens](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=563-2290) |
| Brand marks, app icons, and the icon library | [Brand & icons](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=316-1010) |

Current desktop viewports are 1440 by 900 pixels.
Current mobile viewports are 390 by 844 pixels, with a 320 by 900 compact example.
Current iPhone app viewports are 393 by 852 points.
Long data and result content remains inside vertically scrolling viewports.
The 27 current web screens use symmetric content gutters.
The 13 current iPhone screens and the two QA build screens span the full width, and their content frames set the side margins.
The QA section holds the verification screen and its search result from the VerificationDebug and VerificationRelease builds.
The two external-link confirmation screens center the dialog component on an opaque white page.
Archived notes and earlier state studies preserve historical decisions and do not govern the current interface.

The retained [layout audit](figma-layout.json) captures native bounds, intrinsic text measurements, text colors, and instance-reference counts.
The audit checks all six pages, including archived and future content.
It measures an untruncated copy of each text node at its original width, then removes that temporary copy.
It checks clipping, auto-layout sibling overlap, monochrome paints, opacity, effects, and text against the nearest opaque ancestor fill.
Intentional vertical viewport overflow and absolute focus indicators are excluded from unintended clipping and sibling-overlap findings.
Sibling-overlap findings also skip absolute overlays, such as the iPhone map confirmation alert.
The retained capture contains 1,429 text measurements and 1,199 resolved instance references.
Unit checks independently recompute canvas overlap and section containment, validate text fit and contrasting colors, and enforce canonical web and iPhone viewport sizes and gutters.
The same overlap check detects all ten overlapping pairs in the original desktop arrangement.
These checks cover the retained capture and cannot detect later Figma edits until the audit is refreshed.
After a Figma edit, capture the changed subtrees' text measurements and placements in the audit's tuple form and run `node tools/figma-audit.ts merge CAPTURE_JSON`.
The merge replaces every text inside a recaptured instance, so removed or swapped layers leave no stale measurements.
A capture with `scope` set to `page` replaces the whole page entry, so deleted frames leave no stale placements.
Layer occlusion and visual clarity still require direct visual review.

## Visual rules

Use authored black and white only.
Exclude gray steps, gradients, shadows, translucent styling, filters, blending, and slogans.
Use size, weight, grouping, spacing, and solid borders to communicate structure.
The initial heading is the service name.
The service name and the project information link below it start at the page's top padding and the content's start edge, 16 pixels apart.
The search field row sits at the vertical center of the viewport, with its label directly above it.
A viewport too short for that arrangement keeps the same order and derived spacing from the top and scrolls instead.
Data information and the complete files are reached through the project information link.
No footer contains required information.
Buttons have visible labels, explicit focus indicators, and generous targets.
The search action is a standard outline action 8 pixels from the field.
It sits beside the field, centered on it, on wide screens and below the field at its label's width on narrow screens.
Search actions have a minimum width and grow to fit their labels.
The search field has one visible label above it, with no hint, placeholder, or decorative glyph.

The website uses typed Vanilla Extract styles and the generic sans-serif family, so text follows the reader's operating system and browser font settings without a font download.
The [Digital Agency design system](https://design.digital.go.jp/dads/foundations/typography/) states that its Noto Sans JP choice doesn't restrict system fonts and that information must not depend on the font.
Figma uses Noto Sans JP as the stand-in for the Android system font, because Figma can't render each reader's font.
The website and the iPhone app draw category and action icons from the same [Figma masters](icons.md).
Every category has its own master with different icon geometry.
The website offers only categories present in the active publication.
Every size derives from the parameters in `src/ui/foundations.ts`.
The parameters are a 4-pixel grid, a 16-pixel body size, and a line-height ratio of 1.5.
The [Digital Agency design system](https://design.digital.go.jp/dads/foundations/typography/) describes 150% as the line spacing of body text and headings on general websites and as the minimum for body text.
Type sizes step from the body size by one grid unit: 16, 20, 24, 28, and 32 pixels, plus a 14-pixel small size.
Each line height is the size times 1.5, rounded up to the grid.
The ratio exceeds the 1.448-em ascent and descent of Noto Sans JP and the 1-em ascent and descent of Hiragino Sans, so Firefox reports no text overflow at normal or doubled text sizes.
Spacing steps are fractions and multiples of the 24-pixel body line: 4, 8, 12, 16, 24, 32, 48, and 64 pixels.
A control's height is its text line plus twice its inline padding, which gives 48-pixel actions and a 56-pixel search field.
The content width is 60 body characters, and results use two columns from a width of 50 body characters.
Category icons use the body size; action icons use the action size plus one grid unit.
The service name uses 28/44 on wide screens and 24/36 on narrow screens.
Telephone numbers use 24/36 typography in results and 32/48 typography in details.
Facility names use 20/32 in results and 24/36 as detail-page headings.
Page, section, and row headings use 24/36, 20/32, and 16/24 respectively.
Search and filter labels share the 16/24 row-heading style.
Body text, metadata, and labelled actions use 16/24, 14/24, and 14/24.
Text uses rem units so browser text preferences can increase its size.
Controls keep at least a 44-pixel target height at the default text size.

The existing desktop page contains the [foundation and state specimen](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=244-1790).
The existing collection contains semantic variables, primitive aliases, explicit scopes, and matching CSS names.
The retained [Figma export](design-system.json) identifies the exact role styles and variable IDs.
The TypeScript source in `src/ui/foundations.ts` supplies the same role values to the Vanilla Extract theme.
Unit checks reject divergence from the retained export.
Unit checks also recompute every size from the parameters and reject hand-typed pixel or rem lengths in the style sheets.
Browser checks require every exported CSS variable, bound heading sizes, compact result hierarchy, and text-resize behavior.
They also apply the WCAG 1.4.12 text-spacing override at 320 and 1440 pixels and require unclipped text without horizontal page scrolling.
These checks compare the retained export, not a live Figma file or subjective visual quality.

## Interaction and copy

Use short, concrete Japanese labels.
The search label names facility names and telephone numbers.
The search has no region or category filter, like the iPhone app.
Japanese composition completes before an automatic search begins.
Input that contains hiragana, katakana, or kanji searches 120 milliseconds after composition ends or the text changes.
Input made only of telephone characters searches automatically once it forms a complete Japanese telephone number.
Other input, such as Latin letters, searches at a typed space, pasted or dropped text, or a chosen keyboard suggestion.
It also searches when the field loses focus or after a pause.
The pause is three times the median interval between the reader's keystrokes since the field gained focus, and it needs at least two intervals.
Enter and the search button always search, and clearing the field restores the initial screen after the same short delay.
A pure policy decides the trigger, so typing doesn't send one request per keystroke.
These triggers apply until the search index is ready and whenever the page searches on the server.
After the first render, the page loads the search index in a Web Worker, unless the browser asks to save data.
A thin black bar along the bottom of the search field shows the loading progress, and assistive technology doesn't announce it.
Once the index is ready, each input searches in the Worker without a request, except during composition.
The page then replaces server results in place, so the visible rows and focus stay.
Without JavaScript, before the index is ready, and when the index fails its checks, the server searches.
Early native-form input survives JavaScript enhancement.
Clearing the search term restores the initial screen without a separate home action.
The search input stays mounted and focused across initial and result layouts.
Layout changes do not use motion animation.
No visible line repeats the result total.
A visually hidden status announces the total about 0.6 seconds after typing stops.
A visitor downloads the search index, not the national database, and it stays only in the browser's HTTP cache.

Results prioritize exact names and show large telephone numbers with call actions.
Every contact appears under its fixed facility-category heading with one category icon and the category's exact count.
The count follows the category label 8 pixels after it, on the label's baseline.
The category that holds an exact name comes first, and the exact name leads that category.
Each category initially previews up to three contacts rather than filling the screen with one large category.
The category order follows its best contact's exact-name, prefix, substring, normalized-name, and stable-ID order.
There is no grouping selector.
The existing desktop and mobile result screens demonstrate the `高知大学` search.
Grouped contacts inherit the shared heading's category and use third-level facility headings.
The telephone value is plain selectable text, and no control copies it.
Primary call actions fill the telephone column.
The value never carries a telephone URI or initiates calling.
Calling uses a separate primary action labelled with its purpose.
Facility names are heading text, and the prefecture and municipality follow the facility name as text.
Below the telephone actions, one outline link opens the details, with a chevron before a label that names what the details add.
The label is `住所などを見る` when the detail page shows an address and `くわしい情報を見る` when it doesn't.
Its accessible name starts with the facility name and keeps the visible label, such as `高知大学の住所などを見る`.
On wide screens, the detail link sits in the left column below the region.
Result cards leave the address and its map action to the detail page.
A result that the device found opens its details through its index row, and a changed snapshot reloads the index and searches again.
The search index carries no addresses, so a result that the device found uses the address label.
Navigation links have a visible underline or outline, an icon, and a target of at least 44 pixels.
This follows the distinction between [native links](https://www.w3.org/WAI/ARIA/apg/patterns/link/) and [action buttons](https://www.w3.org/WAI/ARIA/apg/patterns/button/).
No page renders a copy control or copy feedback.
Desktop results use two columns and three rows: the name beside the number, the region beside the call action, and the detail link below the region.
Narrow screens keep one column in the source order: the name, the region, the number, the call action, and the detail link.
That source order also sets the keyboard and screen reader order, so the call action comes before the detail link at every width.
The detail card shows the category, the name, and each number, then a full-width solid call action and an outline save action.
Detailed contacts expose contact saving once even when several telephone numbers are listed.
A row heading for the address follows, with the address as plain selectable text and no link, underline, or icon.
An outline map action with the map pin sits below the address and searches Google Maps for the facility name and address.
Its accessible name starts with the facility name, contains the visible label verbatim, such as `国立国会図書館を地図で見る`, and ends with the new-tab notice.
A contact without an address shows neither the address heading nor the map action.
The facility homepage action closes the card, and the source section follows the card.
On wide screens, the detail actions share the 360-pixel telephone column.
The map action draws the map pin in place of the external-navigation icon, announces the new tab, and uses `noopener noreferrer`.
Publisher sites, source files, and reuse terms follow the same external-web-link convention before and after enhancement, with the external-navigation icon at the start of each action.
A plain activation of a link to another site first opens a modal dialog that follows the [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
The dialog names what the link opens, the destination host, and the new tab, and focus starts on its open action.
Opening, cancelling, and Escape return focus to the link, and the dialog stores no choice.
The open action opens the destination in a new tab without an opener or referrer.
Activations with a modifier key or the middle button go straight to the browser, and links without JavaScript open their new tab directly.
Links without a declared destination use a general description.
The dialog's backdrop is opaque white, so it adds no tint or translucent surface.
Relative service navigation and telephone actions retain their native destinations.
Known terminal map annotations are removed without stripping building descriptions.
Source details provide readable context before opening the publisher's original file.
Bulk export belongs in the complete files on the data page rather than the search interface.
A category's labelled continuation expands only that category in the same result screen.
Automatic continuation begins after that expansion or after opening a category continuation link.
An explicit continuation moves focus to the facility heading of the first new card, which takes focus only from script, so screen readers announce the facility first.
Continuation preserves existing results on failure, prevents mixed snapshots and duplicate pages, and exposes recovery.
A real continuation link works without JavaScript, and its `category` and `cursor` parameters carry that state.
Old search URLs with `prefecture` or `municipality` redirect to the same search without them.

## Checks

The build checks in `just check-build` use the built Worker and an isolated fixture database.
It checks narrow and desktop layouts, semantic headings, horizontal overflow, touch targets, palette rules, and axe rules.
The palette scanner inspects CSS declarations, computed styles, active pseudo-elements, and the backdrop of an open modal dialog.
Prohibited fixtures verify that the scanner rejects color, gray, gradients, opacity, shadows, filters, blending, and the browser's default translucent backdrop.
The national browser suite checks Chromium, Firefox, WebKit, and a mobile WebKit profile.
Live contact checks cover the reported dental result, long Japanese names, and multiple telephone numbers.
They run at 320, 390, 800, 960, and 1440 pixels and include doubled text and keyboard focus.
They require plain telephone text and no button in a result card, and a planted copy button must fail that rule.
Map tests on the detail page check the plain address text and the map action's name.
They confirm the dialog and then verify an actual new tab, its query, its absent opener, and the preserved page.
External-link checks open the dialog from every link type and check its description, host, initial and returned focus, Escape, cancellation, opener isolation, and design rules.
They also require modifier-key and middle-button activations to bypass the dialog and links without JavaScript to open directly.
The detector checks alignment, repeated framed actions, duplicate destinations, link affordances, native control roles, labels, target overlap, clipping, and accidental call links on telephone values.
It also requires a plain-text facility heading and one labelled detail link on the region's left edge below it.
On wide screens, that link sits left of the call action, and a 1440-pixel check places the call action in the right column.
Planted displaced actions, a displaced detail link, and extra framed actions must produce their specific violations.
These constraints enforce this product's layout and interaction decisions rather than score arbitrary visual quality.
Screenshots and failure traces remain local review artifacts.
WebKit visual evidence uses native video to preserve the page's enforced CSP.
Neither a palette scan nor axe establishes that every phrase is meaningful or that all assistive technology behaves correctly.
Visual review remains necessary.
