default:
    @just --list

dev: build-web
    cargo run --locked -p public-phonebook -- serve

prepare-service output="data/service":
    cargo run --locked -p public-phonebook -- prepare-service --output {{ quote(output) }}

cloudflare-dev:
    npm run dev:cloudflare

cloudflare-build:
    npm run build:cloudflare

cloudflare-deploy *args:
    doppler run --no-fallback --project public-phonebook --config prd --only-secrets CLOUDFLARE_ACCOUNT_ID -- npm exec --no -- cf deploy --prebuilt {{ args }}

e2e-production:
    npm run e2e:production

update-data *args:
    cargo run --locked -p public-phonebook -- update {{ args }}

validate-data:
    cargo run --locked -p public-phonebook -- verify-data

e2e *args:
    npm run e2e -- {{ args }}

e2e-national *args:
    npm run e2e:national -- {{ args }}

check *args: format lint test audit secrets workflow-check design-check web-check
    cargo run --locked -p xtask -- check {{ args }}

service-check *args:
    just check --data --proofs --fuzz --browsers --cloudflare {{ args }}

fuzz-replay:
    cargo run --locked -p xtask -- fuzz-replay

prove *args:
    cargo run --locked -p xtask -- prove {{ args }}

build-web:
    npm run build:web

web-check:
    cargo run --locked -p xtask -- check-web

design-check:
    npm run e2e -- tests/e2e/design.spec.ts --project=chromium

format:
    cargo fmt --all --check
    cargo fmt --manifest-path fuzz/Cargo.toml --check
    taplo fmt --check Cargo.toml crates/phonebook/Cargo.toml crates/phonebook-core/Cargo.toml xtask/Cargo.toml fuzz/Cargo.toml mise.toml sources/medical.toml sources/prefecture-confirmation.toml sources/public-data.toml sources/civic.toml sources/childcare.toml repository.toml

lint:
    cargo clippy --locked --workspace --all-targets -- -D warnings
    cargo clippy --manifest-path fuzz/Cargo.toml --locked --all-targets -- -D warnings
    npm run typecheck
    npm run lint

test:
    cargo test --locked --workspace
    npm run test:web

audit:
    cargo run --locked -p xtask -- audit
    npm run audit

secrets:
    gitleaks dir --no-banner --redact .

workflow-check:
    actionlint .github/workflows/checks.yml
