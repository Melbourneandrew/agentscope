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

Agentscope installs reversible integrations for coding-agent CLIs, converts their
native lifecycle events into portable OpenTelemetry/OpenInference traces, and
routes those traces to explicit first-party destinations.

## Status

Agentscope 0.1.0 is under active development and is not published yet. Codex and
Claude Code are the target harnesses for the first alpha, but neither is a public
support claim until its packed-CLI actual-binary admission finishes. Cursor and
the other product-roster harnesses are later work and do not block 0.1.0.

The source-built CLI exposes the command surface and a Langfuse destination
descriptor. Local SQLite is deferred from 0.1.0: its descriptor is present for
development, but the alpha will expose no executable Local SQLite capability or
support claim. The packed harness registry remains empty until admission.

## Start here

- [Getting started](https://melbourneandrew.github.io/agentscope/docs/getting-started)
- [CLI reference](https://melbourneandrew.github.io/agentscope/docs/cli)
- [Product requirements](https://melbourneandrew.github.io/agentscope/docs/requirements/product-description)
- [Contributing](CONTRIBUTING.md)

Do not install an unpublished artifact from an untrusted source. Once the alpha
is published, use `agentscope-cli@alpha` or the exact `0.1.0` version on a
platform listed in the release support manifest. A bare package install may
resolve only the inert ownership bootstrap before the first stable release.

## How it works

```text
coding-agent harness hook
  -> first-party harness adapter
  -> Agentscope Core (normalize, redact, bounded fail-open delivery)
  -> explicitly selected trace destination
```

Agentscope does not infer a destination, retain a failed delivery for retry, or
replace an overlapping observability hook during ordinary installation. Setup is
plan-first; mutation requires explicit confirmation, and uninstall removes only
Agentscope-owned state.

`~/.agentscope` stores non-secret machine configuration. The current CLI accepts
explicit CI environment references for destination credentials; a secure
interactive credential setup path is still required before the macOS alpha can
be offered to ordinary users. `AGENTSCOPE_HOME` is an explicit override for
portable installations, tests, and CI isolation.

## Development

The monorepo uses pnpm 9, Nx, Node.js 22 or later, and a Fumadocs site.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test:unit
pnpm dev:docs
```

Use the governed Nx targets when building a package with workspace dependencies;
for example, `pnpm nx run agentscope-cli:build`. See [CONTRIBUTING.md](CONTRIBUTING.md)
before running integration or full validation work.

Mutation-heavy integration is unavailable on workstations and shared Docker
daemons. GitHub-hosted CI and an already allocated disposable Crabbox guest run
the same `pnpm test:integration` controller.

## Contributing

Crabbox is contributor infrastructure for development and burst testing. GitHub
CI remains release authority; neither is an end-user installation path.

The [contributor guide](CONTRIBUTING.md) explains how to run the permitted checks.

## Repository packages

Only `agentscope-cli` is intended for public installation. Protocol, Core,
harness, destination, and Testkit packages are internal implementation units and
do not create separate public SDK or compatibility promises.
