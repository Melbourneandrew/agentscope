# Agentscope Framework

Agentscope is the Software Factory trace observability framework for coding-agent sessions.

It owns provider trace discovery, normalized trace schemas, native turn slicing, trace operations, and optional code attribution exports. Hook frameworks such as Tacklebox can trigger Agentscope capture on lifecycle signals, but Agentscope does not depend on hook request types or vendor tracing clients.

Initial provider scope:

- Cursor
- Codex
- Claude Code

Public entry points:

- `@sf-platform/agentscope-framework/native-traces`: normalized trace schema, provider adapters, and registry.
- `@sf-platform/agentscope-framework/native-turns`: provider-specific native turn slicing helpers.
- `@sf-platform/agentscope-framework/agent-trace`: Agent Trace RFC record schemas and conversion helpers.
- `@sf-platform/agentscope-framework/testing`: deterministic native-turn fixtures and OTel attribute assertions for hook-app tests.

Native turn trace construction is provider-specific:

- `cursor.buildNativeTurnTrace({ sessionId, turnId, sourcePath })`
- `codex.buildNativeTurnTrace({ sessionId, turnId, sourcePath })`
- `claude.buildNativeTurnTrace({ sessionId, sourcePath })`

Native turn helpers preserve the native session id and turn-specific provider
trace id while returning a normalized `NativeAgentTrace`. Hook applications own
their reporting metadata, destination-specific span planning, and export
behavior.

Use `@sf-platform/agentscope-framework/testing` when hook-app tests need
provider-native fixture workspaces. Production route and reporting APIs should
not accept test-only dependency bags for plan builders or exporters.

Agent Trace support is intentionally conservative: Agentscope can validate records and convert a native session into an attribution record when callers supply file/line ranges. Exact range attribution should come from a diff or commit-aware integration instead of being inferred from transcript text alone.
