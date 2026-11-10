---
date: 2026-11-10
---

# Delegate runtime selection to CoreSimulator

## Status

Proposed.
[Issue #406](https://github.com/P4suta/public-phonebook/issues/406) covers selection and [issue #411](https://github.com/P4suta/public-phonebook/issues/411) covers hosted setup.

## Context

Independent runtime constants can diverge from installed platforms.
`xcrun simctl help create` specifies that omitting the runtime selects the newest runtime compatible with the requested device type.
A platform download can exit 70 when Xcode finds nothing to download.

## Decision

Let CoreSimulator select the runtime when creating each checkout-owned test device.
Recreate owned devices before verification and record the runtime identifiers returned by CoreSimulator.
Preserve device-type selection, fixture isolation, paired Watch transport, and all test requirements.
Use the runtimes supplied by [GitHub's Xcode image](https://github.com/actions/runner-images/blob/xcode-27-arm64/20261104.0337/images/macos/xcode-27-arm64-Readme.md) in hosted CI.
Use [Xcode's platform download command](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components) locally when a platform is missing.

## Alternatives

Runtime pins preserve a fixed OS matrix but require matching installations.
Automatic downloads duplicate the hosted image's setup and add a network dependency.

## Consequences

Installed runtimes can differ between hosts.
Native results identify the environment actually exercised.
Reconsider explicit runtime pins when a release requires a fixed OS matrix.

## Confirmation

Exercise runtime records with missing and ambiguous devices, then run the phone, Duo, iPad, and paired Watch checks.
Keep the decision proposed until the hosted release checks pass.
