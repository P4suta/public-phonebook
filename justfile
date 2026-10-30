default:
    @just --list

dev:
    npm run dev

build environment="development":
    npm run build -- {{ quote(environment) }}

data-prepare source output:
    npm run data -- prepare {{ quote(source) }} {{ quote(output) }}

data-local bundle:
    npm run data:local -- {{ quote(bundle) }}

data-check bundle:
    npm run data:check -- {{ quote(bundle) }}

phone-quality bundle report:
    npm run data:phones -- {{ quote(bundle) }} {{ quote(report) }}

check:
    npm run check

test: check (data-check ".local/phonebook") (phone-quality ".local/phonebook" ".local/phone-quality.json")
    npm run prove
    npm run e2e

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
    doppler run --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID --no-fallback -- npm run publish -- {{ quote(environment) }} {{ quote(bundle) }}
