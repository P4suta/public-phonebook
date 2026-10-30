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
The old collector's network update commands are retired; this implementation consumes a complete, separately collected publication.

For a built local preview, run `mise x -- just build` followed by `mise x -- npm run preview`.
Both development and preview run the native Cloudflare Workers runtime with local D1 and R2 bindings.
No Container is needed.

## Environment boundaries

| Environment | Worker | Database | Bucket | Site |
| --- | --- | --- | --- | --- |
| development | dial-development | dial-development-directory | dial-development-datasets | 127.0.0.1:8787 |
| staging | dial-staging | dial-staging-directory | dial-staging-datasets | staging.dial.page |
| production | dial-production | dial-production-directory | dial-production-datasets | www.dial.page |

`src/core/environment.ts` is the source of these identities.
The apex has no application domain assignment.
`cloudflare.config.ts` derives typed bindings through the pinned cf configuration API.
The project uses cf rather than Wrangler for Cloudflare project operations.
Vite's build API and preview command handle the full client and Worker build locally.
The CLI and plugin are beta dependencies, so upgrades require the native integration checks.

Secrets belong in Doppler.
The checked-in Doppler configuration identifies the existing project and account configuration; it grants no deployment authority.
Public reads have no application secret.
The commands use Doppler for account selection and the existing cf OAuth profile for provider authentication.
Enable R2 in the Cloudflare account before the first remote preparation.

## Prepare and publish

```sh
mise x -- just data-remote staging .local/phonebook
mise x -- just publish staging .local/phonebook
mise x -- just data-remote production .local/phonebook
mise x -- just publish production .local/phonebook
```

The data command validates the complete local bundle before remote writes.
It uploads content-addressed archives and the manifest to the environment's private R2 bucket.
It imports bound SQL batches through the pinned cf CLI, within D1's parameter and request budgets.
An import identity and checkpoint commit in the same native D1 transaction as each batch.
A lost acknowledgement can resume from the stored checkpoint without duplicate inserts.
An unowned database or a different publication is refused rather than overwritten.
A different snapshot requires separately prepared database identities.
The final checks compare counts, foreign keys, the complete catalog, and fixed payload samples with the validated source.

The publisher requires a clean committed checkout and a verified remote-data receipt.
Production additionally requires a passing staging receipt for the identical Git tree and snapshot.
Tree identity allows a merge commit to preserve an already checked candidate when its files are unchanged.
Each environment is rebuilt with its own bindings and origin before the prebuilt cf deployment.
The publisher deploys the Worker and then applies its triggers, including custom domains.
The publisher hashes build output before deployment and after provider provisioning.
Public Playwright checks exercise desktop and narrow search, telephone formatting, detail and provenance navigation, the interactive Scalar client, accessibility, security-policy failures, and the 512-byte query boundary.
They also download every archive through HTTPS and compare its byte length and SHA-256 with the checked manifest.
Receipts and failure evidence stay under `.local/releases` and `test-results`.

The previous Worker and its data remain available while the new staging service is checked.
Record the existing domain mapping and deployment identity before production cutover.
Provider provisioning, network delivery, and the truth of upstream records remain external trust boundaries.
Read the [promotion decision](adr/source-tree-bound-staging-promotion.md) and [verification contract](verification.md) for their checks and limits.
