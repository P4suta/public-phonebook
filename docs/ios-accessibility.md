# Accessibility evaluation

Public Phonebook's Accessibility Nutrition Labels remain undeclared until device observations support every common task for a feature.
Apple requires all common tasks to work with each declared feature and includes first launch and settings in that scope.
The [Accessibility Nutrition Labels overview](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/overview-of-accessibility-nutrition-labels) governs the evaluation.
Captions and Audio Descriptions remain undeclared because the app provides no audio or video content.

## Common tasks

### First launch

Start the app, read the download notice, prepare the bundled directory, skip caller identification, and finish onboarding.
Repeat with caller identification enabled through iOS settings and with a waiting or interrupted first download.
Confirm that progress, completion, and recovery remain perceivable and operable.

### Search by name or telephone number

Enter a facility name, read category headings and counts, open more results, clear the query, and recover from an empty result.
Search for a complete telephone number and read every matching category.
Confirm that changing a query updates the results and announces the result count without moving focus away from the search field.

### Open a facility

Open a search result and read the facility name, region, telephone number, and address.
Return to the results without losing the query.
Inspect facilities with long names or addresses.
Inspect a facility with two telephone numbers and the shortest fixture record.

### Call

Identify and activate the call button for a selected number, review the system confirmation, cancel, and return to the facility.
Use an owner-controlled test number for a completed call.
Never place a test call to a published facility.

### Open a map

Activate the map button, read the disclosure about sending the facility name and address to Apple, and cancel the confirmation.
Accept the confirmation, verify the destination in Apple Maps, and return to Public Phonebook.
Check the unavailable-location message with the connection off.

### Enable caller identification

Read the caller identification status, open iOS settings from onboarding and from the app's settings, and enable the extension.
Return to the app and verify that the status shows caller identification is on.
Check the off, preparing, and unavailable states, including recovery after returning from the background.
Use an owner-controlled number to verify the incoming call experience.

### Read the data sources

Open a facility's source information and read its publisher, dates, and license.
Reach the original source and license links and operate the external-link confirmation.
Also read the app's About, data sources, privacy, and license screens and return to search.

## Feature criteria

### Screen reader

Use VoiceOver alone, without sighted help, to finish every common task.
Check focus order, labels, values, traits, category headings, result announcements, confirmation dialogs, scrolling, and focus after returning from another screen or app.
The search field needs an understandable label independent of its current value.
Decorative icons must not become extra stops.
Follow [Apple's VoiceOver criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/voiceover-evaluation-criteria).

### Voice commands

Use voice commands alone without touching the display to finish every common task.
Check Show names and Show numbers for every interactive control, including the search field, clear button, menu, call button, map confirmation, and source links.
Speak the visible control names to activate each action.
Scroll and return from iOS settings without tapping the display.
Follow [Apple's Voice Control criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/voice-control-evaluation-criteria).

### Text enlargement

Run every common task at each font size that Dynamic Type offers, including the largest accessibility setting.
Check portrait and landscape on a small supported iPhone.
Primary text must reach at least 200% or the system's largest font size without overlapping or severely truncating content.
Meaningful icons must enlarge with their labels, and every action must remain reachable by scrolling.
Zoom and Hover Text don't establish support.
Follow [Apple's Larger Text criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/larger-text-evaluation-criteria).

### Dark appearance

Enable the system's Dark Mode before launching and keep it enabled through every common task.
Inspect startup, progress, empty and failure states, navigation, dialogs, and returns from other apps for bright flashes or bright app-owned surfaces.
Repeat with Increase Contrast enabled.
Follow [Apple's Dark Interface criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/dark-interface-evaluation-criteria).

### Information without color

Finish every common task with the Grayscale color filter enabled.
Check that caller identification, progress, unavailable controls, failures, and selected states convey their meaning through words, shapes, or placement.
Grayscale is a check for dependence on color, not a simulation of every form of color blindness.
Follow [Apple's Differentiate Without Color Alone criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/differentiate-without-color-alone-evaluation-criteria).

### Contrast

Inspect text, meaningful icons, controls, and state indicators in light and dark appearances.
Measure foreground and background contrast with Accessibility Inspector.
Use at least 4.5:1 for ordinary text and 3:1 for meaningful non-text controls and states.
Turn on Bold Text, Increase Contrast, and Reduce Transparency before repeating the tasks.
Repeat with Increase Contrast on and Reduce Transparency off.
Follow [Apple's Sufficient Contrast criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/sufficient-contrast-evaluation-criteria).

### Motion

Enable Reduce Motion and perform every common task, including progress indicators, scrolling, navigation, and transitions to external apps.
Observe each animation for spinning, scaling, parallax, depth simulation, or ongoing motion that could cause discomfort.
Confirm that any problematic motion stops or has an operable alternative while preserving progress and state information.
Follow [Apple's Reduced Motion criteria](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/reduced-motion-evaluation-criteria).

## Automated audit

Run the common-task scenarios with the pinned project tools:

```sh
mise x -- just ios-ui-test --test testCommonTasksPassAccessibilityAudits --test testCommonTasksPassAccessibilityAuditsAtLargestTextSize --test testCommonTasksPassAccessibilityAuditsInDarkAppearance
```

The scenarios audit onboarding, caller settings, name and number results, facility details, the map confirmation, and source information.
XCTest runs each audit with [`performAccessibilityAudit(for:_:)`](https://developer.apple.com/documentation/xcuiautomation/xcuiapplication/performaccessibilityaudit%28for%3A_%3A%29).
The scenarios use the default appearance, the largest font size that Dynamic Type offers, and Dark Mode.
Each audited screen has a screenshot attachment.
External handoffs use the system's native alerts for prior consent, following Apple's [Alerts guidance](https://developer.apple.com/design/human-interface-guidelines/alerts).
The map confirmation checks its exact title, disclosure, opening action, and native cancellation behavior.
Its audit preserves the existing exception for the system dialog's Dynamic Type report.
Before and after each modal audit, the test matches the complete title and disclosure and requires both opening and cancellation actions to be reachable.
The largest-text scenario requires the disclosure to exceed twice its default height and the native action targets to measure at least 44 points.
App-owned screens keep every audit category enabled.
Visible-content audits complete Dynamic Type before checking the remaining categories.
Scrolling information screens exclude contrast findings for clipped static text because XCTest fills the offscreen part of its image with black.
Navigation-bar titles remain in the contrast audit.
Failure attachments identify the affected accessibility element.
Apple's [audit guidance](https://developer.apple.com/videos/play/wwdc2023/10035/) explains why automated findings need investigation and why audits complement assistive-technology testing.
The source screen expands opaque license identifiers to the published names of [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) and [Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
The iOS verification gate includes all three scenarios and refuses missing or skipped test results.
The runner records source hashes and the result of each scenario in `target/ios/ui-receipt.json`.
Result bundles stay under `target/ios`.

On iOS and iPadOS 27.2, a native confirmation can produce an Element Detection report without an element while the underlying screen passes its full audit.
A probe on 2026-11-11 reproduced the report with standard SwiftUI controls and with Apple's Settings language confirmation.
The Settings confirmation produced 22 reports without elements.
The modal helper accepts that report on iOS and iPadOS 27.2 handoff alerts after matching the title and disclosure and checking both actions.
It rejects reports with an identified element and all remaining audited categories.
App-owned content retains the full audit before opening a confirmation.

The simulator uses fixture data and a simulated caller identification state.
It doesn't place calls, open Apple Maps, change the system's caller identification setting, or operate VoiceOver or Voice Control.
A passing audit covers the executed checks on the visited screens.
Passing automated checks don't establish completion of the device evaluation or eligibility for a store label.

## Device records

The owner-reported checks cover part of the physical-device evaluation.
The complete common-task matrix remains pending, so the observations don't establish eligibility for a store label.
Keep one record per feature, task, and device configuration.
Record failures and incomplete attempts alongside passing observations.

### Owner observations on 2026-11-08

The owner used Public Phonebook QA on iPhone Air with iOS 27.2, build 24B119.
The manual observations didn't capture the app's source hash.

With VoiceOver alone and without looking at the screen, the owner completed the `とうきょう としょかん` search, facility details, call cancellation, maps, sources, and settings.
With Voice Control alone and without touching the screen, the owner completed the same requested operations and checked Show names and Show numbers.
The owner reported successful operation for both feature checks.

At the largest accessibility text size, the owner reported readable content and operable major controls in portrait and landscape.
The owner also reported no readability or operation failures with Dark Mode, Increase Contrast, Grayscale, and Reduce Motion.
The observations don't cover every Dynamic Type font size, a small supported iPhone, measured contrast ratios, or every first-launch and failure state.

The owner enabled the QA extension and confirmed incoming labels before and after changing the controlled number's label.
A private incoming-call screenshot identifies Public Phonebook QA as the provider.
Keep the screenshot and device archives private because they contain personal device information.

First launch, interrupted preparation, empty and expanded results, complete-number search, long names, two telephone numbers, and the complete information-screen flow still need feature-specific observations.
The store declaration remains at the post-release stage specified by issue #284.
Record the date, tester, iPhone model, iOS version and build, and app version and build.
Include the source revision, artifact digest, directory snapshot, language, orientation, and feature settings.
Describe the exact task, observed behavior, and evidence location.
Use passed, failed, or inconclusive only after executing the task.
Keep unexecuted tasks pending.

A failed task prevents declaration of its feature until the fix and the task's repeat evaluation pass.
Keep recordings or Accessibility Inspector findings with the tested build's evidence.
Use the [device verification procedure](ios-device-verification.md) for installation and caller identification checks.

## Store declaration

After every common task passes for a feature, the owner can select that feature for iPhone in App Store Connect's App Accessibility section.
Record the exact supported features, reviewed device records, app version and build, date, and the saved or published store state here.
Keep Captions and Audio Descriptions unselected while the app has no audio or video content.
Apple saves responses as a draft and permits publication only for devices with a live App Store version, as described in [Manage Accessibility Nutrition Labels](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/manage-accessibility-nutrition-labels).
The store declaration and publication remain pending.
