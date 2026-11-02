---
date: 2026-11-02
---

# Run only the fast gate on pull requests and verify at the release gate

## Status

Proposed.

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
  So every pull request started with cold caches.

The build, browser, proof, and native checks decide whether a release is safe, not whether a merge is.
The web release path already admits production only with candidate evidence for the `check`, `data`, `phones`, `prove`, and `e2e` stages.
That evidence must name the same Git tree and dataset manifest.
The TestFlight workflow already runs `ios-prove`, `ios-check`, `ios-sanitize`, and `ios-mutate` before delivery.
Its archive step refuses to sign without their receipts.

## Decision

Pull requests and merge groups run only the fast gate, `just check`.
It runs the secret scan, typecheck, lint, unit and property tests, npm audit, and the workflow checks.
The Verify job installs only the tools that gate needs and turns off mise's automatic installation of the others.
`Checks` stays the required summary job.

`just check-build` holds the build, the built-browser fixture checks, and the Cargo checks.
`just assurance` runs `check-build`, `prove`, `ios-prove`, and `ios-check`.
`assurance.yml` runs the same set on hosted runners through `workflow_dispatch` and `workflow_call`.
A release candidate workflow can call it, and a developer can dispatch it.
The candidate `check` stage in `tools/test.ts` runs both `just check` and `just check-build`, so production evidence keeps its coverage.
The national browser campaign in that evidence also still uses the build that this stage produces.

The workflow policy treats a workflow that a pull request, merge group, or push triggers as a change workflow.
It rejects a change workflow that uses a non-Linux runner, runs a heavy recipe or a browser installation, or calls `assurance.yml`.

The toolchain action caches npm by `package-lock.json`.
It caches Cargo by `Cargo.lock` and `mise.toml` only when it installs Rust.
So a fast gate run can't save an empty Cargo cache under the key a heavy job reads.

Rejected alternatives:
- Keeping the change-scope selection keeps a 30-minute wait on any change to the workflow, the toolchain, or a proof or native input.
- A `push` trigger on `main` would warm caches by running a second gate on every merged commit, and the fast gate no longer needs warm caches.
- A scheduled heavy run spends runner time on unchanged commits and gates nothing.
- Requiring the Assurance workflow as a status check brings the wait back to every pull request.

## Consequences

A broken build, a fixture browser regression, a Cargo failure, a failed proof, or a native failure no longer blocks a pull request.
The release gate or a manual Assurance run finds it instead, so `main` can hold such a defect until then.
Dispatch the Assurance workflow or run `just assurance` when a change touches the build, the proofs, or native code.
`just check-linux` stays the local pre-push equivalent of Verify, because it runs the same fast gate in the pinned Linux container.

The ruleset still requires `Checks` to be current with `main`, so every merge makes the other open pull requests update and rerun the fast gate.
A shorter gate makes that loop cheaper but doesn't remove it.
Turning off `strict_required_status_checks_policy` or enabling a merge queue would remove it.

Until the release candidate workflow calls `assurance.yml`, only a manual dispatch runs it.
