# Product requirements

## Product description

The overall goal is an agent scope system as a way to capture agent traces from coding agents CLIs and report them to external services like Langfuse.

AgentScope gives an individual developer or organization a single installable control plane for coding-agent observability. It must capture useful lifecycle and artifact evidence without becoming a proxy for the agent or requiring an application to adopt a specific runtime.

## Users and outcomes

- **Individual developer:** runs `npx @agentscope/cli init`, selects a harness and a reporter, and gets useful trace visibility without hand-editing opaque hook files.
- **Platform team:** distributes a declarative configuration, centrally selects reporters/redaction, and verifies installation health across machines.
- **Reporter author:** implements a stable TypeScript reporter interface and tests it against the official contract suite.

## Functional requirements

1. A global CLI installs, updates, verifies, and removes supported coding-agent harnesses.
2. The CLI stores global configuration in the platform configuration directory (`$XDG_CONFIG_HOME/agent-scope`, `%APPDATA%\\agent-scope`, or `~/Library/Application Support/agent-scope`) and secrets in the OS credential store where possible.
3. Core exposes a stable TypeScript SDK and a versioned normalized event schema for sessions, turns, tool use, skills, files, errors, and flush results.
4. Harnesses are independently versioned adapters for Codex, Claude Code, and Cursor; unsupported versions fail clearly and non-destructively.
5. Reporters are plugins. Bundled console and Langfuse reporters work out of the box; third parties can be loaded by package reference from explicit configuration.
6. Redaction occurs before events are queued or passed to reporters. Local spool data is encrypted or intentionally disabled by policy.
7. Every harness-reporter combination has deterministic integration coverage; no CI test requires a paid SaaS endpoint.
8. A protected live smoke test can use Langfuse credentials to detect API integration drift without exposing secrets to pull requests.

## Non-functional requirements

- Hook execution must be bounded, asynchronous where the host permits, and must never make an agent session unusable because reporting fails.
- Configuration changes must be idempotent and reversible, with backups and `doctor` diagnostics.
- Public packages must publish with provenance through npm trusted publishing.
- User-facing documentation is a static Fumadocs site deployed to GitHub Pages.

## Decisions to confirm

| Decision        | Recommendation                                                     | Why it is the starting point                                                                            |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Package names   | Scoped `@agentscope/*` packages                                    | Protects a coherent ecosystem and allows a future `agentscope` meta-package.                            |
| Global config   | XDG/OS config directory, not `.agent-scope` initially              | Correctly separates machine-level CLI credentials from project policy; support project overrides later. |
| Secrets         | Keychain/credential store, `.env` only for CI/local development    | Prevents accidental credential persistence in config and git.                                           |
| Plugin loading  | Explicit installed npm packages; no arbitrary remote code download | Keeps the trust boundary understandable.                                                                |
| Test substrate  | Docker Compose fixture matrix + mock OTLP/Langfuse collector       | Reproducible locally and in GitHub Actions; no separate VM is needed for v1.                            |
| Live validation | Nightly/manual, protected environment                              | Valuable drift detection without making PRs flaky or leaking secrets.                                   |

## Acceptance criteria for foundation phase

- Repository architecture, scope boundaries, and the decisions above are documented.
- Existing SF Platform AgentScope source is preserved in the standalone core package.
- Package, docs, test, CI, and publishing placeholders exist with a clear next implementation path.
