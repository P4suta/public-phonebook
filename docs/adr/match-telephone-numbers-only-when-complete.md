---
date: 2026-11-05
---

# Match telephone numbers only when complete

## Status

Accepted.
It keeps the complete-number rule of [Search the saved directory on the device](search-the-saved-directory-on-the-device.md) and [Match every search word in the name, region, or category](match-every-search-word-in-the-name-region-or-category.md).

## Context

The owner searched `047` and got nothing, and asked whether search should match the start of a telephone number.
Search reads a query as a telephone number only when it spells a complete Japanese number of 10 or 11 digits.
A shorter number falls through to word search, which looks for the digits in names, regions, and categories.
The service is a name search, and its guidance names facility names only.
On the national dataset of 667,696 contacts, the first two digits of a listed number match a median of 82,732 contacts.
The first three to eight digits match medians of 11,344, 1,907, 303, 46, 8, and 2 contacts.

## Decision

Match a telephone number only when the query spells it completely, in any accepted spelling.
A partial number stays a word query, and an empty result for it needs no message.
While the website searches on the server, its trigger policy keeps waiting on an incomplete telephone spelling until the reader presses Enter or the search button.

A prefix narrows the directory to a few rows only from about seven digits.
A reader who knows seven digits of a facility's number knows the whole number, and a reader who knows fewer digits has the name to search.
Prefix search would add a query kind, an indexed range on each of three engines, and a proved trigger rule for little use.

Pin the complete-number reading across the engines instead.
The shared search contract lists the number that the website reads from each seeded and fixed spelling, and the iPhone app's tests require the same reading.
The app trims the edge characters that JavaScript's `trim` removes, so `U+FEFF` around a pasted number reads as the number and `U+0085` keeps a word query, as on the website.
The parity stage draws listed numbers in five spellings and requires every one to read as a number and find its contact.

## Consequences

`047` finds nothing on the website and in the app unless a facility's name, region, or category holds those digits.
A pasted number that carries a byte order mark now finds its facility in the app as it does on the website.
Revisit the decision if the guidance starts to offer number search or readers report searching by partial numbers.
