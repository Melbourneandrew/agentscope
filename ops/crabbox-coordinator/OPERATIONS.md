# Crabbox coordinator operations

This runbook implements the approved development-environment Blueprint. It is
for the human-owned deployment path and the protected fleet-control service. A
repository agent may validate non-secret inputs but cannot receive deployment,
provider, inventory, recovery, admin, or shared-token authority.

## Immutable admission

The sole initial coordinator is `openclaw/crabbox` `v0.46.0`, commit
`8ba71f913bbe57285ae29af45ef0d8ec6712477d`. The admitted local deployment
toolchains and digests are in `admission.json`. Use an exact detached checkout;
do not use the upstream default Wrangler profile.

Keep deployment inputs outside the repository under
`~/.local/share/agentscope-crabbox/` with owner-only permissions. The external
record binds the Cloudflare account, Workers Free plan, Worker name, immutable
environment identifier, Durable Object namespace/deployment identities, and
the dedicated fleet-only Hetzner project. Never commit that record as reusable
authority.

## Stage and validate without cloud mutation

Create an external JSON record with:

```json
{
  "environmentId": "asgcf_<32 lowercase hex characters>",
  "workerName": "agentscope-crabbox-development",
  "cloudflarePlan": "free",
  "accountMode": "owner-personal-shared"
}
```

Then render the profile beside the exact upstream Worker source:

```sh
<owned-node>/bin/node scripts/crabbox-coordinator-profile.mjs \
  --source <exact-crabbox-checkout> \
  --record <external-record.json> \
  --output <exact-crabbox-checkout>/worker/wrangler.agentscope.jsonc
```

Recreate `worker/node_modules` with the admitted Node/npm and `npm ci`. Use
separate empty user/global npmrc files, a private npm cache, a `PATH` containing
only the admitted Node distribution and audited `/usr/bin:/bin`, and no ambient
`NODE_OPTIONS`, npm prefix, global packages, or moving `npx`.

Run the locked dry build with the same closed environment:

```sh
<owned-node>/bin/npm exec --prefix <exact-crabbox-checkout>/worker -- wrangler \
  deploy --config <exact-crabbox-checkout>/worker/wrangler.agentscope.jsonc \
  --dry-run --outdir <owned-empty-output>
```

Before login or deployment, inspect the rendered Wrangler output and reject any
extra/missing Worker identity, route, preview, asset, binding, migration, cron,
variable, secret name, or provider integration. The profile must contain only
the one `FLEET` SQLite Durable Object, migration `v1`, the 15-minute trigger,
workers.dev, preview URLs disabled, and the exact allowlists in `admission.json`.

## Authenticate and admit the shared account

The attended operator creates the least-privilege Cloudflare and Hetzner API
tokens in the official account UIs, verifies the approved account/project IDs,
and enters each value only through the installed launcher's no-echo
`credential-enroll` prompt. Do not run `wrangler login`, place Wrangler state in
the repository, use a temporary preview account, or use a repository/GitHub
token. The launcher later passes the exact enrolled deployment token only to
the root-owned pinned Wrangler runtime; there is no generic login or raw
Wrangler command.

The account is intentionally shared and may contain unrelated zones, Pages
projects, Workers, and other products. Before resolving deployment authority,
the human operator must acquire the account mutation fence and inventory the
complete observable projection of the admitted Workers Scripts Write mutation
surface. The immutable one-use plan records the exact coordinator target,
permission-manifest identity, observable prestate, closed ordered operations,
rollback actions, expiry, nonce, and intended terminal state. A repository
process or agent cannot mint, widen, consume, or apply that plan. There is no
generic Wrangler/dashboard/API mutation mode.

The repo-local `scripts/crabbox-coordinator-plan.mjs` is a non-mutating
structural preflight only. It uses only the canonical committed admission and
permission manifest, fully validates the live profile and toolchain identities,
and checks candidate detached signatures, freshness, kind-specific actions,
resource targets, and opaque secret slot/version identities. Caller-supplied
candidate public keys do not establish the external authorities. Its output
therefore says `authorityAdmitted: false`, `continuouslyEnforced: false`,
`consumed: false`, and `mutationAuthorized: false`. The separately installed
launcher must bind the admitted human-controlled key identities, continuously
enforce plan freshness, atomically consume and journal the same authenticated
plan, and revalidate before resolving credentials. Never substitute this script
or raw Wrangler for that missing authority.

## Install the protected one-use launcher

The repository ships a standalone Go control binary and attended installer at
`tools/crabbox-launcher` and
`ops/crabbox-coordinator/install-protected-launcher.sh`. The production state
root is `/Library/Application Support/Agentscope/CrabboxControl`. The installer
requires root, builds with the admitted Go 1.26.5 distribution in a closed
environment from root-owned Git bundles of the exact reviewed Agentscope and
Crabbox commits. Git replacement objects and ambient Git configuration are
disabled while the bundles are created and again while root reconstructs and
verifies both trees. The installer embeds those source identities in the
executable and verifies them again at the root installation boundary. Source,
compiler, dependency installation, and the runtime closure remain in a
root-owned private staging directory throughout the build so another process
under the invoking user's identity cannot replace an input between verification
and use. It installs an immutable executable plus five pairwise-distinct role
roots, seals owner/recovery/billing signing keys under an attended operator passphrase,
and binds the exact admission, permission manifest, profiles, official Node
archive, pinned Crabbox commit, lock-installed Wrangler dependency closure, and
toolchain identity. The attended installer copies that complete closure into the
root-owned control directory before it can receive cloud authority; the launcher
never executes repository or user-writable Node code. Runtime preparation may
fetch only lockfile-integrity-pinned npm artifacts; it performs no login,
cloud/provider credential receipt, Cloudflare/Hetzner request, Wrangler command,
or cloud/provider mutation.

The installer creates or reuses exactly one hidden no-login
`_agentscope_crabbox` identity. Credentialed Node/Wrangler runs only under that
UID. Admission fails if any process is already using it, and completion kills
and joins the complete UID process set, including an immediately detached
session descendant, before reporting success. No other service or workload may
use that identity.

Do not run the installer from an unattended agent session. The attended human
invocation is:

```sh
ops/crabbox-coordinator/install-protected-launcher.sh \
  <installation-id> <environment-id> <cloudflare-account-id> \
  <hetzner-project-id> <exact-crabbox-source> <official-go-archive> \
  <official-node-archive> \
  <toolchain-identity.json> <exact-live-profile> <exact-terminal-profile> \
  <exact-terminal-entry-point>
```

The installer prints the exact launcher and runtime-closure digests before the
attended root copy and verifies the root-owned bootstrap copy before executing
it. After installation, use only the root-owned installed binary. It exposes the
closed commands `status`, `state-observe`, `credential-enroll`,
`plan-build`, `observation-admit`, `retirement-evidence-admit`, `authorize`,
`apply`, `freeze`, `recover-quarantine`, `recover-resolve`, `thaw`, `retire`, and
`retirement-finalize`. `apply` accepts no
caller-selected executable, source, profile, endpoint, method, body, or target.
It verifies installed roots and the entire protected runtime tree, durably
consumes the plan, independently observes the fixed Cloudflare permission
surface with the read-only credential, and only then resolves and invokes exact
credential versions. Every mutation is bracketed by before/after observations;
success requires a Cloudflare success envelope, recorded response and
resource-identity digests, no intervening drift, and a semantic terminal
projection. A crash or failed process after an
invocation starts leaves the global mutation fence held and records an
outcome-uncertain event. An exact same-plan invocation may resume only from a
durable prefix that proves no request is uncertain: `consumed`,
`observed-committed`, `credential-roles-validated`, or
`reconciled-terminal`. It re-observes and binds the recorded state before
continuing and never replays an `invoking-uncertain` request.
`recover-quarantine` records an independently evidenced human recovery decision
for any stranded prefix. Only a second signed `recover-resolve` decision with
terminal reconciliation evidence may release the local mutation fence. A
subsequent owner-authorized exact rollback or retirement plan is allowed while
acquisition remains frozen. `thaw` requires either the exact plan-bound signed
resolution or new incident evidence bound to the current generic freeze, a new
attended recovery confirmation, no active mutation, and no unclassified
journal; it cannot reuse historical evidence to erase or reinterpret a later
freeze.

`state-observe --output <new-file>` writes the exact read-only Cloudflare
projection. An existing deployment's compatible predecessor, and any explicit
rollback candidate, must first be observed with
`state-observe --rollback-version <exact-version-id>`; the resulting projection
binds the target Worker version's detailed migration, Durable Object binding,
and exact admitted coordinator-source annotation separately from the current
deployment identity. The auxiliary detail is not part of the live prestate
digest. `plan-build` is the only supported plan-construction path: it
derives resource identities and the prestate digest from that file and emits
one closed deploy, rollback, retirement, or account-workers.dev plan. The
caller may supply only opaque slot/version references and the kind-specific
identities displayed by the command; it cannot supply an action, URL, method,
executable, or target. `authorize` separately displays and signs those exact
bytes after attended confirmation.

`status` is the handoff to the small attended ceremony owned by the deployment
task. Until that later task, `cloudAuthenticated`, `billingObservationReady`,
and `deploymentReady` remain false. That ceremony must authenticate Andrew's
approved account, enroll the seven closed credential roles through the no-echo
terminal prompt, establish an independent signed Free/no-overage observation,
and authorize one exact plan. The launcher verifies such an observation but
does not claim that Cloudflare exposes the required authoritative quota surface;
the deployment task must prove that empirical acquisition or stop for an
approved architecture amendment.

The installed `status` command emits this same closed ceremony as executable
command shapes. The attended deployment task substitutes only reviewed opaque
IDs and private output paths:

```sh
<installed-control> credential-enroll --role cloudflare-deployment --slot cf-deploy --version v1
<installed-control> credential-enroll --role cloudflare-plan-read --slot cf-plan-read --version v1
<installed-control> credential-enroll --role hetzner-worker --slot hcloud-worker --version v1
<installed-control> credential-enroll --role crabbox-shared --slot crabbox-shared --version v1
<installed-control> credential-enroll --role crabbox-admin --slot crabbox-admin --version v1
<installed-control> credential-enroll --role hetzner-inventory-read --slot hcloud-inventory --version v1
<installed-control> credential-enroll --role hetzner-recovery --slot hcloud-recovery --version v1
<installed-control> state-observe --output <state.json> [--rollback-version <current-or-target-version>]
<installed-control> observation-admit --observation <independent-billing.json> --output <billing-attestation.json>
<installed-control> plan-build --kind <closed-kind> --state <state.json> --observation-id <id> [--slots <slots.json>] --output <plan.json>
<installed-control> authorize --plan <plan.json> --output <authorization.json>
<installed-control> apply --plan <plan.json> --authorization <authorization.json> --observation <independent-billing.json> --observation-attestation <billing-attestation.json>
```

Every enrollment reads and confirms the value from the controlling terminal
without echo; values never appear in argv, environment, files, or command
output. The independent billing observation is produced by the separately
approved attended account/billing authority. Recovery uses only `freeze`,
`recover-quarantine`, `recover-resolve`, `thaw`, or the separately admitted
`retire` command—never a raw API or Wrangler fallback.

Credential enrollment is serialized with plan admission. Each immutable slot
version is signed, predecessor-linked, and has one current head per role. A
partial value write may be recovered only by reenrolling the same exact version;
an authorized plan that references a superseded version is rejected before
credential resolution. The three Worker-bound values are resolved only after durable consumption and
confidentially compared for pairwise distinction. They enter the protected
Wrangler child only through its closed credential environment or secret stdin;
they never enter argv, plan, journal, evidence, or output. A fresh-account deploy
first performs one profile-bound compound Wrangler deploy, then writes the three
secrets, and finally proves the three roles through bounded non-mutating checks.
This explicit creation step prevents Wrangler's secret command from silently
creating an unplanned draft Worker. An ordinary existing-Worker deploy changes
only the profile-bound deployment. Secret rotation is a separate exact plan that
binds three newly versioned, predecessor-linked slots, performs the three writes,
and repeats the role checks. Schedule and script-level workers.dev are part of
the admitted profile, not falsely journaled as separate successful requests.

The only admitted public binding is the exact script-level workers.dev binding.
Do not create a zone route, Worker Domain, custom domain, Pages binding, Access
application, shared storage, or unrelated account resource. The account-level
workers.dev subdomain is shared state: if it must be enabled, that is a separate
owner-approved plan and retirement does not disable it.

Before deployment, a separate human-owned read-only billing/product credential
must produce a signed observation no more than 15 minutes old proving the
selected account is on Workers Free with no paid or usage-overage path and
recording the current Workers, Durable Object, storage, CPU, and Pages Functions
quota projections plus their source identities. The fleet service may verify
the signed record but never receives Cloudflare authority, and must keep a fresh
continuous observation throughout every active or uncertain operation.
Sampled or delayed Workers, Pages, and Durable Object analytics are advisory
only; they do not prove billing state or current quota. Missing, stale, paid,
ambiguous, or discontinuous plan evidence freezes acquisition. The owner accepts that
unrelated Workers or Pages Functions can consume the shared Free quota and deny
the coordinator, and that coordinator traffic can deny those unrelated
services. Independent Hetzner reconciliation and attended recovery remain
available when Cloudflare runtime quota is exhausted.

## Create secrets and deploy

The only Worker secrets are `HETZNER_TOKEN`, `CRABBOX_SHARED_TOKEN`, and
`CRABBOX_ADMIN_TOKEN`. Each approved secret operation binds the exact name to an
opaque operator-store slot and immutable version in the one-use plan. The
human-owned launcher consumes the value directly into the exact Cloudflare
request; never place a value in argv, variables, a file, the repository,
terminal output, plan, or evidence. Before any value reaches Cloudflare, the
protected store must confidentially prove that all three underlying values are
pairwise distinct. Equality or an indeterminate comparison fails before
mutation and emits no value, reusable digest, or comparison artifact. The
Hetzner token must belong to the dedicated fleet-only project.

After the initial or rotation plan applies the three secrets, exercise only bounded non-mutating forward
checks: the shared token must authenticate its ordinary route and be rejected
by an admin-only route; the admin token must succeed there; the provider token
must work only through the admitted provider-read path. Ambiguous role behavior
is unadmitted and requires newly versioned pairwise-distinct values. The pinned
Crabbox implementation checks the admin token before the shared token, so value
aliasing would otherwise elevate the automation bearer.

Separately provision:

- one project-scoped read-only Hetzner inventory token for the protected
  fleet-control principal; and
- one human-held project-wide read/write recovery token in a different secret
  store.

Deploy only the validated `wrangler.agentscope.jsonc` through the human-owned
one-use plan launcher. Immediately before every mutation, revalidate the exact
account, target, toolchain, permission manifest, profile, observable prestate,
and secret slot/version identities. Output failure, replay, substitution,
expiry, drift, an unclassified API action, or a ledger gap refuses the next
mutation and keeps acquisition frozen. Record source/toolchain, profile,
account, environment, Worker version, Durable Object migration, script-level
workers.dev binding, cron, variable-name, secret-name, and deployment
identifiers. Never record secret values or claim that inventories prove the
absence of transient or write-only actions.

## Admission proof

Keep acquisition disabled until the protected fleet-control service and
out-of-band authorization tool are installed and independently reviewed. Prove
negative replay/substitution/unauthorized requests first.

One owner-approved proof may then create exactly one `cx33` in `fsn1` using
Ubuntu 24.04 amd64, a unique per-lease key, `keep=false`, TTL at most 90 minutes,
idle timeout at most 20 minutes, and the smallest manifest-selected hermetic
fixture. Use no harness/provider credentials or public model traffic. Bind the
exact candidate/manifest/image identities and record the modeled reservation.

Deliberately exercise:

- fixed-ID retry after a simulated lost client response;
- client loss while the cloud coordinator remains authoritative;
- idle expiry and hard-TTL cleanup;
- cleanup failure/retry observation without broad deletion; and
- nested Docker cleanup before the outer host is released.

Do not create a second billable worker until the first operation has one
continuous ledger and coordinator plus independent provider inventory both show
the exact server and per-lease key absent. Record provider-observed billed cost
when available and state that this is development acceleration, not release
authority or harness support evidence.

## Incident and rollback

On auth failure, quota pressure, stale reconciliation, ledger discontinuity,
provider disagreement, or cleanup uncertainty:

1. Freeze new acquisition while preserving list/release/reaper authority.
2. Revoke the affected non-admin credential and rotate only the affected Worker
   or inventory secret.
3. Compare coordinator state with independent provider inventory.
4. Use the human recovery credential only for identity-bound inventory/deletion
   in the dedicated project.
5. Retain a sanitized incident record until resolved; never erase a claim to
   manufacture success.

Roll back Worker code only to a version compatible with the live Durable Object
schema. Never rewind or recreate the namespace. Retirement freezes acquisition,
reconciles zero provider resources, revokes the launcher bearer, and writes the
authenticated environment tombstone before Cloudflare teardown. An
owner-authorized plan then removes the trigger, script-level workers.dev
binding, and coordinator secrets; deploys the separately reviewed no-op
terminal Worker profile with no runtime authority or `FLEET` reference; applies
the one append-only `FleetDurableObject` class-deletion migration; and only
after Cloudflare confirms it removes remaining versions and the script. It does
not delete a zone route, Worker Domain, or the shared account-level workers.dev
subdomain. Keep plan-observation, inventory, recovery, and deployment authority
until exact provider and Cloudflare absence is proven.

`retire` deliberately leaves the mutation fence held after recording terminal
Cloudflare/provider absence. The operator then revokes the coordinator-dedicated
Cloudflare deployment credential and plan-read credential and revokes or rotates
the three Hetzner credentials outside the launcher. Only after those five
credential actions have immutable, pairwise-distinct revocation identities may
the operator run:

```sh
agentscope-crabbox-control retirement-finalize \
  --plan-sha256 <terminal-retirement-plan-sha256> \
  --deployment-revocation-id <cloudflare-deployment-revocation-id> \
  --plan-read-revocation-id <cloudflare-plan-read-revocation-id> \
  --hetzner-worker-revocation-id <worker-token-revocation-or-rotation-id> \
  --hetzner-inventory-revocation-id <inventory-token-revocation-or-rotation-id> \
  --hetzner-recovery-revocation-id <recovery-token-revocation-or-rotation-id>
```

The attended command signs the exact revocation tuple, retires every local
credential ciphertext and its sealing key, publishes terminal finalization
evidence, and only then releases the mutation fence. A crash before final fence
removal is re-entered with the same identities; different evidence fails
closed. No other command may report retirement finalized or reopen the account
mutation surface.

`scripts/crabbox-coordinator-retirement-profile.mjs` structurally renders that
terminal profile only from a recent candidate-signed provider-zero record bound
to the exact account, Worker version, Durable Object namespace/migration,
Hetzner project, acquisition freeze, resolved transitions, launcher revocation,
tombstone, terminal evidence, zero servers/keys/leases/creates, and a continuous
ledger. It verifies pinned source/lock/license identity and stages atomically.
Its caller-selected candidate key does not establish recovery authority, and
its output explicitly says `authorityAdmitted: false` and
`mutationAuthorized: false`. The protected launcher must reverify the admitted
recovery key and owner-approved irreversible sequence before deploying the
artifact or class-deletion migration.
