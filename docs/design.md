# Interface design and verification

The design source is [Public Phonebook in Figma](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook).
Work updates the existing Web Desktop and Web Mobile pages.
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
| API explorer | 202:1073 | 203:594 |
| Invalid search | 228:1670 | 150:2 |
| Missing page | 228:1698 | 228:1781 |
| Unavailable page | 228:1726 | 228:1809 |

## Figma file organization

The four existing pages retain their original identities.
Native sections separate current screens, reusable masters, foundations, future concepts, and archived studies.
All 91 artifacts that were directly on the original page canvases remain present with their original IDs and node types.

| Purpose | Section |
| --- | --- |
| Desktop screens | [Current web](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=257-1902) |
| Mobile screens | [Current mobile web](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=258-849) |
| Typography, states, and category icons | [Foundations](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=257-1903) |
| Shared component masters | [Reusable masters](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=257-1904) |
| Future native concepts | [Concepts](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=258-851) |
| Earlier design notes | [Archive](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook?node-id=258-852) |

Current desktop viewports are 1440 by 900 pixels.
Current mobile viewports are 390 by 844 pixels, with a 320 by 900 compact example.
Long data and result content remains inside vertically scrolling viewports.
The 23 current web screens use symmetric content gutters.
The two external-link confirmation screens center the dialog component on an opaque white page.
Archived notes and earlier state studies preserve historical decisions and do not govern the current interface.

The retained [layout audit](figma-layout.json) captures native bounds, intrinsic text measurements, text colors, and instance-reference counts.
The audit checks all four pages, including archived and future content.
It measures an untruncated copy of each text node at its original width, then removes that temporary copy.
It checks clipping, auto-layout sibling overlap, monochrome paints, opacity, effects, and text against the nearest opaque ancestor fill.
Intentional vertical viewport overflow and absolute focus indicators are excluded from unintended clipping and sibling-overlap findings.
The retained capture contains 1,018 text measurements and 754 resolved instance references.
Unit checks independently recompute canvas overlap and section containment, validate text fit and contrasting colors, and enforce canonical viewport sizes and gutters.
The same overlap check detects all ten overlapping pairs in the original desktop arrangement.
These checks cover the retained capture and cannot detect later Figma edits until the audit is refreshed.
After a Figma edit, capture the changed subtrees' text measurements and placements in the audit's tuple form and run `node tools/figma-audit.ts merge CAPTURE_JSON`.
The merge replaces every text inside a recaptured instance, so removed or swapped layers leave no stale measurements.
Layer occlusion and visual clarity still require direct visual review.

## Visual rules

Use authored black and white only.
Exclude gray steps, gradients, shadows, translucent styling, filters, blending, and slogans.
Use size, weight, grouping, spacing, and solid borders to communicate structure.
The initial heading is the service name.
The service name and the project information link below it start at the page's top padding and the content's start edge, 16 pixels apart.
The search field row sits at the vertical center of the viewport, with its label and hint directly above it and the filters below it.
A viewport too short for that arrangement keeps the same order and derived spacing from the top and scrolls instead.
Data and API information is reached through the project information link.
No footer contains required information.
Buttons have visible labels, explicit focus indicators, and generous targets.
The search action touches the search-field border on wide screens and sits below the field on narrow screens.
Search actions have a minimum width and grow to fit their labels.
The API reference uses the existing desktop and mobile frames with an editable operation-navigation and parameter layout.
Its desktop content uses 24-pixel gutters to accommodate the library's sidebar and documentation columns.
Scalar supplies its detailed runtime controls; the application theme enforces black-and-white output and minimum target sizes.
The search field has a visible label and a persistent hint above it, with no placeholder or decorative glyph.

The website uses typed Vanilla Extract styles and the generic sans-serif family, so text follows the reader's operating system and browser font settings without a font download.
The [Digital Agency design system](https://design.digital.go.jp/dads/foundations/typography/) states that its Noto Sans JP choice doesn't restrict system fonts and that information must not depend on the font.
Figma uses Noto Sans JP as the stand-in for the Android system font, because Figma can't render each reader's font.
Lucide supplies distinct category and action icons, with the owned tooth asset retained separately.
All 65 defined categories have different icon geometry.
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
The placeholder names facility names and telephone numbers.
The category field says what is being classified.
Municipalities appear after a prefecture is selected and reset when it changes.
Japanese composition completes before an automatic search begins.
Early native-form input survives JavaScript enhancement.
Clearing all search conditions restores the initial screen without a separate home action.
Clearing text preserves explicitly selected region and category filters.
The search input stays mounted and focused across initial and result layouts.
Layout changes do not use motion animation.
The browser caches completed queries; the national search and API remain server-side.
A visitor does not download the national database.

Results prioritize exact names and show large telephone numbers with call and copy controls.
Every contact appears under its fixed facility-category heading with one category icon and the category's exact count.
The category that holds an exact name comes first, and the exact name leads that category.
Each category initially previews up to three contacts rather than filling the screen with one large category.
The category order follows its best contact's exact-name, prefix, substring, normalized-name, and stable-ID order.
There is no grouping selector.
The existing desktop and mobile result screens demonstrate the `高知大学` search.
Grouped contacts inherit the shared heading's category and use third-level facility headings.
The telephone value is a native copy button with a small visible copy hint.
Result number controls and primary call actions fill the telephone column.
Number and hint clicks focus the same button before initiating copying synchronously in the trusted click.
The adapter uses the asynchronous clipboard when transient activation is available and a synchronous selection-copy compatibility path when it is absent.
Programmatic clicks cannot initiate either write path.
Only the latest copy request within a contact can publish completion feedback.
It never carries a telephone URI or initiates calling.
Calling uses a separate primary action labelled with its purpose.
Facility headings link to details, and address values link to maps.
Those navigation links have visible underlines, icons, and minimum 44-pixel targets.
This follows the distinction between [native links](https://www.w3.org/WAI/ARIA/apg/patterns/link/) and [action buttons](https://www.w3.org/WAI/ARIA/apg/patterns/button/).
No separate telephone-copy or address-copy control is rendered.
Copy feedback occupies a full-width row below the contact content.
Successful and denied copying preserve the desktop map and call target alignment.
Desktop results place identity and location beside telephone information.
Narrow screens preserve the reading order of identity, telephone information, and location.
Detailed contacts expose contact saving once even when several telephone numbers are listed.
Addresses lead to a map.
Map links open a separate tab, show an external-navigation icon right after the address text, announce that behavior, and use `noopener noreferrer`.
Publisher sites, source files, and reuse terms follow the same external-web-link convention before and after enhancement, with the external-navigation icon at the start of each action.
A plain activation of a link to another site first opens a modal dialog that follows the [modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
The dialog names what the link opens, the destination host, and the new tab, and focus starts on its open action.
Opening, cancelling, and Escape return focus to the link, and the dialog stores no choice.
The open action opens the destination in a new tab without an opener or referrer.
Activations with a modifier key or the middle button go straight to the browser, and links without JavaScript open their new tab directly.
Links inside the API reference use a general description.
The dialog's backdrop is opaque white, so it adds no tint or translucent surface.
Relative service navigation and telephone actions retain their native destinations.
Known terminal map annotations are removed without stripping building descriptions.
Source details provide readable context before opening the publisher's original file.
Bulk export belongs in the API rather than the search interface.
A category's labelled continuation expands only that category in the same result screen.
Automatic continuation begins after that expansion or an explicit category selection.
Continuation preserves existing results on failure, prevents mixed snapshots and duplicate pages, and exposes recovery.
A real continuation link works without JavaScript.

## Checks

The required fast gate uses the built Worker and an isolated fixture database.
It checks narrow and desktop layouts, semantic headings, horizontal overflow, touch targets, palette rules, and axe rules.
The palette scanner inspects CSS declarations, computed styles, active pseudo-elements, and the backdrop of an open modal dialog.
Prohibited fixtures verify that the scanner rejects color, gray, gradients, opacity, shadows, filters, blending, and the browser's default translucent backdrop.
The national browser suite checks Chromium, Firefox, WebKit, and a mobile WebKit profile.
Live contact checks cover the reported dental result, long Japanese names and addresses, missing addresses, and multiple telephone numbers.
They run at 320, 390, 800, 960, and 1440 pixels and include doubled text, keyboard focus, exact copied values, and clipboard denial.
Native clipboard tests separately click the number text and copy hint after automatic search.
They also consume native transient activation before the first trusted click reaches React and verify the synchronous selection copy event, focus restoration, and temporary-field cleanup.
Fault injection rejects an older pending copy after a later successful copy.
Map tests confirm the dialog and then verify an actual new tab, its query, its absent opener, and preserved search results.
External-link checks open the dialog from every link type and check its description, host, initial and returned focus, Escape, cancellation, opener isolation, and design rules.
They also require modifier-key and middle-button activations to bypass the dialog and links without JavaScript to open directly.
The detector checks alignment, repeated framed actions, duplicate destinations, link affordances, native control roles, labels, target overlap, clipping, and accidental call links on telephone values.
Planted displaced actions and redundant framed navigation must produce their specific violations.
These constraints enforce this product's layout and interaction decisions rather than score arbitrary visual quality.
Screenshots and failure traces remain local review artifacts.
WebKit visual evidence uses native video to preserve the page's enforced CSP.
Neither a palette scan nor axe establishes that every phrase is meaningful or that all assistive technology behaves correctly.
Visual review remains necessary.
