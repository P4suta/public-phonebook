---
date: 2026-10-30
---

# Render an interactive reference from the service's OpenAPI document

## Status

Proposed.
Implemented locally.

## Context

External developers need discoverable operations, parameter examples, executable requests, response inspection, and code samples without scraping the website.
The running service already generates an OpenAPI description from its Hono routes and Valibot contracts.
A separate hand-maintained operation list and request form duplicate that contract.
The interface must retain the project's black-and-white presentation and local asset boundary.

## Decision

Use the pinned `@scalar/api-reference-react` integration for operation navigation, search, examples, code generation, and the interactive request client.
Retrieve the current description from `/api/openapi.json`.
Keep the application adapter limited to loading, failure recovery, localization, presentation, and external-link accessibility.
The accessibility adapter also repairs the pinned client's missing editor names, collapsed combobox state, invalid copy-control references, and keyboard scrolling targets without replacing its interaction model.
Load the integration only on `/developers` through a client-only dynamic import.
Bundle dependencies locally and disable telemetry, hosted agents, proxying, developer tools, and remote fonts.
Configure Zod's documented `jitless` mode before importing Scalar so its parser does not probe dynamic code generation.
Owned API validation continues to use Valibot.

Apply the existing monochrome roles through Vanilla Extract.
The scoped PostCSS adapter retains Scalar's layout, binary paints, theme variables, and binary visibility while removing its other palette declarations, fractional opacity, and visual effects.
The annotated property classifier is checked against the actual TypeScript source through LemmaScript and Dafny.
The classifier theorem does not prove CSS parsing, rendering, accessibility, or the complete third-party implementation.

Only `/developers` permits inline styles for the library's dynamic measurements, CSS variables, and editor stylesheets.
This follows [Scalar's CSP integration guidance](https://github.com/scalar/scalar/blob/main/documentation/integrations/nextjs.md#content-security-policy-csp).
External stylesheets remain restricted to the application origin.
The editor registers new stylesheet content when individual inputs are activated, so a finite hash list does not cover its supported interactions.
The script policy permits neither inline scripts without a nonce nor dynamic evaluation.
Connections remain restricted to the application origin.
The normal search, data, and contact pages retain their stricter style-attribute policy.

The palette detector checks every rendered element and active pseudo-element, including upstream editor and notification content.
It additionally checks declarations from compiled stylesheets and nonce-bearing application styles.
On the reference page, non-nonce runtime styles are an upstream rendering boundary whose palette is intentionally replaced by application CSS.
The audit reports their rule count and checks their rendered effects with every other element.
Explicit checks include SVG paint opacity and masking so black paint cannot conceal a translucent or gradient-based effect.
Its isolated Shadow DOM probe prevents application overrides from concealing prohibited authored declarations.
Negative controls must still detect planted color, opacity, blending, and other prohibited effects.
Do not discard CSP errors or bypass CSP in browser tests.

## Consequences

The interactive reference follows the service contract rather than a duplicate application form.
The ordinary search page does not load the reference client.
The dependency adds a substantial, separately loaded JavaScript and CSS bundle to the API page.
Japanese interface overrides and a small presentation adapter remain application responsibilities.
Operation descriptions and API identifiers remain part of the English public contract.

Run native request, search, palette, accessibility, and CSP controls after dependency or configuration changes.
Allowing dynamic styles on the reference page reduces protection against style injection there; it does not authorize scripts or remote requests.
Library parsing, browser layout, network behavior, and clipboard interaction remain native integration-test boundaries.

Keeping a bespoke viewer would retain duplicate navigation, request, and code-generation behavior.
Swagger UI is a maintained alternative, but switching viewers would still require a monochrome and accessibility adapter.
An external CDN or hosted documentation service would add a runtime network dependency and a separate publishing boundary.
A fixed runtime stylesheet hash list was rejected because editor styles depend on the activated inputs and their creation order.
