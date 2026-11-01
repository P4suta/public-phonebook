---
date: 2026-11-02
---

# Number TestFlight builds from the workflow run and upload them with altool

## Status

Accepted.
The first owner-approved dispatch of `ios.yml` checks the upload and the processing query with App Store Connect.

## Context

The TestFlight workflow archives one production build for each owner-approved dispatch of `ios.yml` on `main`.
App Store Connect refuses a build whose number an earlier upload of the same version already used.
A rerun of a failed delivery job can follow an upload that App Store Connect accepted, so a rerun must never reuse a number.
Local archives keep build number 1 from the project.
The workflow also needs a supported way to upload the signed package with an App Store Connect API key and to learn when processing ends.

The [upload guide](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds) lists Xcode, `altool`, Transporter, and the App Store Connect API as upload routes.
The [`altool` guide](https://help.apple.com/asc/appsaltool/en.lproj/static.html) replaces the deprecated `--upload-app` with `--upload-package`.
The `altool` in Xcode 27.2 accepts `--api-key`, `--api-issuer`, and `--p8-file-path`, and it reads the bundle details from the package.
The [builds endpoint](https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds) filters by app, build number, version, and platform.
Its `processingState` is `PROCESSING`, `FAILED`, `INVALID`, or `VALID`.

## Decision

Set the build number to the workflow run number times 100 plus the run attempt.
`ios-check build-number` computes it in the delivery job from `GITHUB_RUN_NUMBER` and `GITHUB_RUN_ATTEMPT`, and it refuses attempt 100 and above.
For runs r < s, every number of run r is at most 100r + 99, which is below 100s + 1, the smallest number of run s.
Within one run, a later attempt adds a larger attempt to the same base.
The delivery job computes the number itself, because rerunning only that job gives it a new attempt while the earlier jobs keep their old outputs.
The smallest CI build number is 101, above every local build.
`archive --signing ci` passes the number as `CURRENT_PROJECT_VERSION` and checks `CFBundleVersion` in the exported app and its extension.

Upload with `xcrun altool --upload-package` and an App Store Connect API key with the App Manager role.
Then query the builds endpoint for the app, version 1.0, iOS, and the build number every 60 seconds, at most 60 times.
Create a new token for each query with `xcrun altool --generate-jwt`, which signs the standard ES256 token for the API.
Pass the token to curl on standard input so that it never appears in a command line or a log.
End on `VALID`, and fail on `FAILED`, `INVALID`, an unknown state, or a refused query.
Retry throttling, server errors, and network failures at most four times in a row.

Rejected routes:
- The build upload API would need a chunked upload client in this tool, while `altool` already performs the same upload.
- `xcodebuild -exportArchive` with the `upload` destination has only forum reports of API-key failures.
- `altool --wait` and `altool --build-status` have no documented output format and no time limit.
- The latest App Store Connect build plus one needs a credentialed query before signing, and a build that isn't visible yet repeats a number.

## Consequences

Every dispatch and every rerun of this workflow gets a larger build number than all earlier ones, without a query or stored state.
Rerunning an older run after a newer one uploaded produces a smaller number, which App Store Connect may refuse, so dispatch a new run instead.
Renaming or recreating `ios.yml` restarts its run numbers, so that change also needs an offset above the last uploaded build.
A run can encode at most 99 attempts.
The `altool` token carries no `iat` claim and expires after five minutes, so the first dispatch confirms that the API accepts it.
If processing outlasts the 60 queries, the job fails as inconclusive, and the owner checks the build in App Store Connect.
The workflow never submits a build for review, and App Store submission stays with the owner.
