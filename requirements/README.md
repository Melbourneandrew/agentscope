# AgentScope Product Requirements

## Overview

AgentScope gives coding-agent users one installable trace system that captures harness activity and reports it to Langfuse or other destinations without disrupting the agent session.

## Terminology

- **Agent harness:** a coding-agent runtime such as Codex, Claude Code, Gemini CLI, OpenCode, Pi, OpenClaw, or Hermes.
- **Trace destination:** a configured external service that receives normalized AgentScope traces.

## Requirements

### REQ-PROD-001: Portable agent observability

As a coding-agent user, I want a single trace system across supported harnesses, so that I can inspect comparable sessions regardless of which harness I use.

- **AC-PROD-001.1:** When a supported harness completes observable work, the system shall create a normalized trace without blocking the harness.
- **AC-PROD-001.2:** When Git and model metadata are available, the system shall include effective branch, commit, worktree, harness, model, usage, and timing context.

### REQ-PROD-002: Safe machine configuration

As a user, I want my AgentScope configuration in one predictable location, so that I can configure and diagnose it without exposing credentials.

- **AC-PROD-002.1:** When initialized without an override, the system shall store non-secret configuration under `~/.agentscope`.
- **AC-PROD-002.2:** When a secret is configured, the system shall store it in an OS credential store or consume an explicit CI secret reference rather than write it to `~/.agentscope`.

### REQ-PROD-003: Extensible reporting

As a platform developer, I want destination plugins with optional retrieval support, so that new backends do not require harness changes.

- **AC-PROD-003.1:** When a destination reporter is added, the system shall receive already-normalized and redacted trace data through the reporter contract.
- **AC-PROD-003.2:** When a destination supports retrieval, the CLI shall expose its mapped search capability without requiring every reporter to implement search.
