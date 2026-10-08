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

Agentscope 0.1.0 is not published yet. Codex and Claude Code are the target
harnesses for the first alpha, but neither is supported until its exact
version, mode, platform, credential context, and OTLP path appear in the final
release support manifest.

The Claude Code 2.1.245 candidate profile under validation covers
`SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop`. It does not claim a
`SessionEnd` hook or native end event. Cursor and the remaining product-roster
harnesses are later work and do not block 0.1.0.

Langfuse over OTLP is the intended alpha destination. Local SQLite remains in
the source tree for future work, but the intended 0.1.0 release excludes its
executable capability and makes no SQLite support claim. That exclusion and the
runtime support rows are still being verified; this source checkout is not a
published product claim.

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

Do not use bare `agentscope-cli` or `npx agentscope-cli` before the first stable
release: the npm `latest` tag intentionally points to an inert ownership
bootstrap, not the product CLI.

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
not stored in configuration or printed. `AGENTSCOPE_HOME` is an explicit
override for portable installations, tests, and CI isolation.

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
