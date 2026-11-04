# Local operation and publication from GitHub Actions

The application uses native Workers, D1, and R2.
Production publishes only from the `Release` workflow on `main`, which checks the candidate version at 0% inside the production Worker and moves traffic after the owner approves it.
Each release ends with an immutable GitHub release that holds its evidence, checksums, dataset identity, SBOM, provenance, and approval.
Local commands prepare and inspect data, start a release, and withdraw or recover a publication.

## Install and verify

```sh
mise install
mise x -- npm ci --ignore-scripts
mise x -- npm run browsers
mise x -- just check
mise x -- just check-build
```

The fast check and the build checks need no Cloudflare account, secret, or national database.
The build checks create an isolated fixture database and R2 bucket under `.local/check-state`.
Their browser server uses port 8790 and cannot overwrite the national development state.

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
`just data-prepare` takes a directory whose subdirectories are the bases as its fourth argument.

```sh
mise x -- just data-prepare /path/to/public-snapshot.sqlite .local/next "" .local/delta-bases
mise x -- npm run data -- prepare /path/to/public-snapshot.sqlite .local/next --delta-base .local/phonebook --delta-base .local/previous
```

A delta base is a prepared bundle, such as one that `just data-fetch` restored for the active or the rollback dataset.
A base needs only its ready manifest and `directory.tsv.br`.
A base at the new snapshot gets no delta, and preparation logs it.
Preparation checks each base archive with its own manifest before it starts, so a wrong base fails at once and leaves no output.
It decodes one base at a time, applies each delta to its base, and requires the exact new archive before it records the delta.
It skips a delta whose Brotli bytes exceed half of the complete archive, and it logs the sizes of every delta it considers.
The ready manifest lists the published deltas, so the dataset digest covers them, and `just data-remote` uploads them with the other archives.
The `Collect` workflow chooses its bases itself, as [data sources](data-sources.md#delta-bases) describes.
The `Release` workflow publishes a stored dataset as it is, so a delta exists only when the preparation that stored the dataset wrote it.

## Environment boundaries

| Environment | Worker | Database | Bucket | Site |
| --- | --- | --- | --- | --- |
| development | dial-development | dial-development-directory | dial-development-datasets | 127.0.0.1:8787 |
| production | dial-production | dial-production-directory-IMPORT | dial-production-datasets | www.dial.page |

`src/core/environment.ts` is the source of these identities, and `tools/import-identity.ts` derives the production database's import identity.
The apex has no application domain assignment.
`cloudflare.config.ts` derives typed bindings through the pinned cf configuration API.
The project uses cf rather than Wrangler for Cloudflare project operations.
Vite's build API handles the full client and Worker build locally, and `tools/built-worker-server.ts` serves the build.
The CLI and plugin are beta dependencies, so upgrades require the native integration checks.

Secrets belong in Doppler.
The checked-in Doppler configuration identifies the existing project and account configuration; it grants no deployment authority.
Public reads have no application secret.
Local commands use the Doppler `prd` config for account selection and the owner's cf sign-in profile for provider authentication.
Workflows use one Doppler config per GitHub environment through OIDC and scoped API tokens, as the next section describes.
Enable R2 in the Cloudflare account before the first remote preparation.

## Publish from GitHub Actions

### Common rules

These rules hold for every workflow, and `tools/workflow-policy.ts` enforces the ones that a workflow file can show.
- Each workflow starts from `permissions: {}`, and each job adds only the permissions it uses, explaining each grant beyond reading the repository.
- Each action is pinned to a full commit SHA, and a script receives inputs and event values only through `env:`.
- A job that holds a secret runs only on `main`, in a protected environment, from `workflow_dispatch` or `workflow_call`.
- Its first step refuses any other ref, and it fetches only its own environment's Doppler config through OIDC.
- The owner's Doppler identities accept only the subject `repo:P4suta@42543015/public-phonebook@1438449191:environment:<env>`.
- A secret reaches only the step that uses it, never the job environment.
- One publication runs at a time, through the non-cancelling `publication-production` concurrency group and the R2 lease.
- Public logs and artifacts never hold a token, a raw secret, or an IPA, and a candidate's version ID stays masked until it takes traffic.
- A release record becomes a GitHub release once, after every asset is complete and checked.

### Release workflows

| Workflow | Start | Effect |
| --- | --- | --- |
| `candidate.yml` | Manual, or called by `release.yml` | Runs each candidate stage whose inputs have no passing evidence, in parallel, and records the stages that pass |
| `release.yml` | Manual, `dataset` and `checks` inputs | Admits evidence, builds and attests the Worker, stages it at 0%, checks it, waits for approval, promotes it, and publishes its record |
| `recover.yml` | Manual, `withdraw` or `restore` | Withdraws a candidate that never took traffic, or restores the verified predecessor after approval |
| `status.yml` | Manual | Reads the masked journal, the deployed versions, and the retention plan |
| `pipeline-controls.yml` | Manual, `dataset` input | Runs the pipeline's refusals and the withdrawal drill |

`release.yml` runs these jobs in order.
1. `candidate` calls `candidate.yml`, unless `checks` is `reuse` because every stage already has evidence for its inputs.
2. `evidence` requires passing evidence for every stage and reads the database digest from the stored manifest.
3. `build` builds the Worker without any secret, attests a tarball of the build output and its SBOM, and records its build digest.
4. `stage` verifies the attestation, prepares the D1 database and archives, and deploys the attested build at 0%.
5. `verify` checks the candidate through the version override with a read-only token.
6. `promote` waits for the `production` approval, moves traffic in one step, and checks the candidate without the override.
7. `record` assembles the release record and publishes it as a GitHub release.
8. `withdraw` removes the candidate when `verify` fails, because the read-only token leaves the withdrawal pending.

### Candidate stages

| Stage | Job | Reads | Dataset |
| --- | --- | --- | --- |
| `check` | `check` | Every tracked file | No |
| `prove` | `prove` | Every tracked file | No |
| `data` | `data`, through the fetch's bundle check | Every tracked file outside `ios`, `verification/ios`, and `tools/ios-check` | Yes |
| `phones` | `data` | The same files as `data` | Yes |
| `parity` | `parity` | The same files as `data` | Yes |
| `e2e` | `e2e` | The same files as `data` | Yes |
| `ios-prove` | `ios-prove` | The scope that `tools/ios-check` hashes, and `candidate.yml` | No |
| `ios-check` | `ios-check` on macOS | The same files as `ios-prove` | No |

`tools/stage-inputs.ts` declares these files, and each stage's evidence binds to the SHA-256 of its declaration, the Git object IDs of the files it reads, and its dataset where it reads one.
The `plan` job lists the stages without admitted evidence, and `candidate.yml` runs only those, each once, in parallel.
A page change reruns the Web stages and reuses the iOS evidence, and a new dataset reruns only the four dataset stages.
The `record` job records every listed stage whose job passed, and it then fails the run if any listed stage didn't pass, so a rerun repeats only the failed stages.
The [stage inputs decision](adr/bind-candidate-evidence-to-the-files-each-stage-reads.md) explains the declarations and their trust assumption.

Evidence counts when `candidate.yml` records it directly or inside `release.yml`, both on `main`.
A called workflow reports its caller in `GITHUB_WORKFLOW_REF`, so the admission accepts exactly these two signers.
The build job sits in the `candidate` environment only so that it can sign attestations, and it fetches no secret.

Each environment fetches its own Doppler config through OIDC, and the workflow policy refuses any other pairing.

| Environment | Doppler config | Keys | Token scope |
| --- | --- | --- | --- |
| `candidate` | `ci_candidate` | `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Read and write `dial-control` |
| `release-candidate` | `ci_release_candidate` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Workers Editor for `dial-production`, D1 Edit, and R2 on `dial-control` and `dial-production-datasets` |
| `observe` | `ci_observe` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Worker metadata and D1 read, and R2 on `dial-control` for the journal, the lease, and the release evidence |
| `production` | `ci_production` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Workers Editor for `dial-production`, and R2 on `dial-control` |

Every step that calls Cloudflare, R2, or Doppler waits for the owner, who creates the tokens, stores them in these configs, and sets `DOPPLER_IDENTITY_ID`.
Run the workflows in this order once they exist: `status.yml`, `pipeline-controls.yml`, a `release.yml` run whose approval the owner rejects, and then the first approved release.
After a rejected approval, the candidate stays at 0% until `recover.yml` withdraws it.

### Release record

After promotion, the `record` job publishes one GitHub release whose tag is `vYEAR.MONTHDAY.RUN`, such as `v2026.1102.15` for run 15 on November 2 in UTC.
It holds no token that can deploy, and it runs only after a verified promotion.

| Asset | Contents |
| --- | --- |
| `release-evidence.json` | Tree, commit, run, dataset, snapshot, release and version IDs, predecessor, build digest, candidate stage decisions, approvers, and asset digests |
| `SHA256SUMS` | The SHA-256 of every other asset |
| `manifest.ready.json`, `catalog.json` | The published dataset's identity, from `datasets/MANIFEST/` |
| `sbom.cdx.json` | CycloneDX list of every locked production npm package with its version, purl, license, and integrity digest |
| `worker-build.tar` | The attested Worker build that took traffic |
| `attestations.jsonl` | The build provenance and SBOM attestation bundles for that tarball |
| `approval.json` | The `production` environment reviews of the run |

The job verifies both attestations and requires an approval of `production` with no rejection.
It requires the journal's verified release to come from the checked-out tree and every candidate stage to be admitted.
It writes the evidence to the control store's append-only `evidence/releases/` prefix as well, so it outlives GitHub's artifact retention.
It creates a draft, downloads the draft's assets, requires them to match `SHA256SUMS` exactly, and then publishes the release once.

Anyone can check a published release.

```sh
mise x -- just release-verify v2026.1102.15 target/release-check
```

The command downloads the assets, checks every digest, and verifies the provenance and SBOM attestations against `release.yml` on `main`.
The SBOM lists the locked production dependencies, not the exact modules that the bundler kept, and an attestation doesn't make that list accurate.

The owner turns on Immutable Releases in the repository settings and adds a tag ruleset that keeps `v*` tags for the release workflow.
Until then, a published release can still change, so the record depends on nobody editing it.

### Candidates in the production Worker

There is no staging environment.
A candidate is a new version of `dial-production` that waits at 0% beside the current version until the owner approves it.

1. The data command prepares the candidate's D1 database under its import identity and the archive keys under their digests.
   A candidate of the served dataset and import transformation shares the current version's database, which the command then reads only by primary key.
2. `--stage` uploads the attested build with `cf workers versions create`, tagged with a new release ID, and deploys it at 0%.
3. `--verify-candidate` runs the public checks on `www.dial.page` with `Cloudflare-Workers-Version-Overrides` aimed at the candidate.
4. The release workflow waits for the owner's approval of the GitHub `production` environment.
5. `--promote --release RELEASE_ID` moves traffic from 0% to 100% in one step and runs the checks again without the override.
   A failure restores the verified predecessor and checks it again.

The journal records `preparing`, `staged`, and `candidate-verified` before approval.
Any failure before approval withdraws the candidate, records `withdrawing` and `withdrawn`, and leaves the current version and the verified predecessor unchanged.
A withdrawal from a job with a read-only token stays pending in `withdrawing`, and the next `--withdraw` completes it.
While a candidate awaits approval, the tools refuse every new deployment and mask its version ID in Actions logs and status output.
Run `mise x -- just withdraw production` to withdraw it.
GitHub's approval expires after 30 days, after which the candidate stays at 0% until someone withdraws it.

Every check sends its requests from Node and refuses a response whose `x-dial-version` names another version.
The browser checks route each same-origin request through the same client, so pages, assets, and API calls all carry the override.
Before the checks start, three consecutive requests must reach the expected version.
The checks share a ledger that counts requests in a sliding 10-second window and holds any request that would be the 40th.
A held request waits up to one window and logs its wait as `probe.hold`, so each wait in the checks allows three windows.
Failure artifacts never contain the candidate's version ID, and the artifact audit refuses any that do.

Rehearse the public checks before a change to them or to the pages they visit reaches a workflow.

```sh
mise x -- just public-rehearsal .local/phonebook
```

The rehearsal builds the site, seeds `.local/rehearsal-state` from the bundle, and serves the build on `https://127.0.0.1:8791`.
Node verifies the preview through a one-day loopback certificate instead of skipping TLS verification.
The checks keep their workers, probe budget, routing, and version check, and the request client admits the loopback origin only in a rehearsal.
Only the version override and production's network stay outside the rehearsal.

The tools refuse a candidate whose built configuration changes domains, routes, cron triggers, `runWorkerFirst`, `workers.dev`, or preview URLs.
They compare the build with the live Worker's domains and subdomain settings and the serving version's Worker-first routing.
Routes and cron triggers can't be read back, so the build must declare none.
Apply a Worker-wide change separately with the owner's `cf` profile, and then publish a candidate whose configuration matches it.

`--drill` stages a candidate, runs its checks, injects a probe failure, and requires the withdrawal to leave production unchanged.
`pipeline-controls.yml` runs it on an attested build before the first approved publication and after each held deployment dependency update.
The [in-place verification decision](adr/verify-release-candidates-in-place-before-approval.md) explains the conditions and the remaining weaknesses.

### Release inputs

Every publication names its dataset by the SHA-256 of its ready manifest.

```sh
mise x -- just release DATASET
```

The release command dispatches `release.yml` on `main` with the dataset input, finds the dispatched run, and watches it.
It never publishes from the local machine and never adopts or bootstraps an environment on its own.
Production publishes only from that workflow, with candidate evidence for the files each stage reads and the manifest.
The publisher refuses a local `--stage`, `--verify-candidate`, `--promote`, `--drill`, or `--adopt`.
`just withdraw`, `just recover`, and `just release-status` stay available locally.

| Command | Inputs | Effect |
| --- | --- | --- |
| `just publish-admission production DATASET [BUNDLE]` | Dataset digest | Runs every admission check without a lease, build, or provider effect |
| `just withdraw production` | None | Withdraws a candidate that never took traffic |
| `just release-verify TAG DIRECTORY` | Release tag, target directory | Downloads a published release record and checks its digests and attestations |
| `just data-fetch DATASET DIRECTORY` | Dataset digest, target directory | Restores the bundle from the control store and checks every file |
| `just public-rehearsal BUNDLE` | Bundle | Runs the public checks on the built preview with the bundle's data |
| `just test --bundle DIRECTORY --stage STAGE` | Bundle, stages | Runs selected stages of the gate and writes one receipt per stage |

The bundle defaults to `.local/datasets/DATASET`, which `just data-fetch` fills.
The publisher refuses a bundle whose manifest digest differs from the named dataset.
Each passing stage writes `.local/receipts/INPUTS/STAGE.json`, and a stage that reads no dataset needs no bundle.
Each passing complete data check writes `.local/receipts/data-check/KEY.json` with the size and SHA-256 of every file it read.
The key combines the `data` stage's inputs digest, which covers the manifest, with the address forms that the check admits.
A later check in the same clean checkout reuses that result only while every one of those files keeps its recorded size and SHA-256.
A dirty tree or a directory outside Git always runs the complete check.
Each workflow job starts from a fresh checkout without receipts, so its first data check runs in full.
The `check` stage runs `just check` and then `just check-build`, so the evidence keeps the build and the checks that pull requests skip.
The `ios-check` stage needs macOS with Xcode, so a local run on Linux selects the other stages.
A run of every stage also writes the combined local receipt.
Only the `record` job of `candidate.yml` stores candidate evidence, so a local receipt never stands in for the release gate.
Production admits a candidate only when every stage has passing evidence for its inputs from `candidate.yml` on `main`.
Normal preparation and publication require canonical addresses.

The data command validates the complete local bundle before remote writes.
It uploads content-addressed archives and the manifest through the S3 API, only to the environment's private R2 bucket and only under new archive keys.
It creates a missing bucket only outside CI, and a CI run without the bucket stops for the owner.
It imports bound SQL batches through the pinned cf CLI, within D1's parameter and request budgets.
An import identity and checkpoint commit in the same native D1 transaction as each batch.
A lost acknowledgement can resume from the stored checkpoint without duplicate inserts.
An unowned database or a different publication is refused rather than overwritten.
The import identity is the SHA-256 of the database SHA-256 and the digest of the import transformation.
The transformation digest covers the D1 schema, the seeded columns, the fold table of the comparison form, and a declared derivation revision.
A database name includes the first 32 hexadecimal characters of the import identity.
The full import identity fills `__dial_import`, so a prefix collision can't overwrite a different publication.
Repeated preparation of the same dataset on the same transformation reuses the exact database and preserves earlier database resources.
A changed dataset, schema, column list, fold table, or derivation revision gets a new database, a full import, and a full verification.
Before it reads the database, the command reads the publication journal and the database's verification evidence from the control store, and it stops when the journal is missing.
A journal target binds a database only through the D1 ID that its Worker version holds.
Only a database that no Worker version binds receives the full checks, which compare counts, foreign keys, the complete catalog, and fixed payload samples with the validated source.
A passing full check writes evidence once under `evidence/databases/IMPORT/ID.json`.
A later preparation accepts that evidence, or the journal's digest-bound publication of the same database, after it reads the import identity, the checkpoints, the catalog row, and the fixed samples by primary key.
It refuses a bound database without either, evidence for another database, and an incomplete database that evidence or a binding names.
Only an unbound database receives a read again after D1 reports an overload.
The [database verification decision](adr/verify-each-database-once-before-a-worker-binds-it.md) explains the rule and why a publication counts as evidence.
The [import identity decision](adr/identify-each-d1-database-by-its-dataset-and-import-transformation.md) explains what a database name covers.

The publisher requires a clean committed checkout, a verified remote-data receipt, and admitted candidate evidence.
Inputs identity lets a merge commit keep an already checked stage when the files that stage reads are unchanged.
The `build` job builds the candidate with production bindings and origin and no secret, and `--artifact` names that build by its digest.
The upload creates a version without applying triggers, so custom domains and other Worker-wide settings stay as the owner last applied them.
HTML responses use `no-store, no-transform` to prevent Cloudflare from adding scripts to the document.
Browser checks reject scripts from other origins and verify that an inserted external script is detected.
The publisher hashes build output before the upload and after it.
Public Playwright checks exercise desktop and narrow search, telephone formatting, detail and provenance navigation, the data page's file list, accessibility, security-policy failures, and the 512-byte query boundary.
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
| `candidates/INPUTS/STAGE.json` | Candidate evidence per stage, keyed by its inputs digest | Once |
| `journals/ENV/head.json` | Current publication journal | Conditional replacement |
| `journals/ENV/history/SEQUENCE.json` | Every journal record | Append-only, bucket lock |
| `leases/ENV.json` | Publication lease | Conditional replacement |
| `evidence/` | Imported receipts, release evidence, and database verification evidence | Append-only, bucket lock |

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

The previous version and its data keep serving while the candidate is checked at 0%.
The publication journal in the control store records the predecessor's exact version and bindings before the upload.
A failure after approval restores the complete predecessor and verifies it before recording recovery.
`mise x -- just release-status production` reads the journal and the deployed versions, with a waiting candidate's version ID masked.
`mise x -- just recover production` withdraws an interrupted candidate or restores the predecessor without building or deploying a new candidate.
It refuses a candidate that awaits approval, which only `just withdraw` removes.
An unrelated active deployment is refused rather than overwritten.
Repair provider availability before retrying failed verification.

### Worker versions

The provider reads a deployment that routes 100% to the current version and 0% to at most one candidate, in either order.
It reports both versions with their release tags, and it refuses any other split, because traffic moves from 0% to 100% in one step.
Every Worker response carries `x-dial-version` with the answering version ID from `CF_VERSION_METADATA`.
A check of a 0% candidate compares this header with the candidate's ID, because Cloudflare routes a request whose override doesn't apply to the current version without an error.

Every publication needs a verified predecessor in the journal, and no command starts an environment without one.
Do not discard journals or edit them to make a foreign deployment pass.

`mise x -- just release-retention production` prints a read-only database retirement plan.
Active, rollback, and pending resources remain protected, and all published R2 download URLs remain retained.
The command never deletes resources.
The control store keeps the journals and verification bundles for recovery.
Provider provisioning, network delivery, and the truth of upstream records remain external trust boundaries.
Read the [recovery decision](adr/recover-complete-worker-and-dataset-publications.md), [in-place verification decision](adr/verify-release-candidates-in-place-before-approval.md), and [verification contract](verification.md) for their checks and limits.


## Dependency updates

Renovate merges minor and patch updates on its own once the required checks pass, except for the ones a publication depends on.
A Cargo update changes `tools/ios-check`, so the Rust job of the required checks compiles, lints, tests, and audits that crate first.
The `deployment dependencies` group holds updates that change the deployed Worker, its build, or a release path, and labels them `release-rehearsal`.
It covers cf, Miniflare, `@cloudflare/*`, TanStack Start with the router release it pins, Vite and its plugins, vanilla-extract, and aws4fetch.
It also covers the `node`, `just`, `doppler`, `rust`, and `xcodegen` tools and the GitHub Actions of the TestFlight workflow, the release workflows, and the toolchain action.
The Linux check image's mise moves with them, because `just check-linux` refuses a mise that differs from the toolchain action's.
npm lock file maintenance waits in its own branch, because it moves the bundler and CSS tools that Vite resolves within ranges.
Merge such an update only after the owner reviews it, and run the withdrawal drill in `pipeline-controls.yml` on `main` before the next release.
The drill stages the updated build at 0% in production, checks it, and withdraws it without moving traffic.
When it changes the TestFlight workflow or its tools, also run `mise x -- just ios-archive`.
Major updates already wait for the owner and need the same rehearsal.
Vulnerability fixes still merge on their own, because the shared preset forces automerge for them.

## Support mail

The `/support` and `/privacy` pages publish `support@dial.page` as the only contact address.
Cloudflare Email Routing on the `dial.page` zone forwards it to a verified private destination that stays out of this repository.
Before publishing a change that shows the address, confirm that the zone's routing is enabled and that the `support@dial.page` rule forwards to a verified destination.
Point the iPhone app's App Store support URL and in-app help at `https://www.dial.page/support`.
The zone publishes `v=DMARC1; p=reject; adkim=s; aspf=s` at `_dmarc.dial.page`, because the domain sends no mail and messages that claim to come from it are spoofed.

## Zone protection

The zone's rate limiting rule blocks a client IP for 10 seconds after 60 requests in 10 seconds to `/`, `/api/contact*`, `/api/source*`, `/api/catalog`, `/api/search-index*`, or `/contacts/`.
The site routes rely on this rule for every client that omits `Sec-Fetch-Site`, as [the route split decision](adr/serve-directory-json-to-the-site-only.md) explains.
The block answers 429 with `Retry-After` and sets no cookie, which keeps the privacy page accurate.
Don't use a managed challenge or Bot Fight Mode on these hosts, because they set cookies.
Release checks hold any request that would be their 40th in 10 seconds, so they stay below the limit.
A single redirect rule sends `https://dial.page/` with its path and query to `https://www.dial.page/` with status 301, through a proxied apex record.
Browsers enforce HTTPS on every `.page` host through the preloaded top-level domain, so the Worker sets no HSTS header of its own.

## Uptime checks

Better Stack checks the public site every three minutes from its four regions, and it emails the team when a check fails.
`tools/uptime-plan.ts` declares the checks, and each one requires text that only a page with its data emits.

| Check | Address | Required text |
| --- | --- | --- |
| Top page | `https://www.dial.page/` | The search button label |
| Search | The server-rendered results for 東京都庁 | `03-5321-1111`, which needs the database |
| App data index | `https://www.dial.page/api/datasets` | `public-phonebook-directory/1`, the archive format that the iPhone app reads for updates |

Run `mise x -- just monitors` to print the plan, and `mise x -- just monitors --apply` to create or update the declared checks.
The command matches checks by name, never deletes one, and lists every check it doesn't manage.
It reads the team-scoped `BETTER_STACK_API_TOKEN` from the Doppler `prd` config, sends it only to the Better Stack monitors API, and prints no token.
No workflow runs the command, so a change to the checks takes effect when the owner or an agent applies it after merge.

## Cloudflare notifications

`tools/cloudflare-alerts-plan.ts` declares the account's notification policies for the service, and each one emails `CLOUDFLARE_ALERT_EMAIL` from the Doppler `prd` config.

| Policy | Alert type | Fires when |
| --- | --- | --- |
| Worker issues | `workers_observability_real_time_issue` | Workers Observability finds an issue in any Worker of the account |
| HTTP DDoS attacks | `dos_attack_l7` | Cloudflare mitigates an HTTP DDoS attack on a zone of the account |
| Universal SSL | `universal_ssl_event_type` | A Universal SSL certificate changes state |
| D1 rows read | `billing_usage_alert` | D1 reads 12.5 billion rows in a month, half of what Workers Paid includes |
| D1 rows written | `billing_usage_alert` | D1 writes 25 million rows in a month, half of what Workers Paid includes |

The account's earlier billing policies for Workers and R2 and its budget alert stay outside the declarations.
Run `mise x -- just cloudflare-alerts` to print the plan, and `mise x -- just cloudflare-alerts --apply` to create or update the declared policies through the owner's cf sign-in.
The command manages only policies whose names start with `Public Phonebook`, never deletes one, and prints no address.
`tools/declared-plan.ts` holds the plan that both commands share.
