<p align="center">
  <a href="https://melbourneandrew.github.io/agentscope/docs">
    <img src="https://raw.githubusercontent.com/Melbourneandrew/agentscope/main/apps/docs/public/brand/agentscope-oscilloscope-logo.svg" width="112" alt="Agentscope oscilloscope logo" />
  </a>
</p>

<h1 align="center">Agentscope</h1>

<p align="center">CLI-first trace observability for coding-agent harnesses.</p>

<p align="center">
  <a href="https://github.com/Melbourneandrew/agentscope/actions/workflows/pr-validation.yml"><img src="https://github.com/Melbourneandrew/agentscope/actions/workflows/pr-validation.yml/badge.svg" alt="Validation" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white" alt="Node.js 22 or later" /></a>
  <a href="https://melbourneandrew.github.io/agentscope/docs"><img src="https://img.shields.io/badge/docs-GitHub%20Pages-4B7F18" alt="Documentation" /></a>
  <a href="https://github.com/Melbourneandrew/agentscope/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-TBD-6B7280" alt="License to be decided" /></a>
</p>

> The overall goal is an agent scope system as a way to capture agent traces from coding agents CLIs and report them to external services like Langfuse.

Agentscope installs safe, reversible integrations for coding-agent **harnesses** such as Codex, Claude Code, Gemini CLI, OpenCode, Pi, OpenClaw (CLAW), and Hermes. It normalizes sessions, model activity, tools, Git context, and errors into OpenInference-shaped portable traces, then reports them through supported first-party destination packages.

## Status

Agentscope is in its foundation phase. The monorepo, public documentation, CI structure, integration-test blueprint, and initial source migration are in place; the publishable CLI and production reporters are not available yet.

## Documentation

- [Documentation site](https://melbourneandrew.github.io/agentscope/docs)
- [Product requirements](https://melbourneandrew.github.io/agentscope/docs/requirements/product-description)
- [Integration-test blueprint](https://melbourneandrew.github.io/agentscope/docs/blueprints/testing/real-harness-integration)
- [Local contributor guide](CONTRIBUTING.md)

## Planned usage

```bash
# Planned public CLI, not yet published
npx agentscope-cli init
agentscope destination configure langfuse
agentscope install codex
agentscope doctor
```

The CLI will use the unhyphenated `agentscope` command. Non-secret machine configuration lives in `~/.agentscope`; credentials use the OS credential store, and `AGENTSCOPE_HOME` is reserved for explicit test/CI isolation.

## Architecture

```text
agent harness hook
  -> harness adapter
  -> Agentscope Protocol (OpenTelemetry/OpenInference + agentscope.*)
  -> Agentscope Core (redact, bounded delivery)
  -> Trace Destination reporter (Langfuse / OTLP / custom destination)
```

Harness adapters own native configuration and extraction. Protocol owns the OpenTelemetry/OpenInference contract; Core owns redaction, configuration, and one bounded fail-open delivery attempt. A failed attempt drops the trace rather than storing it for later retry. Destination packages own destination protocol mapping and may optionally add retrieval support to the CLI. New harnesses and destinations are contributed through normal reviewed pull requests; Agentscope has no runtime plugin system.

## Packages

| Package                     | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `@agentscope/protocol`      | Private OpenTelemetry/OpenInference contract             |
| `@agentscope/core`          | Private configuration, redaction, and delivery services  |
| `agentscope-cli`            | The `agentscope` installation and configuration command  |
| `@agentscope/harness-*`     | Harness-specific installation and trace extraction       |
| `@agentscope/destination-*` | First-party trace destinations, starting with Langfuse   |
| `@agentscope/testkit`       | Hermetic test servers, harness scenarios, and assertions |

## Development

Agentscope uses pnpm, Nx, Node.js 22+, and a Fumadocs documentation application.

```bash
pnpm install
pnpm test:unit
pnpm test:integration
pnpm dev:docs
```

Unit tests cover deterministic core, adapter, and reporter contracts. Integration tests are a separate lane: they run real harness executables in isolated homes and Git workspaces against mock model and telemetry endpoints. See the [integration blueprint](https://melbourneandrew.github.io/agentscope/docs/blueprints/testing/real-harness-integration) for the intended matrix.

Mutation-heavy integration is unavailable on workstations and shared Docker
daemons. GitHub-hosted CI and an already allocated disposable Crabbox guest run
the same `pnpm test:integration` controller.

## Contributing

Issues and pull requests are welcome once the initial package contracts settle. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and keep changes scoped; protected branches use PR validation, squash merges, and automatic documentation deployment.
