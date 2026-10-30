---
date: 2026-10-30
---

# Permit the native select inheritance style by its exact hash

## Status

Proposed.
Implemented and checked locally.
The separate style policy for `/developers` is recorded in the [interactive reference decision](openapi-driven-interactive-reference.md).

## Context

Native select controls provide keyboard, accessibility, and mobile behavior without replacing the browser's interaction model.
WebKit 27.2 creates a user-agent shadow-tree slot with an inline text-overflow inheritance attribute before attaching it to the shadow tree.
Its CSP implementation therefore checks that internal attribute as page content.
The failure reproduces with no application stylesheet or script.
The [Playwright maintainer's investigation](https://github.com/microsoft/playwright/issues/43416#issuecomment-6198266325) identifies the cause and the separate screenshot instrumentation issue.

## Decision

Permit only the SHA-256 hash of the exact attribute value `text-overflow:inherit` through style-src-attr and unsafe-hashes.
The allowed property inherits the parent's text-overflow presentation and grants no script, network, color, or arbitrary style permission.
Keep stylesheet elements restricted to the application origin and the generated request nonce.
Keep scripts restricted to the application origin and the generated request nonce.
Do not permit unsafe-inline or unsafe-eval.

Check the hash against Web Crypto in each supported browser.
Require native selects and the exact inheritance attribute to work without policy violations.
Require a different style attribute, an untrusted stylesheet, an empty stylesheet, and an untrusted script to produce policy violations.
The ordinary browser fixture continues to fail on unexpected console errors.

Record native WebKit video for visual evidence.
Do not use Playwright's WebKit screenshot synchronizer, which injects an untrusted empty stylesheet from its utility world.
Other engines retain PNG screenshots as well as video.
No test context bypasses CSP, no browser error message is discarded for this issue, and no DOM prototype is patched.

## Consequences

Native select controls work with the current WebKit build while unknown inline content remains blocked.
The policy contains one documented style-attribute exception.
Reassess the exception when the upstream fix reaches the supported WebKit build.
A native regression fixture can then establish whether the hash is still necessary.
Blanket inline styling or disabled CSP would hide application defects.
Replacing native controls only to avoid a browser regression would introduce an unnecessary interaction boundary.
