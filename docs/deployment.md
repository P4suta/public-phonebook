# Local operation and Cloudflare environments

The application uses native Workers, D1, and R2.
Publication prepares isolated resources and checks a staging candidate before production promotion.
Per-environment receipts and HTTPS checks establish deployment status.

## Install and verify

```sh
mise install
mise x -- npm ci --ignore-scripts
mise x -- npm run browsers
mise x -- just check
```

The fast check needs no Cloudflare account, secret, or national database.
It creates an isolated fixture database and R2 bucket under `.local/check-state`.
Its browser server uses port 8790 and cannot overwrite the national development state.

## Prepare national data

The retained source publication is an indexed SQLite archive.
The TypeScript adapter reads it without modifying it and creates a separate native D1-compatible database and complete downloads.
The archived collection is data input, not a runtime dependency on Rust.

```sh
mise x -- just data-prepare /path/to/public-snapshot.sqlite .local/phonebook
mise x -- npm run data:check -- .local/phonebook
mise x -- just data-local .local/phonebook
mise x -- just dev
```

Open http://127.0.0.1:8787/.
Stop the local server before replacing its data.
The seeder verifies the ready manifest, every record, source references, indexes, counts, database integrity, archive byte lengths, and hashes before activation.
It discovers the pinned local D1 namespace using a unique marker rather than a hard-coded SQLite filename.
The database is copied only after Miniflare closes its handles.
R2 receives content-addressed archive keys before the replacement database becomes active.
The original source remains read-only.
A failed preparation never produces a ready manifest.
The native TypeScript collector and overlay preparation are described in [data sources](data-sources.md).

For a built local preview, run `mise x -- just build` followed by `mise x -- npm run preview`, then open https://127.0.0.1:8787/.
The preview serves the build from workerd over HTTPS with Miniflare's self-signed loopback certificate, so the browser shows a certificate warning.
It sends the Brotli search index unchanged, as production does.
The browser campaign `mise x -- just e2e` uses the same preview, so build first.
Both development and preview run the native Cloudflare Workers runtime with local D1 and R2 bindings.
Development serves HTTP through Vite, so WebKit doesn't receive the Brotli index there and the page searches on the server.
Use development for a loopback HTTP origin, such as the iOS screenshot command, because simulators reject the preview's self-signed certificate.
No Container is needed.

### Snapshot deltas

Name the retained earlier bundles when you prepare a new snapshot, and preparation writes a delta from each of them to the new archive.

```sh
mise x -- npm run data -- prepare /path/to/public-snapshot.sqlite .local/next --delta-base .local/phonebook --delta-base .local/previous
```

A delta base is a prepared bundle, such as one that `just data-fetch` restored for the active or the rollback dataset.
Preparation checks each base archive with its own manifest before it starts, so a wrong base fails at once and leaves no output.
It decodes one base at a time, applies each delta to its base, and requires the exact new archive before it records the delta.
It skips a delta whose Brotli bytes exceed half of the complete archive, and it logs the sizes of every delta it considers.
The ready manifest lists the published deltas, so the dataset digest covers them, and `just data-remote` uploads them with the other archives.
The `just data-prepare` recipe doesn't take delta bases yet, so use the `npm run data` form for them.
The hosted release can't generate deltas until `release.yml` exists, and that workflow needs to fetch the retained bundles before preparation.

## Environment boundaries

| Environment | Worker | Database | Bucket | Site |
| --- | --- | --- | --- | --- |
| development | dial-development | dial-development-directory | dial-development-datasets | 127.0.0.1:8787 |
| staging | dial-staging | dial-staging-directory-DIGEST | dial-staging-datasets | staging.dial.page |
| production | dial-production | dial-production-directory-DIGEST | dial-production-datasets | www.dial.page |

`src/core/environment.ts` is the source of these identities.
The apex has no application domain assignment.
`cloudflare.config.ts` derives typed bindings through the pinned cf configuration API.
The project uses cf rather than Wrangler for Cloudflare project operations.
Vite's build API handles the full client and Worker build locally, and `tools/built-worker-server.ts` serves the build.
The CLI and plugin are beta dependencies, so upgrades require the native integration checks.

Secrets belong in Doppler.
The checked-in Doppler configuration identifies the existing project and account configuration; it grants no deployment authority.
Public reads have no application secret.
The commands use Doppler for account selection and the existing cf OAuth profile for provider authentication.
Enable R2 in the Cloudflare account before the first remote preparation.

## Prepare and publish

### Staging access

Staging requires Cloudflare Access across every path.
The initial reviewer is the Cloudflare account owner, using the existing one-time PIN identity provider.
Additional reviewers require the Access email policy and `ACCESS_REVIEWERS` in Doppler `stg` to agree.
Production remains anonymous.

Run `tools/staging-access.ts configure` through Doppler `stg`, inheriting the account selector from `prd` during first setup.
This creates only the staging application and its 90-day verification identity and stores credentials directly in Doppler.
Run `tools/staging-access.ts check` with Doppler `stg` to reject broader policies, mismatched identities, expired tokens, and public R2 endpoints.
No automation secret belongs in a browser context, URL, artifact, or Worker binding.

For rotation, create a replacement staging service token in Cloudflare Access, store its ID, client ID, and secret in Doppler `stg`, and update the application's service policy to its exact token ID.
Rebuild staging with the matching public client ID, verify both authenticated and anonymous behavior, then revoke the preceding token.
During an Access outage, stop publication and repair the configured identity or policy through the provider console.
Do not enable anonymous bypass or restore an expired token for recovery.
The [staging authorization decision](adr/authenticate-the-entire-staging-origin.md) explains the shared boundary.

### Release inputs

Every publication names its dataset by the SHA-256 of its ready manifest.

```sh
mise x -- just release DATASET
```

The release command dispatches `release.yml` on `main` with the dataset input, finds the dispatched run, and watches it.
It never publishes from the local machine and never adopts or bootstraps an environment on its own.
Production publishes only from that workflow, with candidate evidence for the same Git tree and manifest.
The publisher refuses a local production publication, while `just recover` and `just release-status` stay available locally.

| Command | Inputs | Effect |
| --- | --- | --- |
| `just publish staging DATASET [BUNDLE]` | Dataset digest, optional bundle | Publishes staging from a clean checkout |
| `just publish-admission ENV DATASET [BUNDLE]` | Environment, dataset digest | Runs every admission check without a lease, build, or provider effect |
| `just data-fetch DATASET DIRECTORY` | Dataset digest, target directory | Restores the bundle from the control store and checks every file |
| `just test --bundle DIRECTORY --stage STAGE` | Bundle, stages | Runs selected stages of the gate and writes one receipt per stage |

The bundle defaults to `.local/datasets/DATASET`, which `just data-fetch` fills.
The publisher refuses a bundle whose manifest digest differs from the named dataset.
The stages are `check`, `data`, `phones`, `prove`, and `e2e`, and each passing stage writes `.local/receipts/TREE/MANIFEST/STAGE.json`.
A run of every stage also writes the combined local receipt that staging publication requires.
In GitHub Actions, `--record` stores each passing stage as candidate evidence under `candidates/TREE/MANIFEST/`.
A local run can't record candidate evidence, so a local receipt never stands in for the release gate.
Production admits a candidate only when every stage has passing evidence for the same tree and manifest from `candidate.yml` on `main`.
Normal preparation and publication require canonical addresses.

For a private failure exercise, run `mise x -- just release-rehearse .local/phonebook` after the full local gate.
It derives a real subset from the supplied directory, retaining every populated category and prefecture plus the fixed verification contacts.
The exact subset size depends on the input.
It publishes A, activates B, injects the expected verification failure, verifies A again, and then publishes B normally.
The exercise affects staging only.

The data command validates the complete local bundle before remote writes.
It uploads content-addressed archives and the manifest through the S3 API, only to the environment's private R2 bucket and only under new archive keys.
It creates a missing bucket only outside CI, and a CI run without the bucket stops for the owner.
It imports bound SQL batches through the pinned cf CLI, within D1's parameter and request budgets.
An import identity and checkpoint commit in the same native D1 transaction as each batch.
A lost acknowledgement can resume from the stored checkpoint without duplicate inserts.
An unowned database or a different publication is refused rather than overwritten.
A database identity includes the first 32 hexadecimal characters of its complete database SHA-256.
The full digest remains the import identity, so a prefix collision cannot overwrite a different publication.
Repeated preparation reuses the exact database artifact and preserves earlier database resources.
The final checks compare counts, foreign keys, the complete catalog, and fixed payload samples with the validated source.

The publisher requires a clean committed checkout and a verified remote-data receipt.
Staging also requires current full-test and proof receipts from the local gate.
Production requires admitted candidate evidence instead, and the identical active verified staging Git tree, contact snapshot, database SHA-256, and manifest SHA-256.
Tree identity allows a merge commit to preserve an already checked candidate when its files are unchanged.
Each environment is rebuilt with its own bindings and origin before the prebuilt cf deployment.
The cf deployment applies the Worker's triggers, including custom domains.
HTML responses use `no-store, no-transform` to prevent Cloudflare from adding scripts to the document.
Browser checks reject scripts from other origins and verify that an inserted external script is detected.
The publisher hashes build output before deployment and after provider provisioning.
Public Playwright checks exercise desktop and narrow search, telephone formatting, detail and provenance navigation, the interactive Scalar client, accessibility, security-policy failures, and the 512-byte query boundary.
They also download every archive through HTTPS and compare its byte length and SHA-256 with the checked manifest.
Failure evidence stays under `test-results`.

### Control store

Publication records live in the private R2 bucket `dial-control`, which the tools reach through the S3 API.
The tools read `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` from the environment and never print them.
Conditional writes keep one writer per object: a create sends `If-None-Match: *`, a replacement sends `If-Match` with the stored entity tag, and R2 answers 412 to the loser.

| Key | Contents | Writes |
| --- | --- | --- |
| `blobs/sha256/DIGEST` | Databases and archives | Once |
| `datasets/MANIFEST/` | Ready manifest and catalog for verification | Once |
| `collections/REPORT/` | Collection outputs, source artifact list, and prepared dataset link | Once |
| `collection-cache/DIGEST` | Source bytes of a collection | Once |
| `candidates/TREE/MANIFEST/STAGE.json` | Candidate evidence per stage | Once |
| `journals/ENV/head.json` | Current publication journal | Conditional replacement |
| `journals/ENV/history/SEQUENCE.json` | Every journal record | Append-only, bucket lock |
| `leases/ENV.json` | Publication lease | Conditional replacement |
| `evidence/` | Imported receipts and release evidence | Append-only, bucket lock |

Journal format 2 records the environment, sequence, phase, candidate, predecessor, and run provenance.
The provenance names the Actions repository, workflow, run ID, attempt, commit, and actor, or `local` for owner recovery.
Verification reads the manifest and catalog from `datasets/MANIFEST/`, so the journal holds no local path.
Each publication command holds the environment's lease, which lasts 10 minutes, renews every 60 seconds, and expires by R2's response time.
A second publisher is refused while the lease is live and can take it over after it expires.
The [control bucket decision](adr/keep-release-records-in-a-conditionally-written-control-bucket.md) explains the format and the lease.
The `Collect` workflow writes the collection keys and a prepared dataset from the `data` environment, as [data sources](data-sources.md#collection-in-github-actions) describes.

Import the owner's format 1 records once, after checking the plan.

```sh
mise x -- just control-import ../public-phonebook-typescript/.local --plan
mise x -- just control-import ../public-phonebook-typescript/.local
```

The plan prints each history record, dataset, verified blob, and receipt with its key, size, and digest, and it writes nothing.
The import converts a journal only when its bundle name and manifest bytes match the recorded manifest digest.
It refuses to replace a different journal head, and repeating it changes nothing.
Run the second command with the control-store credentials in the environment.

The previous Worker and its data remain available while the new staging service is checked.
The publication journal in the control store records the predecessor's exact version and bindings before activation.
Failure restores the complete predecessor and verifies it before recording recovery.
`mise x -- just release-status staging` reads the journal and active provider version.
`mise x -- just recover staging` retries interrupted recovery without building or deploying a new candidate.
Replace `staging` with `production` for public recovery.
An unrelated active deployment is refused rather than overwritten.
Repair access or provider availability before retrying failed verification.

### Worker versions

The provider reads a deployment that routes 100% to the current version and 0% to at most one candidate, in either order.
It reports both versions with their release tags, and it refuses any other split, because traffic moves from 0% to 100% in one step.
Every Worker response carries `x-dial-version` with the answering version ID from `CF_VERSION_METADATA`.
A check of a 0% candidate compares this header with the candidate's ID, because Cloudflare routes a request whose override doesn't apply to the current version without an error.

The first staging publication requires `--bootstrap` with `--dataset` and has no verified rollback target.
If its activation succeeded but verification was interrupted, run `doppler run --project public-phonebook --config stg --no-fallback -- node tools/publish.ts staging --resume-bootstrap`.
It accepts only the owned active initial candidate and its original committed source.
If that candidate failed verification, run `--bootstrap` again from corrected committed source.
It supersedes the failed candidate only while no staging publication is verified and the failed candidate still owns the active version.
Do not discard journals or edit them to make a foreign deployment pass.

`mise x -- just release-retention production` prints a read-only database retirement plan.
Active, rollback, and pending resources remain protected, and all published R2 download URLs remain retained.
The command never deletes resources.
The control store keeps the journals and verification bundles for recovery.
Provider provisioning, network delivery, and the truth of upstream records remain external trust boundaries.
Read the [recovery decision](adr/recover-complete-worker-and-dataset-publications.md), [promotion decision](adr/source-tree-bound-staging-promotion.md), and [verification contract](verification.md) for their checks and limits.

## Dependency updates

Renovate merges minor and patch updates on its own once the required checks pass, except for the ones a publication depends on.
The `deployment dependencies` group holds updates that change the deployed Worker, its build, or a release path, and labels them `release-rehearsal`.
It covers cf, Miniflare, `@cloudflare/*`, TanStack Start with the router release it pins, Vite and its plugins, vanilla-extract, PostCSS, and aws4fetch.
It also covers the `node`, `just`, `doppler`, `rust`, and `xcodegen` tools and the GitHub Actions of the TestFlight workflow and the toolchain action.
The Linux check image's mise moves with them, because `just check-linux` refuses a mise that differs from the toolchain action's.
npm lock file maintenance waits in its own branch, because it moves the bundler and CSS tools that Vite resolves within ranges.
Merge such an update only after `mise x -- just release-rehearse .local/phonebook` passes on its branch after the full local gate.
That recipe runs `tools/release-rehearsal.ts`, which publishes a real subset and then the full data to staging.
When it changes the TestFlight workflow or its tools, also run `mise x -- just ios-archive`.
The hosted rehearsal replaces the local one once `release.yml` lands, and each new deployment workflow's actions join the group then.
Major updates already wait for the owner and need the same rehearsal.
Vulnerability fixes still merge on their own, because the shared preset forces automerge for them.

## Support mail

The `/support` and `/privacy` pages publish `support@dial.page` as the only contact address.
Cloudflare Email Routing on the `dial.page` zone forwards it to a verified private destination that stays out of this repository.
Before publishing a change that shows the address, confirm that the zone's routing is enabled and that the `support@dial.page` rule forwards to a verified destination.
Point the iPhone app's App Store support URL and in-app help at `https://www.dial.page/support`.
The zone publishes `v=DMARC1; p=reject; adkim=s; aspf=s` at `_dmarc.dial.page`, because the domain sends no mail and messages that claim to come from it are spoofed.

## Zone protection

The zone's rate limiting rule blocks a client IP for 10 seconds after 60 requests in 10 seconds to `/`, `/api/contact*`, or `/api/v1/contact*`.
The block answers 429 with `Retry-After` and sets no cookie, which keeps the privacy page accurate.
Don't use a managed challenge or Bot Fight Mode on these hosts, because they set cookies.
The rule matches paths only, so it also covers staging, where verification sends far fewer requests than the limit.
A single redirect rule sends `https://dial.page/` with its path and query to `https://www.dial.page/` with status 301, through a proxied apex record.
Browsers enforce HTTPS on every `.page` host through the preloaded top-level domain, so the Worker sets no HSTS header of its own.
