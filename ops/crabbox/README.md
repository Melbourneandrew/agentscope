# Crabbox development operation

This is the only supported Agentscope Crabbox path. It follows upstream
`openclaw/crabbox` `v0.46.0` (commit
`8ba71f913bbe57285ae29af45ef0d8ec6712477d`) and its locked `worker/` project;
it does not install or invoke an Agentscope launcher.

Use the upstream Cloudflare coordinator and Hetzner provider instructions. The
operator deploys one Workers development coordinator with project-local
Wrangler, a `FLEET` Durable Object, a 15-minute trigger, and Worker secrets for
the dedicated-project Hetzner token and one random Crabbox shared token. The
Cloudflare deployment token is attended-only and is never written here.

For attended deployment, the two provider deployment credentials may be kept
only in the ignored local file `ops/crabbox/.local/credentials.env` with mode
`0600`. It contains the field names `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, and `HETZNER_TOKEN`; never commit it or place either
secret value in shell history, command arguments, or operational evidence.

Direct use is attended from the dedicated fleet-control user account. Its only
reusable Crabbox bearer copy is the ordinary mode-0600 Crabbox client config;
that account never runs repository or candidate code. Resolve the pinned
coordinator origin before loading the bearer. Do not use direct Hetzner mode,
the former Keychain wrapper, an admin token, checkpoints, or a custom broker.

The initial substrate proof is one disposable `cx33` Ubuntu 24.04 worker with
no capacity fallback, a 90-minute hard TTL, a 20-minute idle timeout, no keep,
no checkpoint, at most two active leases globally and one per owner, and modeled
reservations capped at USD 25 globally and USD 10 per owner. Run only a fixed
content-free OS identity command. Record the exact lease/server/key identities,
limits, terminal time, modeled and observed cost, and independent Hetzner
absence observation. A missing or uncertain cleanup result freezes acquisition.

Crabbox is development capacity only. GitHub CI remains the only merge and
release authority. Repository scenarios require the separate admitted inner
hermetic setup and complete Harness Execution ADR-006 evidence; the substrate
proof is not a test result.

For a repository scenario, fleet control allocates the disposable guest,
hydrates the exact checkout through `.github/workflows/crabbox-hydrate.yml`,
and installs Node `22.14.0`, pnpm `9.15.0`, and frozen dependencies before any
repository command starts. `.crabbox.yaml` pins the only supported guest to one
Ubuntu 24.04 `cx33` with the existing 90-minute TTL and 20-minute idle timeout;
the user config continues to own the coordinator URL and bearer.

Fleet control must allocate a fresh explicit lease ID, hydrate it, and first run
this content-free toolchain probe:

```sh
crabbox warmup --lease-id <fresh-cbx-id>
crabbox actions hydrate --id <fresh-cbx-id>
crabbox run --id <fresh-cbx-id> --no-hydrate --shell \
  'test "$(node --version)" = "v22.14.0" && test "$(pnpm --version)" = "9.15.0"'
crabbox stop --id <fresh-cbx-id>
```

The same explicit-ID sequence is required for a repository scenario. Omit
`--no-hydrate` on its first `run` only when `actions hydrate` was not invoked
separately. The hydrated checkout has one public development entry:

```sh
AGENTSCOPE_INTEGRATION_EXECUTOR=crabbox AGENTSCOPE_INTEGRATION_FULL=1 pnpm test:integration
```

The repository controller does not allocate or authenticate the guest. It owns
only the private in-process integration stages, per-run resources, one deadline,
and bounded cleanup. Fleet control destroys the guest after every run. If the
controller reports `integration.controller.retire-outer-host`, it must destroy
the guest without same-host retry regardless of cleanup output.
