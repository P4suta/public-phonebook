---
date: 2026-11-02
---

# Run only the fast gate on pull requests and verify at the release gate

## Status

Accepted.

## Context

Every pull request waits for the required `Checks` status, and the ruleset requires that status to be current with `main`.
[Pull request 64](https://github.com/P4suta/public-phonebook/pull/64) put the build, the built-browser checks, and the `tools/ios-check` Cargo checks into that status.
A change-scope job also started the proof and native jobs whenever their declared inputs changed.
Those inputs included the workflow, the toolchain action, `mise.toml`, and `justfile`.
The [verification contracts](../verification.md) recorded that arrangement, and no ADR did, so this record supersedes none.

Hosted runs on 2026-11-02 measured the cost:
- In [one run](https://github.com/P4suta/public-phonebook/actions/runs/41377930472), Verify took 8 minutes.
  Its toolchain step took 4 minutes 35 seconds, and compiling `cargo-audit` after a mise cache miss took 3 minutes 56 seconds of that.
  `just check` took 2 minutes 37 seconds.
- In [another run](https://github.com/P4suta/public-phonebook/actions/runs/41376727004), Formal assurance took 13 minutes and Native assurance took 22 minutes after Verify.
  That pull request waited 30 minutes for `Checks`.
- A pull request can't restore a cache that another pull request saved, and no workflow ran on `main`.
  Every pull request started with cold caches.

The build, browser, proof, and native checks decide whether a release is safe, not whether a merge is.
The web release path already admits production only with candidate evidence for the `check`, `data`, `phones`, `prove`, and `e2e` stages.
That evidence must name the same Git tree and dataset manifest.
The TestFlight workflow already runs `ios-prove`, `ios-check`, `ios-sanitize`, and `ios-mutate` before delivery.
Its archive step refuses to sign without their receipts.

[Pull request 98](https://github.com/P4suta/public-phonebook/pull/98) first implemented this decision without any change-scoped job.
Renovate merges minor and patch updates on its own once `Checks` passes.
Its [pull request 71](https://github.com/P4suta/public-phonebook/pull/71) then moved `sha2` to 0.11 in `tools/ios-check/Cargo.lock`, and the fast gate admitted it.
The `sha2` 0.11 digests no longer implement `LowerHex`, so `tools/ios-check` stopped compiling on `main`.
[Pull request 102](https://github.com/P4suta/public-phonebook/pull/102) repaired it.
`tools/ios-check` is the only Cargo package, and no check before the release gate compiled it.

## Decision

Pull requests and merge groups run only the fast gate, `just check`.
It runs the secret scan, typecheck, lint, unit and property tests, npm audit, and the workflow checks.
The Verify job installs only the tools that gate needs and turns off mise's automatic installation of the others.
`Checks` stays the required summary job.

Rust inputs are the one exception, and it partially reverses the removal of change scoping in pull request 98.
A small Scope job lists the files that differ between the event's base commit and the checked-out head with `git diff --name-only`.
The Rust inputs are `tools/ios-check`, `tools/check-rust.ts`, `mise.toml`, any `rust-toolchain` file, the toolchain action, and `checks.yml` itself.
When one of them changed, the Rust job runs `just check-rust`, which holds the Cargo checks of `just check-build`.
The Rust job waits only for Scope, so it runs alongside Verify.
It installs the prebuilt cargo-audit release that `mise.toml` pins by version and per-platform SHA-256, rather than compiling it.
`Checks` needs all three jobs, requires Scope and Verify to succeed, and accepts a skipped Rust job only when no Rust input changed.
A path filter on the workflow can't replace this scope, because a skipped required workflow leaves its status pending.
Renovate keeps merging Cargo updates on its own, and the Rust job now gates them.

`just check-build` holds the build, the built-browser fixture checks, and the Cargo checks.
`just assurance` runs `check-build`, `prove`, `ios-prove`, and `ios-check`.
`assurance.yml` runs the same set on hosted runners through `workflow_dispatch` and `workflow_call`.
A release candidate workflow can call it, and a developer can dispatch it.
The candidate `check` stage in `tools/test.ts` runs both `just check` and `just check-build`, so production evidence keeps its coverage.
The national browser campaign in that evidence also still uses the build that this stage produces.

The workflow policy treats a workflow that a pull request, merge group, or push triggers as a change workflow.
It rejects a change workflow that uses a non-Linux runner, runs a heavy recipe or a browser installation, or calls `assurance.yml`.
It also requires the `Checks` job to run always and need every other job.
That job may accept only `success`, except that it may also accept `skipped` from the Rust job.

The toolchain action caches npm by `package-lock.json`.
It caches Cargo by `Cargo.lock` and `mise.toml` only when it installs Rust.
A fast gate run then can't save an empty Cargo cache under the key a heavy job reads.

Rejected alternatives:
- Keeping the change-scope selection keeps a 30-minute wait on any change to the workflow, the toolchain, or a proof or native input.
  The Rust scope keeps only one Linux job, which compiles one crate.
- Leaving Cargo failures to the release gate lets an automatic merge break `main`, as pull request 71 did.
- Turning off Renovate's automatic merge of Cargo updates would leave an owner review as their only check before the release gate.
- A `push` trigger on `main` would warm caches by running a second gate on every merged commit, and the fast gate no longer needs warm caches.
- A scheduled heavy run spends runner time on unchanged commits and gates nothing.
- Requiring the Assurance workflow as a status check brings the wait back to every pull request.

## Consequences

A broken build, a fixture browser regression, a failed proof, or a native failure no longer blocks a pull request.
The release gate or a manual Assurance run finds it instead, so `main` can hold such a defect until then.
A Cargo failure still blocks a pull request that changes a Rust input.
Such a pull request also waits for the Rust job, which runs alongside Verify and may start from cold Cargo caches.
Before pushing a change to the build or the browser checks, run `just check-build` locally, and run `just check-rust` before pushing a Rust input change.
Dispatch the Assurance workflow or run `just assurance` when a change touches the proofs or native code.
`just check-linux` stays the local pre-push equivalent of Verify, because it runs the same fast gate in the pinned Linux container.

The ruleset still requires `Checks` to be current with `main`, so every merge makes the other open pull requests update and rerun the fast gate.
A shorter gate makes that loop cheaper but doesn't remove it.
Turning off `strict_required_status_checks_policy` or enabling a merge queue would remove it.

`candidate.yml` calls `assurance.yml` for each release candidate, and a developer can still dispatch it.
