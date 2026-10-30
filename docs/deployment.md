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

For a built local preview, run `mise x -- just build` followed by `mise x -- npm run preview`.
Both development and preview run the native Cloudflare Workers runtime with local D1 and R2 bindings.
No Container is needed.

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
Vite's build API and preview command handle the full client and Worker build locally.
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

```sh
mise x -- just release .local/phonebook
```

The release command runs the complete local test gate before remote preparation.
It prepares and checks staging before production and reuses immutable data resources.
For the first migration, preserve the validated existing production bundle at `.local/published-phonebook`.
The command adopts that exact public baseline before its first replacement.
Adoption permits the retained address spelling while preserving all checksum, provenance, index, count, and archive checks.
Normal preparation and publication require canonical addresses.

For a private failure exercise, run `mise x -- just release-rehearse .local/phonebook` after the full local gate.
It derives a real subset from the supplied directory, retaining every populated category and prefecture plus the fixed verification contacts.
The exact subset size depends on the input.
It publishes A, activates B, injects the expected verification failure, verifies A again, and then publishes B normally.
The exercise affects staging only.

The data command validates the complete local bundle before remote writes.
It uploads content-addressed archives and the manifest to the environment's private R2 bucket.
It imports bound SQL batches through the pinned cf CLI, within D1's parameter and request budgets.
An import identity and checkpoint commit in the same native D1 transaction as each batch.
A lost acknowledgement can resume from the stored checkpoint without duplicate inserts.
An unowned database or a different publication is refused rather than overwritten.
A database identity includes the first 32 hexadecimal characters of its complete database SHA-256.
The full digest remains the import identity, so a prefix collision cannot overwrite a different publication.
Repeated preparation reuses the exact database artifact and preserves earlier database resources.
The final checks compare counts, foreign keys, the complete catalog, and fixed payload samples with the validated source.

The publisher requires a clean committed checkout, current full-test and proof receipts, and a verified remote-data receipt.
Production additionally requires the identical active verified staging Git tree, contact snapshot, database SHA-256, and manifest SHA-256.
Tree identity allows a merge commit to preserve an already checked candidate when its files are unchanged.
Each environment is rebuilt with its own bindings and origin before the prebuilt cf deployment.
The cf deployment applies the Worker's triggers, including custom domains.
HTML responses use `no-store, no-transform` to prevent Cloudflare from adding scripts to the document.
Browser checks reject scripts from other origins and verify that an inserted external script is detected.
The publisher hashes build output before deployment and after provider provisioning.
Public Playwright checks exercise desktop and narrow search, telephone formatting, detail and provenance navigation, the interactive Scalar client, accessibility, security-policy failures, and the 512-byte query boundary.
They also download every archive through HTTPS and compare its byte length and SHA-256 with the checked manifest.
Receipts and failure evidence stay under `.local/releases` and `test-results`.

The previous Worker and its data remain available while the new staging service is checked.
The publication journal records the predecessor's exact version and bindings before activation.
Failure restores the complete predecessor and verifies it before recording recovery.
`mise x -- just release-status staging` reads the journal and active provider version.
`mise x -- just recover staging` retries interrupted recovery without building or deploying a new candidate.
Replace `staging` with `production` for public recovery.
An unrelated active deployment is refused rather than overwritten.
Repair access or provider availability before retrying failed verification.

The first staging publication requires `--bootstrap` and has no verified rollback target.
If its activation succeeded but verification was interrupted, run `doppler run --project public-phonebook --config stg --no-fallback -- node tools/publish.ts staging BUNDLE --resume-bootstrap`.
It accepts only the owned active initial candidate and its original committed source.
If that candidate failed verification, run `--bootstrap` again from corrected committed source.
It supersedes the failed candidate only while no staging publication is verified and the failed candidate still owns the active version.
Do not discard journals or edit them to make a foreign deployment pass.

`mise x -- just release-retention production` prints a read-only database retirement plan.
Active, rollback, and pending resources remain protected, and all published R2 download URLs remain retained.
The command never deletes resources.
Preserve `.local/releases` and its verification bundles for recovery.
Provider provisioning, network delivery, and the truth of upstream records remain external trust boundaries.
Read the [recovery decision](adr/recover-complete-worker-and-dataset-publications.md), [promotion decision](adr/source-tree-bound-staging-promotion.md), and [verification contract](verification.md) for their checks and limits.

## Support mail

The `/support` and `/privacy` pages publish `support@dial.page` as the only contact address.
Cloudflare Email Routing on the `dial.page` zone forwards it to a verified private destination that stays out of this repository.
Before publishing a change that shows the address, confirm that the zone's routing is enabled and that the `support@dial.page` rule forwards to a verified destination.
Point the iPhone app's App Store support URL and in-app help at `https://www.dial.page/support`.
