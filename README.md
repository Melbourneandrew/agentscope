# AgentScope

> The overall goal is an agent scope system as a way to capture agent traces from coding agents CLIs and report them to external services like Langfuse.

AgentScope is a CLI-first observability toolkit for coding agents. It installs provider hooks, normalizes the resulting traces, and dispatches them through extensible reporters.

This repository is in its foundation phase. See [requirements](requirements/README.md), [blueprints](blueprints/README.md), and the [public documentation scaffold](apps/docs/content/docs/index.mdx).

## Planned packages

- `@agentscope/core` — normalized trace model and SDK.
- `@agentscope/cli` — `agent-scope` installation and configuration command.
- `@agentscope/reporter-langfuse` — first-party Langfuse reporter.
- `@agentscope/harness-*` — provider adapters.
- `@agentscope/testkit` — deterministic harness and reporter-test utilities.
