---
date: 2026-11-02
---

# Render the API reference on the server from the OpenAPI document

## Status

Superseded by [serving directory JSON to the website](serve-directory-json-to-the-site-only.md).
The website no longer provides the developer page or OpenAPI documents.

## Context

The former Scalar reference loaded approximately 4.5 MB of JavaScript and required extensive style and accessibility adaptations.
Its content disappeared without JavaScript.

## Decision

The historical implementation rendered supported OpenAPI operations on the server.
An in-process loader supplied headings, parameter descriptions, response meanings, examples, and ordinary GET forms.
JavaScript enhanced requests without changing their admission rules.
The pure request policy admitted documented operations, encoded path segments, and bounded displayed response bodies.
The page used the website's existing Content Security Policy without third-party code.

## Alternatives

Keeping a client-side viewer preserved its bundle and adaptation costs.
Build-time generation could drift from the running API.

## Consequences

The page became readable before scripts ran but lost the viewer's schema browser and operation search.
An external developer interface would require a fresh decision after its retirement.

## Confirmation

Historical browser checks covered requests, navigation, copying, accessibility, and policy enforcement.
The current [open data guide](../api.md) documents the supported replacement.
