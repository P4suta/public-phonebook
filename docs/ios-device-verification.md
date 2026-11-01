# Physical device verification

Use a development-signed QA bundle identifier and its own App Group.
Record the device model, OS build, Xcode version, source hashes, bundle identifier, compiled API origin, and result bundle privately.
Keep a personal device's serial number, address book, and device diagnostics private.

Enable Developer Mode and use an authorized Apple development team.
Use `xcrun devicectl list devices` to confirm the actual destination.
Build the app and its extension with the QA bundle identifier, App Group, and selected HTTPS origin.
A successful signature proves installation eligibility, not feature execution.

## Read-only search

Run only `PhonebookUITests/DirectoryUITests/testLivePublicDirectorySearchAndSource` on a personal phone.
This case searches the service, opens provenance, and checks its source date.
Never run the full simulator harness on the personal device.
Never call an unrelated public telephone number as an E2E fixture.

The maintained provider fixture can serve synthetic records through a temporary HTTPS tunnel.
Set PHONEBOOK_FIXTURE_PUBLIC_ORIGIN to that exact HTTPS origin before starting `tools/native-fixture.ts --serve`.
Compile the same origin into the QA app.
The baseline and updated PHONEBOOK_FIXTURE_REVISION values produce different snapshot identities.
Stop the tunnel and fixture after testing.

## Background execution

Let the QA app save the synthetic national dataset before testing.
Confirm that the saved manifest origin matches the compiled HTTPS origin.
Enable automatic updates.
For a due-update fixture, change only that QA App Group's manifest date and automatic-attempt preference.
Preserve a copy and the active generation identity.

Apple's debugger simulation methods can launch or expire a registered task on a development device.
Invoke them only from LLDB.
Keep private selectors outside product code.
Trigger the bundle's actual PhonebookBackgroundRefresh identifier with the app in the background.
The verification bundle uses page.dial.publicphonebook.devicechecks.refresh.
Observe the actual production handler, network requests, activation, completion result, and unchanged prior generation on failure.
To test task expiry, `PHONEBOOK_FIXTURE_INCOMPLETE=contacts` holds an incomplete response after real I/O begins.
Expire the task after that observation and verify cancellation and preserved data.

Record debugger-forced launch, expiry, and natural OS delivery as distinct checks.
For the latter, detach the debugger, leave a valid due request, and observe a stated window.
No delivery during that window is inconclusive.
The OS decides its scheduling conditions.

## Carrier identification and system compatibility

A real incoming-call test needs a controlled originating line and an approved test number represented in the saved QA data.
Check the enabled Call Directory extension and actual incoming system UI without enumerating personal contacts.
A receiver alone can't originate that controlled call.
A successful extension reload doesn't establish carrier caller identification.

Run iOS 18 on a compatible device or simulator runtime and record its actual OS build.
The connected iPhone Air runs its installed newer OS and can't substitute for an iOS 18 runtime.
Keep runtime-download failures and unavailable local runtimes as environmental observations, not universal claims about iOS testing.

## Recorded run on 2026-10-30

The local candidate passed 66 Swift package tests and 23 isolated simulator UI scenarios.
Address Sanitizer and Thread Sanitizer each ran the complete package test inventory.
The mutation run detected 63 executable mutations and rejected two declaration renames at compilation.
The source-bound Lean gate checked 11 theorems, replayed their compiled modules with a fresh kernel, and rejected the false-deletion control.
The TypeScript gate passed 95 unit tests and 37 built-browser checks.
Its proof gate checked 14 verification units and 23 postconditions.
It also rejected deliberate snapshot identity and ambiguity defects.
The private receipts contain the exact source hashes and check configurations.

The physical destination was iPhone Air with iOS 27.2, build 24B119.
The signed QA bundle used the actual Hono provider with synthetic data over a temporary HTTPS tunnel.
The read-only search and provenance UI case passed on that device.
The controlled update selected prefecture 01 with 103 records across three cursor pages.
A debugger-triggered background callback changed the snapshot from d4397175 to 356c1d80, preserved the previous generation, and reported success.

The expiry test waited for a new incomplete HTTP response before invoking the scheduler's debugger expiry method.
The production background handler reported failure and kept the active manifest byte-for-byte unchanged.
After a fresh process and a repeated expiry trial, the production store read the saved records in pages of 50, 50, and 3.
The app continued running after that trial.

These controlled callbacks used a temporary UIKit background assertion during debugger interaction.
They establish behavior under that test condition.
They don't establish natural scheduler delivery or an independent processing budget.
An earlier trial stopped in CoreFoundation after ending the test assertion from a paused background main thread.
The record preserves that stop and its backtrace.
The repeated trial returned to the foreground before ending the assertion and continued without that stop during the observed run.
The first stop's cause remains unresolved.

Keep the model's automatic-update setting consistent with its persisted preference during debugger setup.
Changing only UserDefaults can leave the visible model's automatic updates off, causing a later foreground refresh to cancel the submitted request.
Wait for foreground refresh to settle before clearing the retry date and submitting a due request.
Keep debugger assertions and private scheduler calls outside product code.

A detached observation ran from 14:02:29 to 14:07:10 UTC, a 281-second window.
The app had a due request and automatic updates enabled, without debugger scheduling or a helper assertion during the window.
At 14:06:52 the service received successful discovery, catalog, and contact requests, and the saved generation changed.
The framework record didn't establish a natural task launch and the requests also matched ordinary foreground initialization.
Natural background delivery remains inconclusive.
The test turned off automatic updates through the app model and stopped the temporary service and tunnel after the observation.
