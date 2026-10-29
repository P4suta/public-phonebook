# Interface source and constraints

The design source is [Public Phonebook in Figma](https://www.figma.com/design/86k2lR3poqbl2lU6bqQG8V/Public-Phonebook).
The mobile frames define the visual reference.
The desktop page in that file has no frames, so wide layouts reuse the same components and typography.

| Screen | Figma node |
| --- | --- |
| Search and results | 141:2 |
| Contact | 143:2 |
| Source details | 145:2 |
| No results | 147:2 |
| Additional results failed | 149:2 |
| Invalid search | 150:2 |
| Data and sources | 151:2 |

Use solid black and white.
Use font size, weight, spacing, rules, underlines, and literal labels to communicate structure.
Exclude gray styling, gradients, shadows, transparency, blending, and decorative slogans.
The service name remains the primary heading.

The downloaded Figma SVG files are stored unchanged in `static/icons/`.
Search, save, navigation, external link, information, file, retry, alert, and download icons retain their source dimensions.
Search, save, next, back, external, file, alert, retry, and download use 22 by 22 pixels.
Location, filters, library, museum, archive, phone, and information use 16 by 16 pixels.
Browser checks compare declared and visible dimensions with each SVG's natural dimensions.
Cloudflare tests compare delivered asset bytes with the local files.

Noto Sans JP is self-hosted in `static/fonts/`.
The upstream source is Google Fonts commit `66a36c8c94b1a5d992ee4e7f392fccfe4945767c`, path `ofl/notosansjp/NotoSansJP[wght].ttf`.
The WOFF2 file is a format conversion using `fonttools[woff]==4.61.1`.
The upstream license is retained as `static/fonts/OFL.txt`.
No font service is contacted by the page.

## Data and interaction requirements

The global data-and-sources navigation lives in the header.
The footer and search-result note contain no duplicate link.
The data page links to a monochrome API reference with an interactive request form, URL selection, plain-text examples, response headers, and a bounded response panel.
The API reference extends the interface conventions; it is not a supplied Figma frame.

Counts and category lists come from the installed snapshot.
They do not reuse the older sample counts in Figma.
Source dates are labelled as document dates because a source date need not be a publication date.
The interface does not claim that an untested physical device can import the complete directory.

Result rows link to a contact page.
Contact pages explain and link to the source before an original publication file is opened.
Back links preserve search conditions and the selected results page.
JavaScript is optional for search, pagination, contact pages, and downloads.
Additional loading validates page order, record identities, counts, and snapshot identity before modifying the list.
Failed loading retains existing records and exposes recovery.
Automatic loading observes the last record rather than a moving action button.
Search-result exports stay above the growing list.

Palette checks inspect authored and computed styles.
Axe checks the supported screen states.
Neither check proves that arbitrary copy is meaningful or that the design matches every pixel of the Figma file.
Visual review and recorded mobile and desktop screenshots remain part of the review.
