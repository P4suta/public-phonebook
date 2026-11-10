# Website deployment

The website runs on Cloudflare Workers at <https://www.dial.page>.
The Worker configuration belongs to `apps/web/cloudflare.config.ts`.
The deployment follows Cloudflare's [GitHub Actions pattern](https://developers.cloudflare.com/cf/ci/): build without credentials, validate the Build Output, and deploy the preserved output with `cf deploy --prebuilt`.
The pinned Cloudflare CLI and Vite plugin use prerelease versions, so package updates require the same build and deployment checks.

## Pull requests

The Checks workflow runs lint, type checking, tests, dependency-boundary checks, dependency and secret scans, and workflow validation.
Its build job validates the development build and the production build without Cloudflare credentials.
The production dry run sends no API requests.
Native SDK checks remain release-stage work, while affected Rust and Android checks run under the repository's change gate.

## Publish the website

Merge the checked change into `main`, then start the Deploy website workflow:

```sh
mise x -- just release
```

The workflow checks the pinned dataset, telephone identities, search parity, four browser profiles, repository contracts, and directory proofs.
It builds the production Worker without credentials and preserves the Build Output with GitHub provenance and an npm-generated CycloneDX SBOM.
The production environment then requires approval before its deployment job starts.
The job verifies the original artifact's source commit and signer, fetches the scoped Doppler `ci_production` credentials through OIDC, and deploys the preserved output.
The deployment can't provision missing resources.
Cloudflare records the Git commit as the Worker version tag.
Public browser and API checks run after deployment.

GitHub job dependencies, environment protection, immutable workflow artifacts, and the `publication-production` concurrency group control publication.
An iOS or Android release campaign is independent of a website deployment.
A rolling website deployment doesn't create a GitHub release.
Historical GitHub releases and retained dataset objects remain available.

## Domain connections

Cloudflare keeps the existing `www.dial.page` Custom Domain connection to `dial-production`.
The build declares no domain changes, so `cf deploy --prebuilt` updates the Worker with the existing per-Worker token.
The build gate rejects domain declarations before publication.
Public response checks confirm that the connected hostname serves the deployment.

Create or change a domain connection through [Cloudflare's Custom Domain settings](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#set-up-a-custom-domain-in-the-dashboard) as a separate infrastructure operation.
Domain changes need [zone permissions](https://developers.cloudflare.com/workers/authorization/workers/#routes-and-custom-domains), and Custom Domains lack per-Worker role support.
The deployment token receives no zone permissions.
An account rebuilt from scratch needs the domain connection before the first public response check can pass.

## Dataset bindings

`infrastructure/cloudflare/production-dataset.json` pins the ready-manifest digest, snapshot, database digest, and D1 database ID.
The Worker binds the exact D1 resource and immutable manifest.
Ordinary website deployment neither imports the database nor changes the dataset pin.
Dataset preparation and collection remain separate operations under `data` and `infrastructure/cloudflare`.
Check a prepared dataset before reviewing any change to the production pin.
Keep published database resources and dataset objects so existing app versions and Worker versions remain usable.

After collection stores a verified immutable manifest, prepare its D1 resource independently:

```sh
gh workflow run dataset.yml --ref main -f manifest=MANIFEST_SHA256
```

The workflow validates every dataset artifact, prepares an immutable database and public archives, and preserves `production-dataset-binding`.
It doesn't deploy a Worker.
Review the generated `production-dataset.json` and commit its bytes at `infrastructure/cloudflare/production-dataset.json` in a pull request.
The following website deployment checks and binds the reviewed dataset.
Database preparation checks actual Worker bindings before allowing an import and refuses writes to a bound database.

## Restore a version

Read the provider's deployment history:

```sh
mise x -- just release-status
```

Choose the complete Worker version identifier in Cloudflare's deployment history, inspect its bindings, and start the protected restore workflow:

```sh
mise x -- just recover WORKER_VERSION_UUID
```

The workflow reads the requested version before production approval.
It restores the existing version with the official deployment API and checks the public catalog.
It neither rebuilds the website nor reverses database writes.
Restoration requires a retained version with compatible bindings under Cloudflare's [rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
The same production concurrency group serializes deployment and restoration.

## Privacy and credentials

The committed configuration turns off Worker observability, invocation logs, traces, Logpush, and tail consumers.
The mise configuration and deployment workflows turn off Cloudflare CLI telemetry.
The service sends no user query, telephone number, or usage event to an analytics service.
Verification artifacts describe controlled test runs and build outputs.

Doppler keeps the existing environment-bound OIDC identities.
Credentials enter the steps that need them through explicit environment variables.
Pull requests and build steps receive no production credentials.
The deployment step receives the Worker token and account ID, while dataset retrieval receives read-only R2 credentials.
Keep production environment approval and main-branch protection enabled.
