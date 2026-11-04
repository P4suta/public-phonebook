---
date: 2026-11-04
---

# Count the first download down toward a deadline that only moves earlier

## Status

Accepted.
The iPhone app shows its first download through this policy since #188.
[Start from a bundled directory archive and catch up through deltas](start-from-a-bundled-directory-archive-and-catch-up-through-deltas.md) amends this record, because the run often transfers a delta or nothing.

## Context

The first download transfers about 13.4 MB and then parses and saves about 670,000 rows on the device.
The transfer's pace depends on the network, while the rest depends on the device, so the two stages run at very different rates.
The earlier screen extrapolated one percentage, so its remaining time could rise, jump, and reach zero while work continued.
The Figma wait design on page `468:1270` asks for a countdown that never rises, a calm line that changes at most once a second, and no zero before the end.
A slow or broken network also needs words of its own instead of a number that grows.

## Decision

`PhonebookCore.WaitDisplay` decides the line under the current step from elapsed milliseconds and progress samples, with integers and no clock of its own.
It measures the pace of the current stage up to its last progress and counts the time since then as spent.
A pause between bursts of bytes then shortens the estimate instead of inflating it.
The estimate adds a budget per 1,000 rows for the work after the transfer.
The budgets of 7 ms and 3 ms come from the unoptimized simulator timings in #186, about twice the shipped build's.
Once the rows start saving, the budget of the last step scales with the observed saving pace.
Once the line counts down, it keeps a deadline and shows the whole seconds left until it.
A new estimate may move that deadline earlier, and the shown seconds stay at or below every earlier countdown in the run.
An estimate more than 3 seconds past the deadline, or longer than a minute, turns the line into coarse minutes.
The line counts down again only after a short estimate holds for 3 seconds and fits under the lowest countdown so far.
At 3 seconds or less the line says the run is almost done, and it says so until the end unless the transfer stalls.
Ten seconds without transfer progress report a weak signal, and the next bytes start a new measurement.
The line changes at most once a second, each step stays current for at least 0.6 seconds, and a run that ends within 2 seconds goes straight to the done state.

`verification/ios/WaitDisplay.lean` models the Swift file function for function and proves these promises for every finite trace of samples.
The proof gate pins the SHA-256 of the whitespace-free Swift file, so any edit to it fails the gate until the model is checked again.
The kernel also replays ten traces that the Swift tests record, so both implementations must draw the same screens.
Three planted defects must each fail inside the theorem that they break.

## Consequences

The countdown can end early and then say the run is almost done for longer than 3 seconds, because the deadline never moves later.
A slow device or network shows coarse minutes instead of a countdown that climbs.
Every division in the policy has a nonnegative numerator and a positive divisor, so Lean's Euclidean division and Swift's truncating division agree.
The inputs clamp to bounds that keep every product within Int64, and a Lean theorem and a Swift test at the extremes cover that argument.
The traces cover every branch, while the theorems cover every input, so a mistranscribed branch fails either the replay or a theorem.
Changing a threshold means editing both files, updating the digest, and regenerating the traces.
