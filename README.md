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
</p>

Agentscope installs reversible integrations for coding-agent CLIs, converts
native lifecycle events into portable OpenTelemetry/OpenInference traces, and
sends them only to destinations you explicitly configure and select.

## Alpha status

Agentscope 0.1.0 is not published yet. The first alpha has admitted these exact
support rows; package publication is still pending:

| Harness     | Version | Execution                           | Capture                  | Destination credentials                                        |
| ----------- | ------- | ----------------------------------- | ------------------------ | -------------------------------------------------------------- |
| Codex       | 0.149.1 | CI execution: Linux x64, Node.js 22 | Interactive semantic PTY | Langfuse OTLP through explicit environment-variable references |
| Claude Code | 2.1.245 | CI execution: Linux x64, Node.js 22 | Interactive semantic PTY | Langfuse OTLP through explicit environment-variable references |

Claude Code capture covers `SessionStart`, `PreToolUse`, `PostToolUse`, and
`Stop`. It does not claim `SessionEnd` or a native end event. macOS, Keychain,
workstation execution, Cursor, and the remaining product-roster harnesses are
not 0.1.0 support claims.

Langfuse over OTLP is the admitted alpha destination. Local SQLite remains in
the source tree for future work, but 0.1.0 excludes its executable capability
and makes no SQLite support claim. Shipped assets or source paths outside the
table do not create additional support claims.

## Start here

- [Getting started](https://melbourneandrew.github.io/agentscope/docs/getting-started)
- [CLI reference](https://melbourneandrew.github.io/agentscope/docs/cli)
- [Product requirements](https://melbourneandrew.github.io/agentscope/docs/requirements/product-description)
- [Contributing](CONTRIBUTING.md)

After the alpha is published, install an explicit product selector:

```bash
npm install --global agentscope-cli@alpha
# Or pin the first alpha exactly:
npm install --global agentscope-cli@0.1.0

agentscope --version
```

Before the first stable release, do not use bare/default requests such as
`agentscope-cli` or `npx agentscope-cli`. They are not a product installation:
`latest` may resolve to the inert ownership bootstrap or may be absent. Select
`agentscope-cli@alpha` or an exact product version.

## How it works

```text
coding-agent harness hook
  -> first-party harness adapter
  -> Agentscope Core (normalize, redact, bounded fail-open delivery)
  -> explicitly selected trace destination
```

Agentscope does not infer a destination, retain a failed delivery for retry, or
replace an overlapping observability hook during ordinary installation.
Initialization, harness installation, and uninstall are plan-first. Destination
configuration writes immediately, so review its name and settings before
invoking it and inspect the saved destination afterward. Uninstall removes only
Agentscope-owned state.

Non-secret configuration lives under `~/.agentscope`. Credential values use a
governed credential backend or an explicit CI environment reference; they are
not stored in configuration or printed. Ordinary installed commands and hooks
ignore ambient `AGENTSCOPE_HOME`. It is reserved for repository-owned CI,
portable, and test launchers that explicitly authorize the override, not as a
user-facing relocation setting.

## Development

The monorepo uses pnpm 9, Nx, Node.js 22 or later, and a Fumadocs site.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test:unit
pnpm dev:docs
```

Use governed Nx targets when building packages with workspace dependencies;
for example, `pnpm nx run agentscope-cli:build`. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before running integration or full validation work.

Contributor workflows distinguish workstation execution, CI execution, and
Crabbox execution. All three use the shared hermetic scenario
runner/environment where integration applies, while their outer orchestration
and authority remain distinct. Crabbox is disposable development and burst
infrastructure, not an end-user installation path; GitHub CI remains release
authority.

Only `agentscope-cli` is intended for public installation. Protocol, Core,
harness, destination, and Testkit packages are internal implementation units,
not separate public SDKs.
