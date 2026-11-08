# Android implementation refinement

## Mutation evidence admission

`tools/android-check/src/mutation.rs` implements `behavioral_kill` and `complete_campaign` as expression-only Boolean decisions.
The refinement gate matches both complete Rust declarations before accepting a proof receipt.
`behavioralKill` has the same four Boolean arguments and conjunction as `behavioral_kill`.
`killedMutantsRequireCompletedBehavior` proves that a successful verdict requires compiled, completed, failing behavior with no stop condition.
The parser must establish those premises from the fresh JUnit report and actual process result.
The theorem doesn't establish the premises itself.

The refinement interprets Rust `usize` values as Lean natural numbers without arithmetic operations or narrowing conversions.
`completeCampaign` and `complete_campaign` both require a positive expected count, equality of expected and executed counts, and all results killed.
`mutationCampaignRequiresEveryExpectedResult` proves the complete conjunction.
The runner additionally checks the declared identities, unchanged source hashes, a green baseline, and complete policy-class coverage.
Compiler and JUnit correctness, XML interpretation, and fault-inventory adequacy remain external assumptions tested by rejecting empty, skipped, timed-out, and infrastructure-error fixtures.

The `DeviceDirectory` clock and connection factory are constructor capabilities with production defaults.
The clock still supplies the same nonnegative epoch-seconds value to `SyncPolicy.due` in production.
Host tests replace the capabilities to control the deadline and HTTP responses without changing the fixed-origin transport contract.
`DirectoryDelta.rebuild` retains Brotli decoding and delegates the decoded byte stream to `rebuildDecoded`.
Both entry points use the same row and decoded-identity admission logic.
Tests compare their valid fixture outputs byte for byte.
`PhonebookScreeningService` accepts a repository capability and defaults to the app's directory.
Host tests provide a controlled repository to exercise lookup failure and cancellation with the same coroutine scheduler as the service.
SQLite and synchronization tests exercise the actual directory implementation.

`canAppendPage` and `PagePolicy.canAppend` admit a continuation only when the request asks for more rows and the completed results belong to the same query.
The adapter stores `resultQuery` with the completed preview and compares it with the requested query.
An expanded category supplies the continuation flag, so its first expansion starts at zero and later pages append.
`pageAppendRequiresTheSameQuery` proves the two Boolean requirements.
The refinement gate checks the actual comparison, offset, generation check, and completed-page assignment.
The adapter regression test changes the query and requests more rows before the first preview arrives.

Category previews stream ordered SQLite identifiers and counts while retaining at most three identifiers per category.
The payload query reads only those selected contacts.
Native SQLite tests compare every group, count, and preview with the complete scan oracle, including complete telephone numbers and a category beyond the former global page.
The validated limit of 256 categories bounds the payload query to 768 identifiers.
SQLite sorting, cursors, and cancellation are external runtime boundaries.
The existing word-rank model supplies the matching tiers.
Native ordering fixtures cover compatibility-normalized names and kana folding.

Saved databases gain their separate sort key through an exclusive transaction under the store's write lock.
The schema version changes within the same transaction.
A planted update failure checks rollback, retry, unchanged archive bytes, and caller lookup through the actual database implementation.
The [sort-key decision](../../docs/adr/keep-android-search-order-separate-from-comparison-folding.md) records the storage boundary.

The Lean model proves deterministic policy statements.
The Rust runner compares thirteen complete Kotlin expression functions with their reviewed translations and checks modeled constants.
The proof receipt hashes the versioned Android implementation, tests, tool, build configuration, and proof inputs.
The store icon and feature graphic use a separate deterministic rendering check.
Keep screenshot package identities with the device receipts, outside the formal model.
The comparison extracts each expression declaration through the following member or object boundary, including wrapped parameter lists.
An appended expression, even without continuation indentation, can't pass as the reviewed function.
Modeled policy files exclude block comments and multiline literals so neither can imitate a declaration.
Compiler warnings as errors and semantic analysis check the production declarations.
The runner rejects stale receipts and requires every named theorem, fresh kernel replay, and the intended rejection of a planted false admission rule.
The translation review remains a human semantic obligation rather than a proof of the Kotlin compiler.

`SyncPolicy.admit` corresponds to `admit` with five independent Boolean facts.
All five checks must hold.
The data adapter supplies the facts only after compressed length and SHA-256 checks, snapshot and row validation, index construction, SQLite integrity checking, and file synchronization.
`GenerationWriter` and `PublicationTest` exercise that boundary with valid, malformed, interrupted, and concurrent imports.

`SyncPolicy.transfer` corresponds directly to Boolean negation and conjunction in `transfer`.
`SyncPolicy.due` corresponds to `due` over an optional signed 64-bit timestamp.
Kotlin short-circuit evaluation establishes nonnegative ordered operands before subtraction.
The subtraction theorem establishes the mathematical result within signed 64-bit bounds.
The runner requires the production constant to equal the model's 86,400-second interval.
Android supplies the network restrictions and response clock, while WorkManager supplies eventual scheduling rather than an exact execution time.

`TransferPolicy.chunk` and `TransferPolicy.copy` correspond to `chunk` and `copy` over signed 64-bit integers.
Their guards establish nonnegative ordered operands before subtraction.
The theorems bound accepted byte totals and copied row indices, and establish that the additions and subtractions fit signed 64-bit integers when the declared total does.
The adapters cap compressed bytes at 256 MiB, decoded bytes at 2 GiB, and rows at 5,000,000.
`TransportTest` exercises interruption, resume responses, full-response restart, redirect rejection, invalid UTF-8, and digest failure through the actual HTTP adapter.
`PublicationTest` rebuilds the shared delta and compares the resulting directory with its expected archive.

`JsonPolicy.validDepth` corresponds to `validJsonDepth` over a signed 32-bit depth.
Validation starts at zero, checks the guard before every descent, and increments by one.
Accepted depths are nonnegative and below 32.
The descent theorem bounds the next value by 32 and proves that the increment fits signed 32-bit integers.
Android's strict JsonReader supplies lexical and structural parsing.
The adapter independently rejects duplicate names and trailing tokens before JSONObject construction.
`JsonDocumentTest` exercises those parser boundaries and excessive nesting.

`WordPolicy.rank` corresponds to `wordRank` over nonnegative word counts.
The query parser admits at most eight words.
Name and place counts each stay within the admitted word count, and the place count excludes words already matched by the name.
The arithmetic theorem establishes that the count sum fits signed 32-bit integers.
The branch order rejects missing words and ranks place matches after complete name matches.
A single word preserves its name rank, while a query containing two or more words uses the shared name-match rank.
The shared SearchContract fixtures check normalization, candidate completeness, and result order on the host and both Android runtime targets.
Unicode normalization, SQLite execution, and full-text tokenization remain runtime contracts rather than Lean semantics.
`PlaceReadings` validates the shared kana resource and compares folded prefixes of at least two characters.
The same `PlaceReadingContract.json` cases run through Kotlin, Swift, and TypeScript implementations.
Reading words bypass Android's saved full-text prefilter because older token indexes contain only literal names and places.
The final word predicate combines literal matches with bound category membership and the prefecture prefix from each validated archive row.
Native SQL regressions require complete category counts, literal-name precedence, combined reading words, short-input exclusion, and unchanged archive and telephone lookup.
Reading resource admission, Unicode comparison, and SQL predicate execution remain tested runtime boundaries.
The [reading decision](../../docs/adr/match-verified-place-readings-without-a-ranking-companion.md) leaves the existing word-rank theorem unchanged.

`PagePolicy.restart` corresponds to `restartPage` over a continuation flag and two optional snapshot identities.
The theorem establishes that a continuation restarts exactly when its received snapshot differs from the displayed snapshot.
The ViewModel requests a complete preview after a restart and appends category rows only within an unchanged generation.
Independent category jobs update their own category in the current state.
A query-run identity rejects late replies after cancellation, and the screen hides results belonging to another query.
`DirectoryViewModelTest` controls coroutine scheduling under the [Android coroutine testing guidance](https://developer.android.com/kotlin/coroutines/test) and reproduces a generation change between two page requests.
The regression requires the replacement generation's preview and prevents an update from skipping its first results.
Controlled jobs also cover category failures, retries, duplicate requests, reversed completion order, and late replies from an earlier query.
Composition starts a fresh query-run identity and cancels earlier work without starting a repository query.
The adapter observes text and composition together, so an unchanged-text commit still starts a search.
Preparation awaits its result before copying the current state, which preserves text edited while import was running.
Controlled scheduling tests cover preparation, refresh, commit, and late preview replies during composition.
The device UI test exercises the real input connection's composing and finishing operations.
Input methods and Compose observation remain platform boundaries.

`PublicationPolicy.canActivate` corresponds to `canActivate` and permits a write only from an indexed, admitted candidate.
`PublicationPolicy.select` corresponds to `select` over optional active generations, four stages, validation, and the observed pointer.
An uncertain write can have committed before an interruption.
The model permits the candidate only after observing its pointer or reaching the confirmed complete state.
An unconfirmed uncertain write preserves the active selection.
The trace theorem covers every finite sequence without a validated confirmed publication.
The runner checks that the adapter passes its actual stage, admission result, and pointer comparison into those functions.
Passing a constant complete stage would fail the refinement boundary.
`PublicationPolicy.canDiscard` corresponds to `canDiscard` and prevents cleanup of uncertain and complete candidates.
`StagedGeneration` enters uncertainty before filesystem activation and marks completion only after observing the new pointer.
`SQLiteDirectory` serializes imports, excludes writers while a reader holds its generation, and stores current and previous names in one AtomicFile record.
The adapter uses unique generation names and preserves both referenced directories during cleanup.
Fault injection checks a pointer error before commit, a pointer error after commit, and failed post-commit cleanup.
Those tests also reopen the store and retry cleanup.
The proof assumes the documented AtomicFile and SQLite contracts and doesn't prove power-loss durability on a particular filesystem.

`CallerPolicy.display` corresponds to `display` over signed 64-bit monotonic timestamps and Boolean match and role states.
Short-circuit guards establish ordered nonnegative clocks before subtraction.
The clock theorem bounds the subtraction, and the display theorem requires a held role, a match, and an elapsed time below 1,000 milliseconds.
The runner checks the production budget and the service prefix that schedules permission before lookup.
The permission-response model represents the AtomicBoolean compare-and-set as one indivisible transition.
Its theorems establish one response from a reachable initial state and idempotence under repeated response attempts.
The service's finally block and independent handler deadline use the same guarded response.
The response-field theorem corresponds to the five false response flags checked in the service.
The Android scheduler, process survival, framework response delivery, and caller activity visibility remain external assumptions requiring device evidence.
Physical call continuation and lock-screen identification remain unverified until the deferred handset tests run.
