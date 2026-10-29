# Cloudflare service

The production entry point is `cloudflare.config.ts`.
The project uses the pinned `cf` CLI and Cloudflare Vite Plugin.
Wrangler is not a project dependency.
The Rust server remains available for direct local development.

The Container uses the `durable-object` scheduling policy and the native Durable Object Container API.
The Worker reaches its own class through the typed `ctx.exports.Phonebook` loopback namespace.
The Worker selects one canonical directory object and starts its named, digest-pinned image on the `lite` instance size.
The adapter serializes startup, checks health before forwarding, and replaces an obsolete image before serving another request.
Cloudflare stops an idle instance after ten minutes.
The policy has no application-wide instance limit; the fixed object name supplies the service's single-instance bound.

## Local commands

Install dependencies with `mise x -- npm ci`.
Install browser builds with `mise x -- npm run browsers`.
Run `mise x -- just dev` for the local Rust server at `http://127.0.0.1:3000`.
Run `mise x -- npm run build:web` after editing browser TypeScript.
The default check rejects an embedded JavaScript file that differs from that output.

A Cloudflare build needs an audited national snapshot and a working Docker engine.
Run `mise x -- just prepare-service` once in a fresh build context.
This writes `data/service/` without changing the active database.
The command refuses an existing output directory.
Use a fresh destination for another candidate and select its audited files in the Docker build input.
Never overwrite files used by a running service.

Run `mise x -- just cloudflare-dev` for `http://127.0.0.1:8787`.
Open `/api/docs` to try the public read API and `/api/openapi.json` for its generated contract.
The [API guide](api.md) describes reuse, complete downloads, snapshot identities, and errors.
This runs the real local Workers runtime and a Linux container.
A cold build compiles the Rust server.
The Docker build limits Cargo to two jobs and caches dependencies for subsequent builds.

Run `mise x -- just cloudflare-build` to produce Cloudflare Build Output locally.
Every build also runs the deployment dry run and rejects invalid Container and Durable Object links before publication.
Run `mise x -- npm exec --no -- cf deploy --dry-run --prebuilt` to inspect that output without publishing.
Run `mise x -- npm run e2e:cloudflare` to check the Worker and Linux container together.
The suite owns port 8787 and refuses an existing listener.
Run `mise x -- just service-check` for the complete local service gate, including the proof inventory and all browser suites.

## Production publication

The configured production origin is `https://dial.page`.
The custom domain belongs to the Worker, which delegates directory requests to one immutable Rust container.
Workers.dev and preview URLs remain disabled.

The Doppler project is `public-phonebook`, and its production config is `prd`.
Run `mise x -- doppler setup --no-interactive` to select the committed defaults.
The config supplies `CLOUDFLARE_ACCOUNT_ID` without committing the account selector.
The application has no runtime secrets.
Manual publication uses the maintainer's existing Cloudflare OAuth session.
There is no stored Cloudflare API token, GitHub deployment secret, or automatic publishing job.
Any future automation credential must come from Doppler with an explicit consumer and scope.

Publish only a clean, signed source revision after its checks pass.
Retain the prepared snapshot manifest and the current source-bound proof and corpus-replay receipts.
Run `mise x -- just cloudflare-build` on that revision.
Run `mise x -- just cloudflare-deploy --tag VERIFIED_SOURCE_SHA --message 'Verified production candidate'` to publish the prebuilt output.
Replace `VERIFIED_SOURCE_SHA` with the full checked commit identity.
The command fetches only the account selector through Doppler, refuses a failed fresh fetch, and does not use cached fallback configuration.

Run `mise x -- just e2e-production` against the public HTTPS origin after publication.
This reuses the 14 Cloudflare workflows with Chromium and an emulated iPhone, then downloads and reconciles the complete national CSV once.
It starts no local server and validates the prepared manifest and exact static asset bytes.
Retain its videos, traces, screenshots, Worker version, container image, source revision, and snapshot identity with the deployment record.

The GitHub `Checks` workflow runs the project's fast gate without deployment credentials.
Pull requests and merge groups run it automatically.
Manual dispatch verifies the initial default-branch publication without a duplicate push trigger.
The required `Checks` job depends on successful verification, including workflow lint, strict types, behavior tests, dependency and secret scans, and the monochrome browser gate.
Formal proofs, parser corpus replay, complete browser suites, and national data checks remain part of candidate verification.

No workflow publishes GitHub releases.
Future releases must remain drafts until every final asset and its verification evidence is attached.
Publish each release once and never replace published assets or move its tag.

## Data and recovery

`snapshot.json` identifies the exact database, contact count, source count, and generation time.
The public health response, search feed, source details, and response headers identify the same database hash.
A missing or mismatched manifest prevents the prepared service from starting.
Raw publication archives stay in the offline data workspace.
The runtime image contains read-only data and no update credentials.

Replace data by building and checking a new immutable image.
Retain the previous image identity for rollback.
Import failures and audit failures must leave the active snapshot intact.
A deployment must include its image identity, snapshot manifest, source-bound proof receipt, dependency checks, and browser evidence.

## Public boundary

The service accepts GET and HEAD.
It has no accounts, private contact uploads, write API, cookies, analytics scripts, or third-party font requests.
The Worker forwards only Accept and If-None-Match.
The app uses a restrictive content security policy, explicit cache rules, no-referrer policy, and generated correlation IDs.
Searches and exports have separate bounded capacity.
A busy service returns 503 and Retry-After instead of accumulating an unbounded work queue.

Worker invocation logs are disabled and query strings are redacted in observability configuration.
Rust logs contain route patterns rather than user-supplied paths or search text.
Container egress and SSH are disabled in configuration.
The Durable Object policy gives container processes root capabilities regardless of their user ID.
File ownership and mode bits express the intended read-only layout but do not establish a production isolation boundary.
The HTTP service exposes no process execution API and opens the prepared database read-only.
The offline importer uses an HTTPS-only transport.

CSV text cells with declared formula-leading characters receive a leading apostrophe.
Canonical telephone cells are validated separately and retain their international representation.
JSON preserves original text.
Spreadsheet software can reinterpret CSV when saving or reopening it, so the prefix is not a universal spreadsheet security guarantee.
The precise CSV boundary is recorded in [verification](verification.md).

## External verification boundary

The production domain is public configuration, and the account selector remains in Doppler.
Cloudflare controls certificates, runtime isolation, infrastructure, and billing.
Local proof receipts cover only the documented Rust core and source identities.
Local tests do not establish production capacity, platform isolation, or physical contact-import compatibility.
The [architecture decision](adr/immutable-rust-snapshots-on-cloudflare.md) records those assumptions.
