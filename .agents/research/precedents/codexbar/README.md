# CodexBar

Research date: 2026-08-25. See [sources.md](sources.md) for exact provenance.

## Why it matters

CodexBar is the strongest precedent in this set for subprocess and PTY engineering around real coding-agent CLIs. It is not a trace-capture, storage, redaction, OTLP, or remote-fleet precedent. Its useful contribution is the set of lifecycle invariants exposed by running brittle interactive tools from a long-lived desktop application.

## Product and integration boundary

**Observed:** CodexBar is a macOS-oriented usage/quota monitor with many provider integrations. For Codex and Claude Code, it locates existing executables, launches CLI probes, parses status/usage output, and combines that with provider-specific account or web sources.

**Observed:** Executable resolution checks explicit overrides, process environment, login-shell-derived paths, and standard install locations. It does not acquire, authenticate, pin, or containerize a harness binary.

**Observed:** Real CLI probes use whatever binary the host resolver selects and may depend on an already authenticated developer installation.

**Inference:** A Crabbox worker would find a real CLI only if trusted preparation installed it and exposed the path/environment. CodexBar itself supplies neither fleet provisioning nor artifact admission.

## Subprocess runner

**Observed:** The shared subprocess runner requires an executable path, explicit arguments/environment, timeout, optional input, optional cwd, and optional output ceiling. It concurrently captures stdout and stderr.

**Observed:** Timeout and cancellation terminate a process tree, use process-group identity when available, snapshot descendants, send TERM, wait a grace interval, escalate to KILL, and wait again. A timeout-kill flag resolves an observation race between late task scheduling and process exit.

**Observed:** Output capture is bounded. Structured callers can fail closed on overflow; legacy callers may retain only a bounded prefix. The runner drains output after process exit before decoding and classifying a result.

**Observed:** Recent process-group code clears inherited signal masks, closes unrelated descriptors, binds process identity, tracks descendants that escape the original group, and handles output pipe holders so an inherited writer cannot hang result collection forever.

**Recommendation:** Transfer these invariants, not the Swift implementation: explicit launch contract, bounded concurrent drains, monotonic phase deadlines, signal-mask hygiene, process-set identity, TERM/grace/KILL, descendant and pipe-holder cleanup, exit-vs-timeout arbitration, and terminal joining.

## PTY runner

**Observed:** The PTY runner owns terminal creation, process-group launch, read/write handles, output accumulation, readiness parsing, command input, timeout, and cleanup. Tests use fake shell executables that emit controlled interactive output and react to commands.

**Observed:** PTY tests cover delayed output, subscription/error states, relaunch when account or launch environment changes, hard stop, descriptor reservation failure, signal masks, escaped descendants, and output-holder cleanup.

**Observed:** Readiness and usage parsing remain provider-specific. Several fixtures are shell scripts that mimic native CLIs rather than real authenticated executions.

**Inference:** The generic lifecycle belongs below the provider-specific terminal parser. This matches Agentscope's decision to place one execution kernel under pipe and PTY transports while leaving native observations to harness adapters.

## Fake executables and live probes

**Observed:** Deterministic tests create temporary executable scripts and inject their paths. These fakes model partial output, delays, changing accounts, errors, hangs, and descendants.

**Observed:** Opt-in live tests/probes exist for host CLIs and are useful for developer diagnosis, but missing binaries, missing authentication, parse failures, or timeouts can be treated as unavailable rather than release-failing product evidence.

**Recommendation:** Use fake executables for component and supervisor oracles only. Agentscope support admission must still invoke exact authenticated/pinned real binaries inside the hermetic scenario and observe independent model, hook, and destination ledgers.

## Platform and authority limits

**Observed:** The implementation is primarily Swift with Darwin-specific process and PTY machinery plus selected Linux code paths. It uses host process enumeration and OS-specific pipe identity techniques.

**Inference:** Concepts such as descendant identity and output-holder detection transfer to TypeScript/Linux, but Darwin `proc_*` APIs, Swift concurrency structures, and menu-bar lifecycle do not.

**Observed:** CodexBar carries MIT licensing, but that permits reuse of its code—not automatic compatibility with the separate vendor CLIs it launches.

## What Agentscope should borrow

- One generic bounded execution lifecycle beneath non-interactive and PTY transports.
- Exact argv/environment/cwd/input contracts.
- Concurrent bounded stdout/stderr drains and post-exit drain/join.
- TERM/grace/KILL escalation plus descendant and process-group evidence.
- Tests for inherited signal masks, descriptor inheritance, escaped descendants, output-holder leaks, timeout/exit races, partial output, and overflow.
- Temporary fake executables as hostile component fixtures.
- Opt-in live probes as advisory diagnosis, clearly separated from release authority.

## What Agentscope should avoid

- Treating a discovered host `PATH` binary as an admitted harness artifact.
- Treating developer authentication as a CI fixture.
- Treating fake or opt-in live probes as real-harness acceptance.
- Copying Darwin-specific process enumeration into a Linux contract.
- Inferring remote fleet, OCI preparation, redaction, or OTLP precedent from a local usage monitor.

## Relationship to Agentscope decisions

- Harness Execution Verification already adopts the transferable process/PTY invariants and keeps oracles outside scenario adapters.
- Agentscope additionally requires exact packed CLI installation, authenticated harness artifact identity, mock-only network traffic, denied public egress, sanitized retained evidence, and trusted outer cleanup.
- Local, GitHub, and Crabbox runs share one scenario/evidence contract; CodexBar does not provide that fleet or artifact authority.
