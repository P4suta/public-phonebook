default:
    @just --list

dev:
    npm run dev

build environment="development":
    npm run build -- {{ quote(environment) }}

data-prepare source output collection="":
    npm run data -- prepare {{ quote(source) }} {{ quote(output) }} {{ quote(collection) }}

data-collect output:
    node tools/collect.ts run sources/public-facilities.json --output {{ quote(output) }}

data-replay output:
    node tools/collect.ts run sources/public-facilities.json --output {{ quote(output) }} --offline

data-discover output:
    node tools/collect.ts catalog sources/contact-directories.json --output {{ quote(output) }}

data-local bundle:
    npm run data:local -- {{ quote(bundle) }}

data-check bundle:
    npm run data:check -- {{ quote(bundle) }}

phone-quality bundle report:
    npm run data:phones -- {{ quote(bundle) }} {{ quote(report) }}

check:
    npm run check

[positional-arguments]
test *args:
    node tools/test.ts "$@"

typecheck:
    npm run typecheck

lint:
    npm run lint

[positional-arguments]
e2e *args:
    npm run e2e -- "$@"

prove:
    npm run prove

ios-generate:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- generate

[positional-arguments]
ios-archive *args:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- archive "$@"

ios-build-number run attempt output:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- build-number --run-number {{ quote(run) }} --run-attempt {{ quote(attempt) }} --output {{ quote(output) }}

ios-testflight:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- testflight

ios-screenshots origin:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- screenshots --origin {{ quote(origin) }}

icons:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- icons

icons-check:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- icons --check

ios-unit-test:
    cargo run --locked --manifest-path tools/ios-check/Cargo.toml -- unit-test

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

data-remote environment bundle:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets R2_ACCESS_KEY_ID --only-secrets R2_SECRET_ACCESS_KEY --no-fallback -- npm run data:remote -- {{ quote(environment) }} {{ quote(bundle) }}

data-fetch dataset directory:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets R2_ACCESS_KEY_ID --only-secrets R2_SECRET_ACCESS_KEY --no-fallback -- npm run data:remote -- --fetch {{ quote(dataset) }} {{ quote(directory) }}

publish environment dataset bundle="":
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} --dataset {{ quote(dataset) }} {{ if bundle == "" { "" } else { "--bundle " + quote(bundle) } }}

publish-admission environment dataset bundle="":
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} --check-admission --dataset {{ quote(dataset) }} {{ if bundle == "" { "" } else { "--bundle " + quote(bundle) } }}

release dataset:
    node tools/release.ts {{ quote(dataset) }}

recover environment:
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} --recover

release-status environment:
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} --status

release-retention environment:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --only-secrets R2_ACCESS_KEY_ID --only-secrets R2_SECRET_ACCESS_KEY --no-fallback -- node tools/release-retention.ts {{ quote(environment) }}

[positional-arguments]
control-import directory *flags:
    node tools/control-import.ts "$@"

release-rehearse bundle=".local/phonebook":
    node tools/release-rehearsal.ts run {{ quote(bundle) }}

staging-access:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --no-fallback -- doppler run --project public-phonebook --config stg --no-fallback -- node tools/staging-access.ts configure

staging-check:
    doppler run --project public-phonebook --config stg --no-fallback -- node tools/staging-access.ts check
    doppler run --project public-phonebook --config stg --no-fallback -- node tools/staging-probes.ts
