---
date: 2026-11-21
---

# Use the system label color for the iOS accent

## Status

Accepted in the plan for [issue #445](https://github.com/P4suta/public-phonebook/issues/445).

## Context

Custom controls required separate drawing across appearances and accessibility settings.
Search results need two independent actions in the space of one list row.

## Decision

Use the system label color as the app accent on iPhone and iPad.
Let SwiftUI draw navigation bars, lists, forms, menus, progress indicators, and button states.
Use SF Symbols for actions and keep the shared facility category icons.
Apple describes how standard components adopt system materials in [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).

## Alternatives

Drawing every surface in black or white gives the app direct control over each pixel and requires separate implementations for selection, contrast, and control states.
The default blue accent would change the requested monochrome identity.

## Consequences

System materials may introduce translucency and intermediate tones.
Reconsider the choice if a supported OS makes either row action indistinguishable with Increase Contrast or larger text.

## Confirmation

Check the accent asset, reject custom colors and toolbar backgrounds, and verify native materials in Figma.
Exercise both actions at the largest text setting and compare sample captures on iPhone, iPhone Duo, and iPad.
