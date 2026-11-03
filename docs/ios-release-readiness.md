# Native release readiness

This record tracks what remains between the native change and App Store review.
It separates completed checks from open work and names who must act.
Update it when an item closes, and remove it once version 1.0 is public.

## Dependencies

The app requires the `/api/datasets` listing with the `public-phonebook-directory/1` archive and the public `/privacy` and `/support` pages that #20 delivered.
The native UI harness starts `tools/native-fixture.ts`, which serves the actual Hono handlers over loopback.
The TypeScript unit tests regenerate the provider corpus that the Swift tests decode and reject a stale copy.
The web outputs of the shared Figma icons belong to #21.

## Completed checks

The checks below ran on 2026-10-31 on `main` at `bdbda53` with the uncommitted native sources in this change.
Their receipts bind to that tree, so they rerun at the committed revision.

- `ios-check` formatting, Clippy with denied warnings, and its unit tests passed.
- `icons --check` passed.
- The provider corpus test in `tests/unit/native-contract.test.ts` matched the corpus, including the discovery document, the dataset listing, and the archive, to the merged producer.
- `ios-generate` checked all six build configurations and rejected 216 environment defects.
- The Swift package tests passed, including the website normalization and ranking, a classifier and phone table taken from the website implementation, the archive reader, the dataset download checks, and the national import.
- The merged producer writes form-encoded links, where `+` represents a space.
  The client rejected those links for every query that contained a space and kept the previous results.
  The client now decodes server links with form semantics, and a required unit test rejects a changed query and a literal plus.
- A search typed during automatic searching moved the search field to another view and dropped the rest of the typed text.
  The field now keeps one position in the view tree.
- `ios-check` passed the Swift package tests, the unsigned Release device build, and all 18 isolated simulator UI scenarios against the merged producer.

Earlier runs passed the campaigns below on a working tree that also held a draft producer and web icon files.
Their receipts don't bind to this tree, so these campaigns rerun at the committed revision.

- `ios-prove` checked 11 Lean theorems, replayed them with a fresh kernel, and rejected the false claim.
- `ios-sanitize` ran the package tests under Address Sanitizer and Thread Sanitizer.
- `ios-mutate` killed all 63 executable mutants, and the compiler rejected the other two.
- `ios-screenshots` captured three opaque 1206 x 2622 Japanese images from the production configuration.
  A loopback preview served the public snapshot `ffef99d9` for that capture.
- `ios-archive` exported a signed App Store package and verified its production identities, signatures, extensions, notices, and privacy manifests.
  The dirty tree makes that package ineligible for release.

Earlier device evidence and its limits are in the [device verification record](ios-device-verification.md).
The App Store Connect record, environments, archive procedure, and TestFlight workflow are in the [store preparation guide](ios-store-distribution.md).
The workflow and its delivery path haven't run yet, because they need the owner's key, certificate, profiles, and OIDC identity.

## Open work

| Item | Owner | Waiting for |
| --- | --- | --- |
| Produce snapshot deltas in the hosted release, which the app applies since #95 | Developer | `release.yml` fetching the retained bundles before preparation |
| Measure the national import time, memory, and storage, and the Call Directory load on a device | Developer and owner | A device run |
| Create the App Manager key, the distribution certificate, both App Store profiles, the Doppler values, and the OIDC identity | Owner | The [owner setup](ios-store-distribution.md#owner-setup) |
| Run the `TestFlight` workflow on `main`, which reruns `ios-check`, `ios-prove`, `ios-sanitize`, and `ios-mutate` for that commit | Owner | The owner setup |
| Verify `/api/datasets`, `/privacy`, and `/support` over production HTTPS without authentication again before submission | Developer | Submission |
| Capture store screenshots with `just ios-screenshots ORIGIN` from the committed revision | Developer | Owner approval of the commit |
| Confirm whether App Store Connect also needs a large-display screenshot set | Owner | App Store Connect |
| Approve the workflow's delivery job, which signs, uploads, and waits for TestFlight processing | Owner | A passing workflow run |
| Add the processed build to TestFlight testing groups | Owner | A `VALID` build |
| Complete the privacy label, age rating, availability, accessibility, export compliance, review contact, and trader declaration | Owner | Verified service behavior |
| Submit a processed build for review and release it | Owner | Explicit authorization |

The [national import decision](adr/import-the-national-dataset-for-ios-extensions.md) explains why the app downloads one national file instead of paging contacts.
The search screen treats a 429 response like a 503 response and waits for `Retry-After` before it searches again.

The screenshot command records the size, configuration, origin, source revision, and digest of each image.
Apple lists 1206 x 2622 pixels under the required iPhone class with the medium Dynamic Island display.
Its large-display rule could also require a 1284 x 2778 or 1242 x 2688 set, so App Store Connect decides that item.
Apple prohibits alpha channels in screenshots, and the command writes opaque RGB images.

## Unverified device behavior

- No controlled incoming call has shown caller identification, because that test needs a second originating line.
- No run has used an iOS 18 runtime, which is the deployment target.
- Natural background delivery remains inconclusive after the observed 281-second window.
- An earlier debugger trial stopped in CoreFoundation, and its cause remains unknown.
