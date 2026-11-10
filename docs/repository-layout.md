# Repository ownership

`apps/web`, `apps/ios`, and `apps/android` contain the website and native app projects as sibling applications.
The Apple project contains its app, extensions, and local Swift packages.
Native platform packages and Gradle modules remain inside their app roots.

`packages/directory` owns reusable TypeScript directory contracts and search behavior.
The website imports the package by name rather than reaching into another app's source tree.
Swift and Kotlin implementations share public formats and contract fixtures rather than importing TypeScript at runtime.

`data/sources` contains collection declarations and shipped dataset pins.
`data/src` contains collection, extraction, validation, and artifact preparation.
`infrastructure/cloudflare` owns provider configuration and remote resource operations.
The root `tools` directory contains repository checks and developer entrypoints.
Build outputs and private local verification state stay under ignored `target` and `.local` directories.

## Package and platform tools

The JavaScript packages use [npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) with one root lockfile.
Install from the repository root:

```sh
mise install
mise x -- npm ci --ignore-scripts
```

The website uses Vite and the official Cloudflare CLI.
The Apple app uses Xcode and local Swift packages.
Android uses Gradle modules and its committed Gradle Wrapper.
The root justfile exposes the maintained checks without introducing a second app build orchestrator.

```sh
mise x -- just check
mise x -- just build
mise x -- just ios-check
mise x -- just android-check
```

The fast gate runs dependency-cruiser on the actual website and shared package imports.
It refuses Node effects in the shared directory package and imports from applications, data preparation, or infrastructure into that package.
It also refuses website runtime imports from preparation and infrastructure code.
Rejecting fixtures exercise the installed dependency checker.

## Shared reading data

`packages/directory/resources/PlaceReadings.json` is the canonical place-reading resource.
Android reads the canonical file during its build.
Swift Package Manager bundles a checked copy inside the Apple package's resource directory.
Refresh the copy after an authorized resource change:

```sh
mise x -- just sync-place-readings
```

The fast gate refuses a Swift resource that differs from the canonical JSON.
The existing cross-platform contract fixtures continue to check reading and search behavior.
