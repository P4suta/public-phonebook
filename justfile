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

test:
    node tools/test.ts

typecheck:
    npm run typecheck

lint:
    npm run lint

[positional-arguments]
e2e *args:
    npm run e2e -- "$@"

prove:
    npm run prove

data-remote environment bundle:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --no-fallback -- npm run data:remote -- {{ quote(environment) }} {{ quote(bundle) }}

publish environment bundle=".local/phonebook":
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} {{ quote(bundle) }}

release bundle=".local/phonebook":
    node tools/release.ts {{ quote(bundle) }}

recover environment:
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} .local/phonebook --recover

release-status environment:
    doppler run --project public-phonebook --config {{ if environment == "staging" { "stg" } else { "prd" } }} --no-fallback -- npm run publish -- {{ quote(environment) }} .local/phonebook --status

release-retention environment:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --no-fallback -- node tools/release-retention.ts {{ quote(environment) }}

release-rehearse bundle=".local/phonebook":
    node tools/release-rehearsal.ts run {{ quote(bundle) }}

staging-access:
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --no-fallback -- doppler run --project public-phonebook --config stg --no-fallback -- node tools/staging-access.ts configure

staging-check:
    doppler run --project public-phonebook --config stg --no-fallback -- node tools/staging-access.ts check
    doppler run --project public-phonebook --config stg --no-fallback -- node tools/staging-probes.ts
