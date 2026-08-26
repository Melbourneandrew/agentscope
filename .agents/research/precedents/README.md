# Precedent research

This directory contains agent-only research about systems that illuminate part of Agentscope's problem space. It is intentionally outside the published documentation site.

These records are **non-authoritative**:

- Repository Requirements remain the user-facing source of truth.
- Approved Blueprints remain binding architecture.
- A recommendation here does not authorize implementation or alter a release gate.
- Records describe the exact reviewed revision and research date, not a perpetually current product.
- Third-party material is linked and summarized, not copied into this repository.

Use the explicit-only `$precedent-research` skill to add or update records. Each precedent directory keeps analysis in `README.md` and pinned provenance in `sources.md`; add more files only when the evidence genuinely needs them.

## Comparison method

Every record compares the same dimensions:

1. Product scope and primary user outcome
2. Capture timing and authority
3. Harness integration and lifecycle ownership
4. Canonical data model
5. Local persistence and synchronization
6. Remote delivery and interoperability
7. Search, retrieval, resume, or rewind behavior
8. Privacy and trust boundaries
9. Failure, concurrency, and cleanup model
10. Compatibility and process testing

Facts observed in source or official documentation are labeled **Observed**. Source-grounded conclusions that were not executed are labeled **Inference**. Proposed lessons for Agentscope are labeled **Recommendation**.

## Cross-system map

| System                                     | Closest Agentscope overlap                                     | Primary persistence                             | Integration style                                       | Most transferable lesson                                        | Fundamental difference                                     |
| ------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| [Hasna Sessions](hasna-sessions/README.md) | Historical transcript import, local SQLite retrieval           | SQLite plus optional object/cloud storage       | Scans provider-owned transcript files; optional watcher | Snapshot-aware, bounded native-artifact ingestion               | Transcript memory/search is the product center             |
| [Traces](traces/README.md)                 | Multi-harness discovery, local search, hooks, Git association  | Local SQLite plus proprietary remote service    | Adapters, skills, agent hooks, Git hooks                | Separate discovery, normalization, local retrieval, and sharing | Sharing/collaboration uses a proprietary API and model     |
| [Entire](entire/README.md)                 | Lifecycle hooks, Git context, checkpoints, attribution, resume | Git refs/branches and shadow state              | Installs agent and Git hooks                            | Git-native provenance and reversible checkpoint semantics       | Checkpoint/rewind is the product center, not OTLP delivery |
| [CodexBar](codexbar/README.md)             | Subprocess, PTY, fake executable, and live-probe testing       | App settings and provider-specific usage caches | Finds and invokes existing CLIs                         | Treat process supervision as a first-class lifecycle            | It monitors usage; it does not capture or route traces     |

## Agentscope's distinct center

Agentscope's approved center is standards-first, lifecycle-bounded observability:

`harness-native artifact -> transient CapturedTrace -> mandatory Core redaction -> branded OTLP/OpenInference trace -> independently selected Trace Destinations`

The precedents validate individual edges of this pipeline, but none combines its redaction authority, fail-open hook deadline, destination independence, and OTLP/OpenInference canonical model.
