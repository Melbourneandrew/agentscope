# Hermetic integration suite

The default lane compiles the versioned capability manifest, packs and verifies the candidate CLI, and prepares exact digest-pinned base images before any scenario starts. Each selection then runs in a fresh read-only container on its own Docker-internal network with empty tmpfs homes, worktree, and ledger. The built image contains only the selected manifest and verified prepared bundle; no checkout or host home is mounted, and public provider/registry probes must fail. Automated destination integration coverage uses only these hermetic, loopback-contained services and synthetic fixtures.

## Local Docker Desktop workflow

This workflow certifies the fixture substrate only. It is not real-harness,
CI-matrix, remote-provider-compatibility, or product acceptance evidence.

Start from a clean, non-bare temporary worktree at an exact `main` commit. If a
shared checkout reports `core.bare=true`, leave it unchanged and create the
worktree from a healthy clone instead:

```sh
git fetch origin main
integration_commit=$(git rev-parse origin/main)
integration_worktree=$(mktemp -d /private/tmp/agentscope-integration.XXXXXX)
git worktree add --detach "$integration_worktree" "$integration_commit"
git -C "$integration_worktree" rev-parse --is-bare-repository
git -C "$integration_worktree" status --short
cd "$integration_worktree"
```

Prepare the exact candidate and the single manifest-declared fixture scenario:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @agentscope/integration prepare:candidate
AGENTSCOPE_INTEGRATION_SCENARIO=fixture-process-smoke pnpm --filter @agentscope/integration select
pnpm --filter @agentscope/integration prepare:images
pnpm --filter @agentscope/integration prepare:model-routes
```

Run the selected scenario. Repeat the same command three times for local
substrate certification; do not rebuild or replace the prepared candidate
between those runs:

```sh
AGENTSCOPE_INTEGRATION_CONCURRENCY=1 \
AGENTSCOPE_INTEGRATION_TIMEOUT_MS=300000 \
  pnpm --filter @agentscope/integration run:scenarios
```

Each run writes a strict `evidenceVersion: 2` record beneath its fixed
`artifacts/integration/runs/<run-id>` directory. The record is self-describing:
it binds the selected manifest scenarios and selector, effective concurrency and
scenario timeout, Docker client/engine/default-runtime identity, exact per-
container memory/process/tmpfs ceilings, the 1 MiB destination-sidecar request
ceiling, the split cleanup timeout, and the post-cleanup count for every owned
resource class. The selected scenario set is recomputed from the exact selector
and manifest before execution, and each record binds its scenario back to that
set. These fields are compiled
from executor-owned constants, validated selection input, Docker's projected
runtime record, and a final label-scoped inventory; scenario or fixture payloads
cannot supply them. A cleanup proof failure records `verification-failed` with
unknown counts rather than inventing zero survivors, and fails the run.
If runtime inspection fails before execution, the record uses the explicit
`unavailable` runtime-inspection disposition, retains the executor-owned limits
and selection, records null unbuilt image identities, and still performs and
records cleanup.

The runtime projection is deliberately non-secret and path-free. It excludes
Docker root paths, host names, environment variables, credentials, command
arguments, and raw provider or harness data.

After every run, require the four commands below to print nothing. The scenario
runner has already destroyed its disposable homes, worktree, ledger, containers,
internal network, and scenario images. Preserve the bounded sanitized files in
`artifacts/integration/runs` before the final cleanup command.

```sh
docker container ls --all --filter label=com.agentscope.integration=true --format '{{.Names}}'
docker network ls --filter label=com.agentscope.integration=true --format '{{.Name}}'
docker volume ls --filter label=com.agentscope.integration=true --format '{{.Name}}'
docker image ls --filter label=com.agentscope.integration=true --format '{{.Repository}}:{{.Tag}}'
```

Exercise deterministic failure and interruption cleanup, then immediately rerun
the ordinary scenario to prove retry:

```sh
pnpm --filter @agentscope/integration verify:isolation
AGENTSCOPE_INTEGRATION_CONCURRENCY=1 \
  AGENTSCOPE_INTEGRATION_TIMEOUT_MS=300000 \
  pnpm --filter @agentscope/integration run:scenarios
```

After copying the reviewed sanitized evidence, remove only manifest-owned local
artifacts. Never substitute a broad Docker prune or recursive workspace cleanup:

```sh
pnpm test:integration:clean
```

## Troubleshooting

- `integration.operations.active` means another live operation owns the
  workspace-derived loopback lease. Acquisition waits for kernel release under
  one 60-second absolute deadline and then fails with `ETIMEDOUT`; do not delete
  a pathname lock or retry a timed-out command as passing evidence.
- An image-digest error requires `prepare:images` against the unchanged manifest.
  Do not retag or replace an image to make the check pass.
- A candidate-input error requires `prepare:candidate` from the exact worktree.
  Confirm `current-candidate.json` still names the worktree commit.
- On failure, preserve the bounded run directory before cleanup. It contains the
  lifecycle evidence and any sanitized model/destination ledgers produced before
  the fault.
- If cleanup reports a target error, inspect the exact printed names and fix the
  runner or create a linked Bead. Do not manually absorb the failure with a broad
  deletion command.
- The scenario has zero host mounts, an internal-only network, a read-only root,
  and tmpfs-backed home/config/worktree/ledger paths. A host Docker socket, shell
  endpoint, home, active project, harness configuration, or credential store is
  never a scenario input.

The first recorded Docker Desktop dogfood result is
[`evidence/local-docker-substrate-2026-08-22.json`](evidence/local-docker-substrate-2026-08-22.json).
