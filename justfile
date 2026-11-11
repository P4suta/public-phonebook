default:
    @just --list

dev:
    npm run dev

dev-forgiving port="8787":
    node tools/build.ts development --local-forgiving-search
    node tools/built-worker-server.ts --local-forgiving-search --port {{ quote(port) }}

build environment="development":
    npm run build --workspace @public-phonebook/web -- --mode {{ quote(environment) }}

data-prepare source output collection="" delta_bases="":
    npm run data -- prepare {{ quote(source) }} {{ quote(output) }} {{ quote(collection) }} {{ if delta_bases == "" { "" } else { "--delta-base-root " + quote(delta_bases) } }}

data-prepare-forgiving source output collection="":
    npm run data -- prepare {{ quote(source) }} {{ quote(output) }} {{ quote(collection) }} --forgiving-search

search-quality-forgiving bundle report=".local/search-quality.json":
    node data/src/search-ranking-contract.ts quality {{ quote(bundle) }} {{ quote(report) }}

data-collect output:
    node data/src/collect.ts run data/sources/public-facilities.json --output {{ quote(output) }}

data-replay output:
    node data/src/collect.ts run data/sources/public-facilities.json --output {{ quote(output) }} --offline

data-discover output:
    node data/src/collect.ts catalog data/sources/contact-directories.json --output {{ quote(output) }}

data-local bundle:
    npm run data:local -- {{ quote(bundle) }}

data-check bundle:
    npm run data:check -- {{ quote(bundle) }}

sync-place-readings:
    cp packages/directory/resources/PlaceReadings.json apps/ios/Sources/PhonebookKit/PlaceReadings.json

phone-quality bundle report:
    npm run data:phones -- {{ quote(bundle) }} {{ quote(report) }}

check:
    npm run check

check-build:
    npm run check:build

check-rust:
    node tools/check-rust.ts

assurance: check-build prove delivery-prove ios-prove ios-check ios-sanitize ios-mutate android-prove android-check android-mutate

[positional-arguments]
delivery *args:
    cargo run --locked --manifest-path tools/delivery/Cargo.toml -- "$@"

delivery-prove:
    cargo run --locked --manifest-path tools/delivery/Cargo.toml -- prove

android-check:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- check

android-prove:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- prove

[positional-arguments]
android-mutate *args:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- mutate "$@"

[positional-arguments]
android-release-check *args:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- release-check "$@"

[positional-arguments]
android-install *args:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- install "$@"

[positional-arguments]
android-device-check *args:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- device-check "$@"

android-signing-init:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- signing-init

android-distribution build_number:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- distribution --build-number {{ quote(build_number) }}

android-sign build_number:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- distribution --build-number {{ quote(build_number) }} --prepared

android-prepare build_number:
    cargo run --locked --manifest-path tools/android-check/Cargo.toml -- prepare --build-number {{ quote(build_number) }}

[positional-arguments]
test *args:
    npm test -- "$@"

typecheck:
    npm run typecheck

lint:
    npm run lint

[positional-arguments]
check-linux *args:
    node tools/check-linux.ts "$@"

[positional-arguments]
e2e *args:
    npm run e2e -- "$@"

public-rehearsal bundle:
    node tools/public-rehearsal.ts {{ quote(bundle) }}

prove:
    npm run prove

ios-simulator-runtime platform:
    xcodebuild -downloadPlatform {{ quote(platform) }} -architectureVariant arm64

ios-generate:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- generate

[positional-arguments]
ios-archive *args:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- archive "$@"

ios-prepare-archive build_number:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- prepare-archive --build-number {{ quote(build_number) }}

ios-build-number run attempt output:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- build-number --run-number {{ quote(run) }} --run-attempt {{ quote(attempt) }} --output {{ quote(output) }}

ios-testflight:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- testflight

ios-screenshots simulator="iphone-17":
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- screenshots --simulator {{ quote(simulator) }}

ios-watch-screenshots:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- watch-screenshots

icons:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- icons

icons-check:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- icons --check

ios-unit-test:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- unit-test

ios-watch-check:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- watch-check

ios-watch-profile file:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- import-watch-profile --profile {{ quote(file) }}

# Reports the named Swift tests to `dotfiles verify run` as structured JSON, while `ios-unit-test` stays the gate.
[positional-arguments]
verification *args:
    cargo run --locked --quiet --manifest-path tools/ios-check/Cargo.toml --bin swift-verification -- "$@"

ios-search-measure:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- search-measure

ios-check:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- check

ios-prove:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- prove

ios-sanitize:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- sanitize

ios-mutate:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- mutate

[positional-arguments]
ios-ui-test *args:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- ui-test "$@"

[positional-arguments]
ios-device-record *args:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- device-record "$@"

[positional-arguments]
ios-qa-install *args:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- qa-install "$@"

data-remote environment bundle:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_API_TOKEN --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets R2_ACCESS_KEY_ID --only-secrets R2_SECRET_ACCESS_KEY --no-fallback -- npm run data:remote -- {{ quote(environment) }} {{ quote(bundle) }}

data-fetch dataset directory:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets R2_ACCESS_KEY_ID --only-secrets R2_SECRET_ACCESS_KEY --no-fallback -- npm run data:remote -- --fetch {{ quote(dataset) }} {{ quote(directory) }}

release:
    gh workflow run release.yml --ref main

recover version:
    gh workflow run recover.yml --ref main -f version={{ quote(version) }}

release-status:
    gh workflow run status.yml --ref main

release-retention environment:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets R2_ACCESS_KEY_ID --only-secrets R2_SECRET_ACCESS_KEY --no-fallback -- node infrastructure/cloudflare/src/release-retention.ts {{ quote(environment) }}

[positional-arguments]
monitors *flags:
    doppler run --project public-phonebook --config prd --only-secrets BETTER_STACK_API_TOKEN --no-fallback -- node infrastructure/cloudflare/src/uptime.ts "$@"

[positional-arguments]
cloudflare-alerts *flags:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets CLOUDFLARE_ALERT_EMAIL --no-fallback -- node infrastructure/cloudflare/src/cloudflare-alerts.ts "$@"

[positional-arguments]
control-import directory *flags:
    node infrastructure/cloudflare/src/control-import.ts "$@"
