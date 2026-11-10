---
date: 2026-11-10
---

# Delegate runtime selection to CoreSimulator

## Status

Proposed.
[Issue #406](https://github.com/P4suta/public-phonebook/issues/406) defines the implementation scope.

## Context

The hosted Xcode image reports a completed runtime download but rejects the pinned iOS runtime when creating a device.
Independent runtime constants can diverge from installed platforms.
`xcrun simctl help create` specifies that omitting the runtime selects the newest runtime compatible with the requested device type.

## Decision

Let CoreSimulator select the runtime when creating each checkout-owned test device.
Recreate owned devices before verification and record the runtime identifiers returned by CoreSimulator.
Preserve device-type selection, fixture isolation, paired Watch transport, and all test requirements.
Use [Xcode's platform download command](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components) to prepare its supported runtimes.

## Alternatives

Historical runtime pins preserve a fixed OS matrix but require matching installation and availability checks across hosts.
Choosing versions in project code duplicates CoreSimulator's compatibility decision.

## Consequences

Installed runtimes can differ between hosts.
Native results identify the environment actually exercised.
Reconsider explicit runtime pins when a release requires a fixed OS matrix.

## Confirmation

Exercise runtime records with missing and ambiguous devices, then run the phone, Duo, iPad, and paired Watch checks.
Keep the decision proposed until the hosted release checks pass.
