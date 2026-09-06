# Hermetic integration suite

Mutation-heavy integration runs only on an already allocated disposable
Crabbox guest or GitHub-hosted Actions runner. Workstations, Docker Desktop,
shared daemons, and local fallback execution are unsupported.

The repository exposes one integration command:

```sh
pnpm test:integration
```

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

The integration workflow uses the same command in two modes. The candidate job
sets `AGENTSCOPE_INTEGRATION_MODE=candidate`, builds and publishes the immutable
candidate once. Each GitHub-hosted lifecycle job downloads that exact candidate
and runs the command without the mode override. GitHub CI remains the merge and
release authority; Crabbox results are development feedback only.

The inner scenario continues to use its existing internal-only network,
read-only mounts, tmpfs homes, synthetic model service, and telemetry ledger.
Image/platform policy remains owned by the existing image preparation modules.
