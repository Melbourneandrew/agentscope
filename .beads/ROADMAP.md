# Agentscope implementation roadmap certification

This is the Git-side index for the executable Beads program. The original certified plan remains the stable-product baseline; approved milestone overlays may add a narrower release path without deleting its obligations. Issue bodies, dependencies, status transitions, and audit history remain authoritative in the Dolt store.

- Beads root: `agentscope-vah`
- Certified Dolt branch/revision: `main` / `mejtm8ht98e4f7uuii81krdg5676cl9v`
- Planning PR: [#9](https://github.com/Melbourneandrew/agentscope/pull/9)
- Inventory at certification: 149 total issues; 92 open; 0 in progress; 89 blocked; 57 closed
- Graph checks: `bd lint`, `bd orphans`, and `bd dep cycles` pass

Implementers must run `bd dolt pull`, select ready leaf work rather than a ready epic, and create linked follow-up Beads whenever implementation evidence invalidates an assumption. A phase certification task closes its parent epic only after every child is complete, two independent agent review comments are resolved, gates pass, the PR is squash-merged, and main is verified.

## Delivery sequence

| Phase | Epic | Primary branch scope |
| --- | --- | --- |
| Planning | `agentscope-vah.1` | `codex/andrew/implementation-roadmap` |
| 1. Foundation and quality | `agentscope-vah.2` | `codex/andrew/01-foundation-quality` |
| 2. Protocol | `agentscope-vah.3` | `codex/andrew/02-protocol` |
| 3. Destination contracts | `agentscope-vah.4` | `codex/andrew/03-destination-contracts` |
| 4. Hermetic test platform | `agentscope-vah.5` | `codex/andrew/04-integration-platform` |
| 5. Configuration and credentials | `agentscope-vah.7` | `codex/andrew/05-config-security` |
| 6. Core runtime | `agentscope-vah.6` | `codex/andrew/06-core-runtime` |
| 7. Harness core and hooks | `agentscope-vah.10` | `codex/andrew/07-harness-core` |
| 8. CLI lifecycle | `agentscope-vah.8` | `codex/andrew/08-cli-lifecycle` |
| 9. Destinations | `agentscope-vah.9` | `codex/andrew/09a-*`, `09b-*`, `09c-*` |
| 10. Real harness matrix | `agentscope-vah.11` | one `codex/andrew/10-*` PR per harness plus certification |
| 11. CI, release, and docs | `agentscope-vah.12` | `codex/andrew/11-delivery-automation` |
| 12. Maturity certification | `agentscope-vah.13` | `codex/andrew/12-maturity-certification` |

## Version 0.1.0 delivery milestone overlay

The first public milestone is an exact installable version `0.1.0` of the owned Agentscope CLI package. `agentscope-vah.12.8` must prove ownership of the currently intended `@agentscope/cli` identity or reconcile the public package name before release. This is a bounded delivery profile, not completion of the stable-product sequence above.

| Track | Epic | Authority and delivery boundary |
| --- | --- | --- |
| Version 0.1.0 release governance | `agentscope-rk8` | Approved product requirements, then a separate user-approved Blueprint and exact-artifact publication lane |
| Harness execution testing research | `agentscope-t4p` | Research and a standalone user-approved Blueprint before shared runner or PTY implementation |
| Safe remote development fleet | `agentscope-0fc` | Optional Crabbox acceleration outside the hermetic Docker boundary; GitHub CI remains release authority |
| Common installed-CLI and harness verification | `agentscope-c1k` | Bounded supervisor, installed-CLI contracts, independent ledgers, and later PTY lanes |
| Three-harness 0.1.0 implementation | `agentscope-wth` | Codex, Claude Code, and Cursor split-pushed in isolated branches, then an unconditional pinned PR matrix |

Version `0.1.0` must not wait for the remaining roster harnesses, complete historical SQLite migration and maintenance certification, broad native-platform claims, or the full interactive-mode matrix. It must retain the original planned real-harness, exact packed-artifact, fail-open, redaction, isolation, and destination evidence gates. Cursor implementation and dependency regraphing cannot begin until the requirements change and its subsequent standalone Blueprint are approved and merged.

The Phase 4 platform is proven with a purpose-built process fixture. It does not claim that the later CLI, destinations, or harnesses exist. The first exact packed-CLI lifecycle is `agentscope-vah.9.9`, after both first-party destinations exist. The original seven actual harness binaries remain assigned to `agentscope-vah.11.1` through `.11.7`; the authority-gated Cursor 0.1.0 lane is assigned to `agentscope-wth.4`. Dependency reconciliation remains `agentscope-rk8.3` work after the requirements and Blueprint gates merge.

## Requirement acceptance-criterion ownership

Every mandatory criterion present at this revision has an implementation owner and final evidence owner. `agentscope-vah.2.5` implements the machine-readable validator; `agentscope-vah.12.2` enforces it in CI; `agentscope-vah.13.5` and `.13.6` perform final reconciliation.

| Acceptance criteria | Primary delivery owners |
| --- | --- |
| `AC-OVR-001.1`, `AC-OVR-002.1` | `vah.3.2-.3.4`, `vah.6.1-.6.4`, `vah.10.2-.10.4`, `vah.11.1-.11.9` |
| `AC-INS-001.1`, `AC-INS-001.2`, `AC-INS-001.3`, `AC-INS-001.4`, `AC-INS-002.1`, `AC-INS-002.2`, `AC-INS-002.3`, `AC-INS-003.1`, `AC-INS-003.2` | `vah.2.2`, `vah.2.5`, `vah.8.3`, `vah.9.9`, `vah.12.2`, `vah.12.4` |
| `AC-CLI-001.1`, `AC-CLI-001.2`, `AC-CLI-001.3`, `AC-CLI-001.4`, `AC-CLI-002.1`, `AC-CLI-002.2`, `AC-CLI-002.3`, `AC-CLI-002.4` | `vah.2.5`, `vah.8.1`, `vah.8.6-.8.7`, `vah.12.2`, `vah.12.4` |
| `AC-PLAT-001.1`, `AC-PLAT-001.2`, `AC-PLAT-001.3`, `AC-PLAT-002.1`, `AC-PLAT-002.2`, `AC-PLAT-002.3` | `vah.2.7`, `vah.7.4-.7.6`, `vah.9.4`, `vah.11.1-.11.7`, `vah.12.1`, `vah.12.7` |
| `AC-DOC-001.1`, `AC-DOC-001.2`, `AC-DOC-001.3`, `AC-DOC-001.4`, `AC-DOC-001.5`, `AC-DOC-001.6`, `AC-DOC-001.7`, `AC-DOC-002.1`, `AC-DOC-002.2` | `vah.7.7`, `vah.8.6`, `vah.9.7`, `vah.12.6-.12.7` |
| `AC-CFG-001.1`, `AC-CFG-001.2`, `AC-CFG-002.1`, `AC-CFG-002.2`, `AC-CFG-002.3` | `vah.7.1-.7.3`, `vah.7.7-.7.8` |
| `AC-INIT-001.1`, `AC-INIT-001.2`, `AC-INIT-001.3`, `AC-INIT-002.1`, `AC-INIT-002.2`, `AC-INIT-002.3`, `AC-INIT-002.4`, `AC-INIT-002.5`, `AC-INIT-003.1`, `AC-INIT-003.2`, `AC-INIT-003.3` | `vah.8.2-.8.3`, `vah.9.9`, `vah.10.1`, `vah.11.1-.11.7` |
| `AC-GOV-001.1`, `AC-GOV-001.2`, `AC-GOV-001.3`, `AC-GOV-001.4`, `AC-GOV-001.5`, `AC-GOV-002.1`, `AC-GOV-002.2` | `vah.3.3-.3.4`, `vah.6.1-.6.4`, `vah.13.3` |
| `AC-HAR-001.1`, `AC-HAR-001.2`, `AC-HAR-002.1`, `AC-HAR-003.1`, `AC-HAR-003.2`, `AC-HAR-003.3` | `vah.10.1-.10.4`, `vah.8.3-.8.4`, `vah.11.1-.11.11`, `agentscope-rk8.3`, `agentscope-wth.2-.wth.6` |
| `AC-SQL-001.1-.001.4`, `AC-SQL-002.1-.002.6`, `AC-SQL-003.1-.003.3` | `vah.9.4-.9.7`, `vah.12.10` |
| `AC-REP-001.1-.001.3`, `AC-REP-002.1`, `AC-REP-003.1-.003.4`, `AC-REP-004.1-.004.2` | `vah.4.1`, `vah.4.3`, `vah.6.2`, `vah.9.2`, `vah.9.5`, `agentscope-vah.12.11`, `agentscope-wth.8` |
| `AC-CAP-001.1`, `AC-CAP-001.2`, `AC-CAP-001.3`, `AC-CAP-002.1`, `AC-CAP-002.2`, `AC-CAP-002.3`, `AC-CAP-002.4`, `AC-CAP-002.5`, `AC-CAP-002.6`, `AC-CAP-002.7` | `vah.6.1-.6.3`, `vah.8.4`, `vah.10.2-.10.4`, `vah.11.1-.11.9` |
| `AC-CONN-001.1`, `AC-CONN-001.2`, `AC-CONN-002.1`, `AC-CONN-002.2`, `AC-CONN-002.3` | `vah.7.2-.7.3`, `vah.8.2`, `vah.9.2`, `vah.9.5` |
| `AC-RET-001.1`, `AC-RET-001.2`, `AC-RET-001.3`, `AC-RET-002.1`, `AC-RET-002.2`, `AC-RET-002.3`, `AC-RET-003.1`, `AC-RET-003.2`, `AC-RET-003.3`, `AC-RET-003.4` | `vah.4.2-.4.3`, `vah.6.4`, `vah.8.5`, `vah.9.3`, `vah.9.6` |

`agentscope-vah.2.1` adds or corrects missing user-facing requirements before implementation. It must update this crosswalk for every changed `AC-*` identifier before closing; the evidence validator discovers criteria dynamically and does not hardcode the count above.

## Blueprint ADR ownership

Each row assigns every listed ADR in that Blueprint to implementation and verification Beads. Phase certification and `agentscope-vah.13.5` re-open the decision when implementation evidence contradicts it.

| Blueprint | ADRs | Delivery owners |
| --- | --- | --- |
| `foundations/canonical-trace-format` | `ADR-001`–`ADR-006` | `vah.3.2-.3.4`, `vah.6.1`, `vah.13.5` |
| `foundations/harness-abstraction` | `ADR-001`, `ADR-002` | `vah.10.1-.10.4`, `vah.11.1-.11.11` |
| `foundations/native-trace-mapping` | `ADR-001`–`ADR-003` | `vah.3.3`, `vah.10.2`, `vah.11.1-.11.9` |
| `foundations/observability-interoperability` | `ADR-001`, `ADR-002` | `vah.3.1-.3.4`, `vah.9.2-.9.3` |
| `foundations/protocol-package` | `ADR-001`, `ADR-002` | `vah.2.2-.2.4`, `vah.3.1-.3.5` |
| `foundations/workspace-architecture` | `ADR-001`–`ADR-004` | `vah.2.1-.2.6`, `vah.13.1` |
| `destinations/trace-destination` | `ADR-001`–`ADR-006` | `vah.4.1-.4.4`, `vah.6.2`, `vah.7.2-.7.3`, `vah.8.2` |
| `destinations/reporters/reporter-abstraction` | `ADR-001`–`ADR-007` | `vah.2.1`, `vah.4.1`, `vah.4.3-.4.4`, `vah.6.2` |
| `destinations/reporters/langfuse-reporter` | `ADR-001`–`ADR-003` | `vah.9.1-.9.2`, `vah.12.6` |
| `destinations/retrievers/retriever-abstraction` | `ADR-001`–`ADR-006` | `vah.4.2-.4.4`, `vah.6.4`, `vah.8.5` |
| `destinations/retrievers/query-and-pagination` | `ADR-001`–`ADR-006` | `vah.4.2-.4.4`, `vah.8.5`, `vah.9.3`, `vah.9.6` |
| `destinations/retrievers/langfuse-retriever` | `ADR-001`–`ADR-006` | `vah.9.1`, `vah.9.3`, `vah.9.7`, `vah.12.6` |
| `destinations/local-sqlite-destination` | `ADR-001`–`ADR-006` | `vah.9.4-.9.7` |
| `operations/agentscope-init` | `ADR-001`, `ADR-002` | `vah.8.2`, `vah.9.9`, `vah.11.1-.11.7` |
| `operations/api-key-storage` | `ADR-001`–`ADR-004` | `vah.2.7`, `vah.7.3-.7.8`, `vah.12.7`, `vah.12.9` |
| `operations/cli-architecture` | `ADR-001`–`ADR-003` | `vah.2.5`, `vah.8.1-.8.7`, `vah.9.9` |
| `operations/cli-installation` | `ADR-001`–`ADR-003` | `vah.2.2`, `vah.2.5`, `vah.9.9`, `vah.12.4` |
| `operations/code-quality-and-ci` | `ADR-001`–`ADR-004` | `vah.2.2-.2.6`, `vah.12.1-.12.5`, `vah.13.1` |
| `operations/config-management` | `ADR-001`–`ADR-003` | `vah.7.1-.7.3`, `vah.7.8` |
| `operations/configuration-extensibility` | `ADR-001`–`ADR-003` | `vah.4.1-.4.2`, `vah.7.1-.7.3`, `vah.8.2` |
| `operations/continuous-integration` | `ADR-001`–`ADR-004` | `vah.2.5`, `vah.2.7`, `vah.5.5`, `vah.12.1-.12.9` |
| `operations/documentation-site` | `ADR-001`–`ADR-003` | `vah.8.6`, `vah.12.4-.12.5` |
| `operations/harness-discovery` | `ADR-001`, `ADR-002` | `vah.10.1`, `vah.8.2-.8.3`, `vah.11.1-.11.7` |
| `operations/hook-installation` | `ADR-001`–`ADR-004` | `vah.10.3-.10.5`, `vah.8.3-.8.4`, `vah.9.9`, `vah.11.1-.11.9` |
| `operations/npm-publishing` | `ADR-001`, `ADR-002` | `vah.2.2`, `vah.2.5`, `vah.2.7`, `vah.12.4-.12.5`, `vah.12.8` |
| `operations/operational-state` | `ADR-001`–`ADR-003` | `vah.6.3`, `vah.7.2`, `vah.7.7`, `vah.8.6` |
| `testing/test-strategy` | `ADR-001`–`ADR-003` | `vah.2.3-.2.5`, `vah.4.3`, `vah.5.1-.5.6`, `vah.11.1-.11.11` |
| `testing/unit-testing` | `ADR-001`–`ADR-004` | `vah.2.4`, `vah.3.4`, `vah.4.3`, `vah.10.4`, `vah.11.8`, `vah.11.11` |
| `testing/real-harness-integration` | `ADR-001` | `vah.5.1-.5.6`, `vah.9.9`, `vah.11.1-.11.10` |
| `testing/integration/ci-execution` | `ADR-001`, `ADR-002` | `vah.5.1`, `vah.5.5`, `vah.12.1-.12.2` |
| `testing/integration/container-isolation` | `ADR-001`, `ADR-002` | `vah.5.2`, `vah.5.5-.5.6`, `vah.9.9`, `vah.11.1-.11.9` |
| `testing/integration/matrix-operations` | `ADR-001`–`ADR-004` | `vah.5.1`, `vah.5.5`, `vah.11.8-.11.11`, `vah.12.1` |
| `testing/integration/mock-services` | `ADR-001`–`ADR-003` | `vah.5.3-.5.6`, `vah.9.7`, `vah.11.1-.11.9` |

## Certified scope decisions

- The implementation is standards-first and may replace all disposable SF-derived code; it has no compatibility obligation to that code.
- OpenTelemetry/OpenInference plus namespaced `agentscope.*` extensions form the protocol model; private Protocol/Core packages are not a published SDK.
- Only the bundled CLI artifact is public. The workspace uses `@agentscope/cli`; `vah.12.8` must prove ownership or reconcile the final owned public package identity before release because the unscoped `agentscope` name is already owned elsewhere. The executable remains `agentscope`. First-party harness and destination packages are private implementation modules, not a runtime plugin system.
- The supported harness roster is Codex, Claude Code, Cursor, Gemini CLI, OpenCode, Pi, OpenClaw, and Hermes. Version `0.1.0` claims only Codex, Claude Code, and Cursor at evidenced versions and execution modes; the remaining integrations stay open after that milestone.
- Hooks fail open. Core does not persist trace-content retries. Local SQLite stores traces only when explicitly configured as a destination.
- Real model protocols use digest-pinned MockServer in disposable containers. No test exposes a developer's active harness, home, worktree, credentials, or `~/.agentscope` to mocked traffic.
- Credential adapters are implemented and contract-tested before Core; real native backend evidence runs later on trusted supported-platform CI runners.
- Langfuse reporting uses OTLP only. Automated Langfuse evidence is hermetic and loopback-contained; it does not use a public Langfuse service or live Langfuse credential.
