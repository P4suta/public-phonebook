# Native assurance boundaries

The project records verification receipts under `target/ios/`.
Receipts bind their verdict to source hashes and reject edits made during execution.
A passing source-bound receipt covers its named check and target.
Consult the actual receipt and logs for the current candidate's results.

| Production contract | Verification | Limit |
| --- | --- | --- |
| Snapshot admission | Exact TypeScript-to-Dafny translation, three postconditions, all 16 Boolean inputs, and deliberate identity and ambiguity defects | HTTP tests cover parsing and runtime behavior |
| Provider and consumer compatibility | Actual Hono/D1 response corpus compared in TypeScript and decoded by Swift | Synthetic data with separate production publication checks |
| National dataset import | The provider archive imported through the real synchronization path, digest, length, snapshot, Brotli truncation, row order, dictionary, region, and count checks, cancelled imports, and real SQLite activation | Device throughput and memory for about 650,000 records remain unmeasured |
| Delta updates | The provider's fixture delta rebuilt from the saved baseline and compared byte for byte, every rejection, the complete-archive fallback, and cancellation | Device time and temporary storage for a national rebuild remain unmeasured |
| Delta admission | Lean theorems for the verdict order and the copy range guard, bound to the exact Swift source, and all 13,896 finite cases checked natively | The digest check, not a proof, decides whether a rebuilt archive is right |
| Publication and cancellation | Shared 25-transition contract, production Swift refinement, Lean theorems for arbitrary finite traces, and independent fresh kernel replay | Foundation, SQLite, process crash, and power-loss durability remain external trust boundaries |
| Receive budget | Lean integer bounds and overflow theorems bound to the exact guarded Int64 expression | Integration tests cover callers and actual I/O |
| Required nullable wire fields | Missing-key regression tests for contact, source, page metadata, and continuation | Each provider deployment still needs compatibility checks |
| Request concurrency | Controlled transport ordering, cancellation, stale completion, and retry schedules | Finite schedules rather than exhaustive OS scheduling |
| Search experience | Local search ranks and normalization compared with the website rules, a classifier and phone table taken from the website implementation, per-category previews, and in-place continuation | Search time on a device remains unmeasured |
| Native memory and synchronization | Complete package test inventory under Address Sanitizer and Thread Sanitizer | Host Swift package execution excludes UIKit and extension execution |
| Assertion sensitivity | Pinned Swift mutation operators with an exact planned and executed inventory | The receipt distinguishes compiler rejection from test detection |
| User flows | Full named UI inventory on an isolated iOS 27 simulator, rotation, large text, permission, and retry paths | Real carrier calls and physical background delivery require separate device evidence |
| Shared icons | Figma node and digest inventory, SVG allowlist, exact derived assets, mask safe area, browser metadata, and sprite checks | Semantic clarity and brand recognition remain design judgments |
| Dependency and secret boundaries | npm audit, pinned RustSec advisory snapshot, gitleaks over a nonempty publishable inventory | RustSec snapshot excludes newer advisories and registry yank status |

Lean checks 21 named theorems and rejects a false active-deletion claim and a false digest-mismatch admission.
The TypeScript proof gate checks its full declared contract inventory and deliberate broken implementations.
Neither result proves the entire app.
The proof gate rejects unsupported proof escapes and stale source or generated-model receipts.

The fast project gate on every pull request includes strict TypeScript checks, behavioral tests, dependency checks, secret checks, and workflow checks.
A pull request that changes a Rust input also runs the `tools/ios-check` formatting, Clippy, test, icon consistency, and RustSec checks.
The release assurance set adds the build, Rust formatting, strict Clippy, Rust tests, icon consistency, built-browser checks, both proof commands, and the native checks.
The manual Assurance workflow runs that set on hosted runners, and its `campaigns` input adds the sanitizer and mutation checks.
The TestFlight workflow runs the native checks, the Lean proofs, and the sanitizer and mutation checks before every delivery.
No personal credentials or connected phone are prerequisites of these hosted checks.

Physical-device search, forced background callbacks, natural OS scheduling, and real incoming calls are distinct observations.
A debugger-triggered BGTask callback doesn't establish natural scheduler delivery.
A foreground/background round trip doesn't establish a background download.
The iOS 18 deployment setting doesn't establish iOS 18 runtime execution.
