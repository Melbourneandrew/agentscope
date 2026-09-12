# Hermetic integration suite

Mutation-heavy integration runs only on an already allocated disposable
Crabbox guest or GitHub-hosted Actions runner. Workstations, Docker Desktop,
shared daemons, and local fallback execution are unsupported.

The repository exposes one integration command:

```sh
pnpm test:integration
```

Image preparation has one public controller facade,
`image-preparation.mjs`. Its private modules have closed responsibilities:
registry acquisition authenticates OCI manifests and config blobs; Docker owns
Engine/buildx calls; build context owns deterministic no-follow traversal;
evidence owns the persisted prepared-image envelope; private storage and
retirement own destructive-cleanup reconciliation. The facade alone creates
the process-local lifecycle authority and gives each module a frozen, typed,
operation-scoped projection. It passes the one frozen preparation set or
prepared-client snapshot by reference; same-process modules do not reparse,
serialize, digest, or rebrand that snapshot.

The command creates one module-private, in-process capability and one deadline,
then runs the existing candidate, selection, image, route, scenario, retention,
and cleanup stages in sequence. Those stages are not package scripts. Scenario
or cleanup uncertainty preserves the primary failure, reports
`integration.controller.retire-outer-host`, and never retries on the same host.
The Crabbox coordinator destroys the guest; GitHub Actions retires its runner.

## Crabbox development

Fleet control allocates a disposable guest, hydrates the exact checkout, and
installs frozen dependencies. From the built checkout it runs:

```sh
AGENTSCOPE_INTEGRATION_EXECUTOR=crabbox AGENTSCOPE_INTEGRATION_FULL=1 pnpm test:integration
```

The repository does not allocate, attest, or recycle the guest. The coordinator
owns those outer lifecycle decisions. A failure is terminal for that guest.

## GitHub CI

The integration workflow uses the same command for candidate preparation and
every lifecycle. The candidate job sets
`AGENTSCOPE_INTEGRATION_MODE=candidate`, builds, and publishes the immutable
candidate once. Three clean GitHub-hosted replay jobs download that exact
candidate. After each canonical lifecycle and outer cleanup succeed, the
controller emits a bounded comparison receipt. Fan-in requires all three
receipts to bind the same commit, candidate, manifest, selection, and scenario
outcomes. Process-fixture records have `platform-certification-only` authority;
they are not harness-admission capabilities or support evidence. A selected
real-harness row additionally binds either exact registry archives with npm
signature/SLSA provenance or an exact native binary with its exact-version
signed release manifest and documented signing-key identity. Both use the same
harness-neutral material authority. Credential-free npm/GPG verification runs
inside an exact prepared verifier image through the selected disposable Docker
daemon; BuildKit owns and terminally joins the complete verifier process set,
and the resulting image is identity-checked and retired before admission. No
host process-group wrapper or shared-daemon verifier can create material
authority. The authority binds the component fixture, built artifacts, and a
checksum-bound scenario process. Only the outer controller can consume that
one-use material authority after the native receipt and exact cleanup are both
terminal. The resulting record remains
`real-scenario-evidence-awaiting-release-gate`; it is evidence for a later
release decision, not a support claim by the scenario or adapter.

The workflow also gives each closed deliberate-negative case its own fresh
GitHub-hosted runner. The canonical lifecycle must fail, after which a
read-only verifier requires the exact content-free predicate and complete
retired-failure evidence. A negative job is green only when that rejection is
proved. No case permits arbitrary commands, paths, environment values, public
traffic, real credentials, retries, or a second mutation after failure. These
controller-owned certification inputs are unavailable during workstation and
Crabbox execution.

GitHub CI remains the merge and release authority; Crabbox results are
development feedback only.

The inner scenario continues to use its existing internal-only network,
read-only mounts, tmpfs homes, synthetic model service, and telemetry ledger.
Image/platform policy remains owned by the existing image preparation modules.
