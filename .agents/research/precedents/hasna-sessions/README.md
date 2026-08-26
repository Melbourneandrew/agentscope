# Hasna Sessions

Research date: 2026-08-25. See [sources.md](sources.md) for exact provenance.

## Why it matters

Hasna Sessions is the strongest precedent in this set for historical native-transcript ingestion, SQLite indexing, full-text/semantic retrieval, and cross-agent resume workflows. It overlaps with an Agentscope native-artifact reader and Local SQLite retrieval surface, but its product center is a durable personal session archive rather than a hook-time telemetry pipeline.

## Product and architecture

**Observed:** `@hasna/sessions` exposes CLI, MCP, and server entrypoints. It discovers Claude, Codex, Codewith, and legacy Gemini session stores, normalizes sessions/messages/tool calls, persists them to SQLite, and layers search, recall, embeddings, graph, handoff, machine sync, and serving behavior over that index.

**Observed:** Local persistence is normal operation. The package's install lifecycle creates a user-level Sessions directory, and the database schema stores session metadata, message content, tool inputs/outputs, FTS rows, and optional embedding vectors.

**Observed:** Optional semantic indexing chunks stored message content, sends chunks to an OpenAI embeddings client by default, and persists both chunk text and vectors. Tests inject a fake embedder, but ordinary use reads `OPENAI_API_KEY`.

**Inference:** This is closer to a local memory/search product than to a destination-neutral observability producer. Its database is the product's canonical working index, whereas Agentscope's SQLite database is one explicitly selected Trace Destination.

## Capture and native parsing

**Observed:** Provider parsers implement a common interface: identify roots, enumerate files, parse normalized sessions, and optionally report ingestion safety metadata.

**Observed:** The ingestion coordinator snapshots size plus a parser-dependent modification signature before parsing and again afterward. It defers a file when it vanishes, changes during parsing, or ends with an incomplete JSONL record. Unchanged successful files are skipped through stored ingestion state.

**Observed:** The Codex parser recursively locates `rollout-*.jsonl` below the configured Codex sessions root. Its streaming rollout reader bounds raw lines, computes a source-content digest, recognizes incomplete trailing JSON, and can stage normalized rows in disposable SQLite rather than retaining an entire large rollout in memory.

**Observed:** Normalization includes session identity, cwd, CLI/model/provider metadata, Git fields, parent/fork/subagent context, messages, reasoning summaries, function calls, and function results.

**Observed:** When duplicate source snapshots exist, persistence favors the more complete record count, then newer source modification time, then a stable source-path tie-break. An explicit import-safety check rejects content shrink unless the caller supplies destructive intent and a reason.

**Inference:** Size plus modification time is a practical change detector, not source authenticity. A same-size rewrite with preserved modification metadata is not independently detected by the outer skip decision unless another parser signature changes; this is a source-level concern, not a demonstrated failure.

## Continuous operation and concurrency

**Observed:** An optional watcher combines recursive filesystem events, debounce, and a polling safety net. It persists per-source attempt/success/error state and exposes lag/status information.

**Observed:** Ingestion is serialized by a directory lock containing PID and start time. Staleness uses PID liveness and lock age.

**Inference:** PID-without-process-birth identity can confuse a reused PID with the original owner. Agentscope's process and lock authorities should continue to bind more than a numeric PID when cleanup or mutation depends on ownership.

## Privacy boundary

**Observed:** The normal index contains transcript text, reasoning, tool inputs, and tool outputs. Embedding mode can transmit message chunks to OpenAI and stores the chunks beside vectors. These are intentional product behaviors, not merely diagnostics.

**Inference:** Hasna's privacy contract is therefore materially different from Agentscope's mandatory pre-persistence redaction and transient pre-brand capture boundary. Its ingestion safety techniques are transferable; its data-retention defaults are not.

## Testing and compatibility

**Observed:** The project has substantial Bun tests with provider-shaped fixtures, including Codex duplicate/partial rollouts, parser behavior, database operations, search, embeddings, watcher state, MCP, server, and sync behavior.

**Observed:** The reviewed CI installs with a frozen lockfile and exercises package checks/tests. The Codex compatibility tests write synthetic rollout files; they do not start an installed Codex binary and observe a complete live lifecycle.

**Recommendation:** Reuse fixture ideas for component oracles, but do not treat fixture compatibility as release support evidence. Agentscope's real installed-harness scenario remains a separate acceptance boundary.

## What Agentscope should borrow

- Before/after source snapshots and explicit deferral of changing or incomplete files.
- Streaming JSONL parsing with raw-line ceilings and a content digest.
- Disposable staging storage for large native artifacts.
- A small parser contract that separates provider roots, enumeration, parsing, and ingestion evidence.
- Deterministic handling of partial/duplicate snapshots without silently shrinking stored history.
- Operational status for an eventual explicitly authorized historical-import or backfill mode.

## What Agentscope should avoid

- Treating a continuously updated local transcript index as Core's canonical store.
- Persisting raw prompts, reasoning, tool data, or embeddings before Agentscope redaction.
- Making a background watcher the primary capture authority.
- Using a custom sync protocol as the reporting abstraction.
- Treating synthetic parser fixtures as sufficient harness-support proof.

## Relationship to Agentscope decisions

- Trace Capture requires lifecycle-bound, fail-open capture with one immutable deadline and snapshot.
- Data Governance requires redaction before persistence or export.
- Canonical Trace Format requires OTLP/OpenInference semantics rather than a session-search schema.
- Local SQLite is an explicit destination, not a hidden Core index or retry store.
