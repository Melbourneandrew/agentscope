# Entire CLI

Research date: 2026-08-25. See [sources.md](sources.md) for exact provenance.

## Why it matters

Entire is the strongest precedent here for lifecycle hooks, Git/worktree attribution, checkpoint identity, reversible session state, and resume/rewind. Its central question is “how was this code produced, and how can I return to that state?” Agentscope's central question is “how can harness activity become portable, redacted observability data without disrupting the harness?”

## Product and storage model

**Observed:** Entire installs Git and agent hooks, captures prompts/responses/files/tool data, creates checkpoints around commits, and associates session metadata with code history.

**Observed:** Active session state lives under Git administrative storage. Ephemeral checkpoints capture full state on shadow branches; persistent checkpoints store metadata and commit references through either a shared `entire/checkpoints/v1` branch or one-ref-per-checkpoint backend.

**Observed:** The persistent backend is pluggable but remains Git-backed. The branch backend shards checkpoint trees; the refs backend isolates each checkpoint ref and has its own push/fetch routing.

**Observed:** Session resume restores checkpointed metadata and prints native continuation commands. Rewind and attribution operate on Git snapshots rather than an OTLP trace store.

**Inference:** Git is both provenance graph and durable checkpoint database. This gives Entire strong commit affinity and distributed synchronization, but couples retention, visibility, and conflict behavior to repository topology.

## Harness and lifecycle integration

**Observed:** The reviewed source contains first-party hook adapters for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi, Copilot CLI, Factory Droid, and others. Each adapter maps native events into shared session/checkpoint lifecycle operations.

**Observed:** Hook installers preserve unrelated configuration fields, recognize and replace stale Entire-owned forms, add current commands, and provide uninstall/status behavior.

**Observed:** The Codex adapter manages several lifecycle events with explicit timeouts. Claude Code and Cursor commands are wrapped for silent/warning behavior and operating-system shell compatibility.

**Observed:** Entire also installs Git hooks and keeps checkpoint commits off the user's active branch. Worktrees receive independent session tracking, while concurrent sessions can share a base and retain distinct checkpoint identities.

**Recommendation:** Agentscope should borrow the explicit adapter lifecycle vocabulary and stale-owned-hook migration thinking, but its binding launcher/no-shell and transaction requirements remain stricter than the reviewed Entire wrapper approach.

## Attribution and Git context

**Observed:** Entire snapshots state around prompt boundaries and compares base, shadow, and worktree state to estimate agent and human changes. Its attribution model uses Git diffs/blame and preserves checkpoint/session links.

**Observed:** Prompt-time snapshots intentionally occur before the agent runs, helping separate user edits between prompts from agent work during a prompt.

**Inference:** This is a valuable precedent for provenance that OTLP attributes alone cannot reconstruct. Agentscope can learn from the observation points without adopting Git snapshots as its trace model.

## Privacy model

**Observed:** Entire sanitizes copied transcripts and applies secret redaction before persistent checkpoint storage. It supports custom redaction packs and documents telemetry exclusions.

**Observed:** The documentation explicitly calls redaction best-effort and warns that temporary shadow branches may contain unredacted data and must not be pushed. It also warns that checkpoint metadata in a public repository is public unless redirected.

**Inference:** Entire makes a pragmatic durability/privacy tradeoff for rewind fidelity. Agentscope's mandatory pre-persistence redaction and suppression on unresolved policy are deliberately stronger and less permissive.

## Failure, concurrency, and recovery

**Observed:** Entire models ephemeral and persistent checkpoints separately, has Doctor/clean paths for stuck state, supports worktree-aware sessions, and documents concurrent session interleaving.

**Observed:** Checkpoint identity and storage topology are explicit rather than inferred from timestamps alone. Newer refs-based storage reduces contention compared with a single shared branch.

**Recommendation:** Preserve the lessons—distinct ephemeral/persistent states, explicit IDs, separate worktree authority, and repair tooling—without importing a shadow-branch payload store into Agentscope Core.

## Testing and compatibility

**Observed:** The repository contains adapter-specific hook tests, shared hook architecture tests, checkpoint storage tests, worktree/concurrency scenarios, backwards-compatibility tests, and integration tests around Git behavior.

**Observed:** Provider fixture tests validate native JSON/JSONL shapes. This is stronger than a generic adapter mock but remains distinct from Agentscope's release requirement to execute each exact installed harness against isolated mocks.

## What Agentscope should borrow

- Separate ephemeral activity from durable published state.
- Stable session/checkpoint identities tied to concrete Git/worktree context.
- Prompt-boundary snapshots for attribution and provenance.
- Worktree-aware concurrency rather than repository-global session identity.
- Owned-hook recognition, stale-version migration, uninstall, Doctor, and recovery paths.
- Git notes/refs as optional provenance indexes where they do not become trace authority.

## What Agentscope should avoid

- Using Git branches or refs as the canonical trace/destination store.
- Retaining an unredacted shadow copy as a normal lifecycle stage.
- Treating best-effort redaction as sufficient for destination admission.
- Copying shell-wrapped hook commands into a no-shell launcher contract.
- Conflating checkpoint fidelity with observability interoperability.

## Relationship to Agentscope decisions

- Agentscope captures one transient native boundary, redacts in Core, and exports a branded OTLP/OpenInference graph.
- Git/worktree fields are provenance inside that graph, not the persistence substrate.
- Hook installation is an owned, reversible transaction with stronger path and recovery identity.
- Core creates no spool, shadow branch, retry payload, or detached delivery work.
