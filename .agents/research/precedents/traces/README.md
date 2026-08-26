# Traces

Research date: 2026-08-25. See [sources.md](sources.md) for exact provenance and the closed-source limitation.

## Why it matters

Traces is the closest precedent here for a user-facing multi-harness transcript-sharing product: discover local sessions, normalize them, index/search locally, associate them with Git, and selectively upload them for collaboration. It validates demand for cross-harness session discovery and retrieval, but its remote protocol and data model are not Agentscope's destination contract.

## Evidence boundary

**Observed:** The official npm package is published, but its registry metadata does not identify a public source repository or license. The analysis therefore relies on versioned npm identity plus official documentation, not source inspection.

**Consequence:** Claims about internal transactionality, redaction implementation, parser bounds, credential storage internals, cleanup, or test coverage remain unknown unless the documentation states them. This record does not infer source properties from UI behavior.

## Product and architecture

**Observed:** Traces captures conversations from coding-agent-owned JSON, JSONL, and SQLite stores, normalizes them into unified typed messages, keeps a local SQLite database, and can upload batches to a proprietary Traces API for highlights, summaries, sharing, teams, and MCP retrieval.

**Observed:** The compatibility matrix documents adapters for Claude Code, Cursor, OpenCode, Codex, Pi, Amp, Copilot, Cline, OpenClaw, Hermes, Droid, Grok, Kimi Code, Antigravity, Prime Agent, and fx. Detection uses known local signatures and supports selected path overrides.

**Observed:** `traces share` can auto-detect a recent session or take an explicit agent, source path, or trace ID. A follow mode and `traces refresh` update an existing shared trace as more events arrive.

**Observed:** Local commands list, search, and show bounded event content. Remote traces can be synchronized into the local database. `resume` can reopen an exact local native session on supported macOS builds and otherwise returns a continuation-required result.

**Inference:** Traces' canonical user object is a shareable normalized conversation/event record. Agentscope's canonical object is a redacted OTLP/OpenInference trace graph that independent destinations consume.

## Lifecycle integration

**Observed:** Traces can install project/global agent skills, project-local agent hooks, and Git hooks. Claude Code and Cursor hooks can pass active-session context; Codex and several other agents generally fall back to working-directory matching.

**Observed:** Setup and removal are exposed as paired commands, and Doctor checks agent detection and hook installation. Official docs state that `setup remove` removes project setup, agent hooks, and Git hooks.

**Observed:** A Git post-commit integration reads active trace IDs or searches recent sessions, records repository/branch/commit association in local SQLite, writes IDs and optional URLs to `refs/notes/traces`, launches background sharing, and pushes notes. It chains rather than overwrites an existing hook.

**Inference:** Git notes are a useful low-coupling association layer, but background upload and note mutation have different acknowledgement and failure semantics from Agentscope's single bounded hook deadline and no-spool Reporter contract.

## Privacy and trust boundary

**Observed:** Traces requires GitHub OAuth or scoped API keys for remote sharing. Organization settings can limit `public`, `direct`, and `private` visibility, and server-side validation blocks a disallowed choice.

**Observed:** The docs describe visibility controls, not a mandatory pre-persistence redaction grammar. Raw/normalized events are locally searchable, and sharing uploads message batches to the proprietary service for processing.

**Observed:** When trace content is rendered as Markdown for another agent, Traces wraps it in random boundary tags and marks it as historical context rather than instructions.

**Recommendation:** The historical-context boundary is a valuable retrieval-presentation precedent. It complements but does not replace Agentscope's requirement to redact before any destination or durable diagnostic receives trace data.

## Installation and distribution

**Observed:** Traces ships through Homebrew, an install script, and `@traces-sh/traces`; its updater can install a requested version. Official platform claims include macOS, Linux, Windows, and WSL variants.

**Inference:** Multi-channel distribution and self-update broaden the trust and compatibility surface. Agentscope should retain exact-candidate, packed-artifact, and platform-admission evidence rather than treating availability through several channels as compatibility proof.

## What Agentscope should borrow

- A discover/list/select step before sharing when session identity is ambiguous.
- Clear separation among local discovery, local search, explicit sharing, and remote synchronization.
- Bounded event presentation with explicit historical/untrusted-context framing.
- Git notes as a possible optional index from commits to external trace identities.
- Paired setup/remove commands plus Doctor visibility for managed integrations.
- Compatibility documentation that names native storage formats and integration surfaces.

## What Agentscope should avoid

- Making a proprietary upload API the reporter abstraction.
- Treating visibility selection as equivalent to mandatory content redaction.
- Relying on recent-working-directory matching when lifecycle identity is required.
- Starting detached/background delivery from a hook while claiming a bounded terminal outcome.
- Treating undocumented closed-source behavior as authority for cleanup, compatibility, or security decisions.

## Relationship to Agentscope decisions

- Agentscope reporters receive already-redacted canonical data and Langfuse reporting uses OTLP only.
- Hook-time reporting has one absolute deadline, no generic retry payload, and explicit unknown outcomes.
- Local SQLite is opt-in and stores branded Protocol traces, not an implicit global transcript cache.
- Harness support claims require exact installed-binary evidence rather than a format compatibility table alone.
