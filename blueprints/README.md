# AgentScope architecture blueprint

## Proposed architecture

```mermaid
flowchart LR
  H["Codex / Claude Code / Cursor"] --> A["Harness adapter"]
  A --> C["@agentscope/core\nnormalized events + redaction"]
  C --> Q["bounded local queue / spool"]
  Q --> R["Reporter interface"]
  R --> L["Langfuse"]
  R --> O["Console / custom destinations"]
  CLI["agent-scope CLI"] --> H
  CLI --> CFG["OS config + credential store"]
  CLI --> C
```

## Package boundaries

| Package                  | Responsibility                                                         | Must not own                               |
| ------------------------ | ---------------------------------------------------------------------- | ------------------------------------------ |
| `@agentscope/core`       | Event contracts, redaction, queue lifecycle, reporter contract, SDK    | provider hook mutation or destination SDKs |
| `@agentscope/cli`        | Config, credentials, lifecycle, diagnostics, installation transactions | parsing provider transcripts               |
| `@agentscope/harness-*`  | Provider configuration and trace extraction                            | reporter-specific mapping                  |
| `@agentscope/reporter-*` | Convert normalized events to a destination protocol                    | provider-specific files or hook mutation   |
| `@agentscope/testkit`    | Contract fixtures, fake collector, assertions                          | production configuration                   |

## CLI contract (initial)

```text
agent-scope init
agent-scope configure reporter langfuse
agent-scope install codex
agent-scope status
agent-scope doctor
agent-scope capture replay <fixture>
agent-scope uninstall codex
```

`init` creates the global config directory and selects a reporter. `install` detects an existing provider installation, writes a reversible hook configuration transaction, and records the provider version. A hook invokes the stable CLI executable rather than embedding implementation code in provider config.

## Reporter plugin interface

The stable v1 interface should be intentionally small:

```ts
export interface Reporter {
  readonly id: string;
  initialize(context: ReporterContext): Promise<void>;
  report(batch: AgentScopeEvent[]): Promise<ReportResult>;
  shutdown(): Promise<void>;
}
```

Reporters receive events only after core validation and redaction. Retry classification, backpressure, dead-letter policy, and idempotency keys remain owned by core so all destinations behave predictably.

## Langfuse compatibility boundary

Langfuse's official Codex and Claude Code plugins are the reference behavior for their own destination: they run a Stop hook, read the provider transcript, emit a session-grouped turn hierarchy, backdate observations, and maintain state to prevent duplicate uploads. AgentScope should use these as compatibility requirements, not as a code dependency or a second hook to run in parallel.

When `@agentscope/reporter-langfuse` is active, the rendered hierarchy is:

```text
session
└── turn trace / agent observation
    ├── model generation (input, output, usage, reasoning summary)
    │   └── tool spans (input, output, status, duration)
    └── child-agent turn traces
```

The CLI detects the official plugin/configuration during `install` and `doctor`. The default action is a non-destructive conflict report with migration instructions; only an explicit `agent-scope install <harness> --replace-langfuse` may disable or replace the overlapping hook. Test fixtures must include conflict detection, migration rollback, duplicate prevention, layered config precedence, and fail-open behavior.

## Integration-test blueprint

1. **Contract tests:** fast unit tests for schema, redaction, queues, and reporter semantics.
2. **Adapter fixtures:** checked-in, sanitized native artifacts for each supported harness and version family.
3. **Container matrix:** Docker Compose launches a mock collector and an integration runner. The runner creates a temporary home/config directory, installs the built CLI, executes each harness fixture, then asserts captured normalized and reporter payloads.
4. **Real CLI installation tests:** test hook installation with disposable configuration directories. Never modify a developer's real provider settings.
5. **Live smoke test:** scheduled/manual workflow uses a protected GitHub Environment, sends one synthetic trace to Langfuse, and verifies receipt by API. It is never a pull-request gate.
6. **Compatibility fixtures:** sanitized transcript fixtures verify that the Langfuse reporter produces one session grouping, one idempotent turn hierarchy, accurate timestamps, model usage, tool status, and subagent nesting without the official plugin or a live Langfuse project in CI.

Docker is preferred to a dedicated VM for v1 because the fixtures are file/process driven and must be reproducible in CI. Add a macOS runner only after a provider exposes functionality unavailable in Linux containers.

## Delivery slices

1. Establish package builds and migrate source with parity tests.
2. Implement the CLI config/credential and transaction layer.
3. Extract first Codex harness and console reporter; complete the local Docker test path.
4. Add Langfuse, Claude Code, and Cursor adapters with fixture coverage.
5. Stabilize plugin ABI and publish public packages.
