---
name: crabbox-fleet
description: Prepare, authorize, run, and reconcile bounded Agentscope development work through the approved Crabbox Cloudflare coordinator. Use for remote Linux test acceleration, fleet readiness, disposable worker requests, remote hermetic scenarios, lease cleanup, cost evidence, or Crabbox incident recovery. Never use it as release authority or expose provider credentials to an agent, repository, VM, or scenario.
---

# Crabbox fleet

Treat Crabbox as an optional outer Linux host around the unchanged hermetic Docker
scenario. Keep local Docker and GitHub CI authoritative.

## Read authority first

1. Run `bd prime` and inspect the task Bead and its blockers.
2. Read `apps/docs/content/docs/blueprints/testing/development-environment.mdx`
   and Harness Execution ADR-006.
3. Read `ops/crabbox-coordinator/admission.json`,
   `ops/crabbox-coordinator/permission-manifest.json`, and
   `ops/crabbox-coordinator/OPERATIONS.md` before operator or incident work.
4. Record the exact candidate commit, clean/dirty state, candidate digest,
   capability-manifest digest, selected scenario, and prepared image digests.

## Enforce the boundary

- Use only the brokered Cloudflare coordinator admitted by the external operator
  record. Never fall back to direct Hetzner mode, the Keychain wrapper, an
  ambient Crabbox config, or a moving upstream version.
- The admitted Cloudflare account is the owner's shared personal account, but
  the coordinator owns only its exact Worker environment, Durable Object
  namespace, script-level workers.dev binding, secrets, and dedicated Hetzner
  project. Never create a zone route, Worker Domain, custom domain, Pages
  binding, Access application, or shared account storage.
- Never request, read, print, forward, log, or artifact Cloudflare credentials,
  `HETZNER_TOKEN`, the inventory/recovery credentials, or Crabbox bearer values.
- Never pass those values to a shell command, repository process, remote host,
  Docker container, scenario, checkpoint, or evidence record.
- Refuse acquisition unless the protected fleet-control service independently
  authorizes the exact immutable source/candidate/manifest/operation tuple. An
  ordinary Codex process cannot mint or widen that authorization.
- Refuse acquisition unless a separately signed Workers Free/no-overage plan
  observation is at most 15 minutes old. Sampled or delayed Workers, Pages, or
  Durable Object usage analytics are advisory and cannot establish admission.
- Require `provider=hetzner`, `type=cx33`, `location=fsn1`,
  `image=ubuntu-24.04`, `arch=amd64`, per-lease keys, `keep=false`, TTL at most
  90 minutes, idle timeout at most 20 minutes, four or fewer active leases, and
  a reservation within the USD 25 monthly guardrail.
- Disable checkpoints. Deny public egress inside the scenario. Use only dummy
  harness credentials, the internal model proxy/mock, and loopback OTLP ledger.
  Never spend real model tokens or use live Langfuse credentials.

## Prepare a remote request

Use the protected host tool only after it is installed and its service reports a
healthy coordinator, independent provider inventory, continuous operation
ledger, and zero unresolved prior operations. The host tool must accept a
normalized request rather than an arbitrary command. Supply:

- task and approved operation IDs;
- exact source, candidate, manifest, selection, and image identities;
- one admitted scenario or bounded shard;
- requested TTL and idle deadline within the hard caps;
- a single-use environment-namespaced lease identity;
- the expected sanitized evidence and cleanup schema.

If the protected host tool is absent, the coordinator is unproved, provider
inventory is unavailable, or any identity is moving/dirty/unknown, stop and
report the missing prerequisite. Do not substitute a repository script.
The repo-local plan and retirement-profile scripts validate sanitized artifacts
only; they neither consume owner authority nor receive cloud credentials.

## Accept a result only after reconciliation

Require all of the following:

1. The inner scenario evidence binds the exact candidate, manifest, images,
   executor, runtime, and selected scenario.
2. Label-scoped Docker containers, networks, volumes, and images are absent.
3. Coordinator state and independently authenticated Hetzner inventory agree
   that the exact lease, server, and per-lease key are terminally absent.
4. The operation ledger has one continuous create-to-terminal history and the
   fixed identity was not substituted or replayed.
5. Evidence reports reserved cost, provider-observed billed cost when available,
   start/end times, cleanup attempts, and the outer/inner cleanup result without
   secrets, IP addresses, prompts, traces, raw terminal output, or user content.

Unknown, pending, lost-response, or cleanup disagreement is not success. Freeze
new acquisitions and invoke the attended incident path in `OPERATIONS.md`.

## State the claim honestly

Call a successful result remote development evidence. Do not call it a GitHub
check, release pass, harness support claim, or compatibility certification.
Re-run every required merge/release gate in GitHub CI.
