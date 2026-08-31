import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BoundedTerminalEmulator,
  defaultPtyTerminalEmulatorLimits,
} from "../bounded-terminal-emulator.js";
import {
  createPtySemanticContractSuite,
  PtySemanticContractError,
  ptySemanticTraceEnvelopeLimitBytes,
  type PtySemanticContractRun,
  type PtySemanticTrace,
  type PtyTransportAction,
  validatePtyModeApplicability,
} from "../pty-terminal-contract.js";

const encoder = new TextEncoder();
const suite = createPtySemanticContractSuite();
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const snapshotFor = (name: PtySemanticTrace["caseName"]) => {
  const limits =
    name === "pty:output-limit"
      ? { ...defaultPtyTerminalEmulatorLimits, maximumOutputBytes: 4 }
      : defaultPtyTerminalEmulatorLimits;
  const terminal = new BoundedTerminalEmulator(
    { columns: 80, rows: 24 },
    limits,
  );
  if (name === "pty:interactive-ready")
    terminal.write(encoder.encode("\u001b[?1049hAGENTSCOPE_PTY_READY"));
  else if (name === "pty:interactive-completed")
    terminal.write(encoder.encode("AGENTSCOPE_PTY_COMPLETE"));
  else if (name === "pty:credential-prompt")
    terminal.write(encoder.encode("Password: "));
  else if (name === "pty:malformed-control")
    terminal.write(encoder.encode("\u001b["));
  else if (name === "pty:output-limit") {
    terminal.write(encoder.encode("1234"));
    try {
      terminal.write(encoder.encode("5"));
    } catch {
      // The component trace retains only the categorical output-limit state.
    }
  } else terminal.write(encoder.encode("waiting"));
  return terminal.end();
};

const traceFor = (run: PtySemanticContractRun): PtySemanticTrace => {
  const { request } = run;
  const actionAt = request.monotonicStartupDeadlineMs - 100;
  const actions: PtyTransportAction[] = [
    {
      action: "resize",
      geometry: { columns: 100, rows: 30 },
      monotonicAtMs: actionAt,
    },
    {
      action: "input",
      byteLength: 7,
      inputSha256: digest("fixture"),
      monotonicAtMs: actionAt + 1,
    },
    { action: "eof", monotonicAtMs: actionAt + 2 },
  ];
  if (request.caseName === "pty:timeout-escalation")
    actions.push(
      {
        action: "signal",
        monotonicAtMs: request.monotonicExecutionDeadlineMs,
        signal: "SIGTERM",
        targetStartIdentity: "fixture-root",
      },
      {
        action: "signal",
        monotonicAtMs:
          request.monotonicExecutionDeadlineMs + request.terminationGraceMs,
        signal: "SIGKILL",
        targetStartIdentity: "fixture-root",
      },
    );
  const expected =
    request.caseName === "pty:interactive-ready"
      ? { diagnosticCode: null, outcome: "ready" as const }
      : request.caseName === "pty:interactive-completed"
        ? { diagnosticCode: null, outcome: "completed" as const }
        : request.caseName === "pty:credential-prompt"
          ? {
              diagnosticCode: "testkit.pty.credential-prompt" as const,
              outcome: "rejected" as const,
            }
          : request.caseName === "pty:malformed-control"
            ? {
                diagnosticCode: "testkit.pty.malformed-control" as const,
                outcome: "rejected" as const,
              }
            : request.caseName === "pty:output-limit"
              ? {
                  diagnosticCode: "testkit.pty.output-limit" as const,
                  outcome: "rejected" as const,
                }
              : {
                  diagnosticCode: "testkit.pty.timeout" as const,
                  outcome: "timed-out" as const,
                };
  return {
    traceVersion: 1,
    caseName: request.caseName,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    exactHarnessVersion: "component-fixture-v1",
    executionMode: "interactive",
    componentEvidenceOnly: true,
    containmentAuthority: "not-claimed",
    retainedRawTerminalBytes: false,
    initialGeometry: request.initialGeometry,
    finalSnapshot: snapshotFor(request.caseName),
    actions,
    lifecycle: {
      observationVersion: 1,
      cleanup: "clean",
      processJoined: true,
      residualProcessCount: 0,
      terminalInputJoined: true,
      terminalOutputJoined: true,
      terminalTransportClosed: true,
    },
    outcome: expected.outcome,
    diagnosticCode: expected.diagnosticCode,
    returnedAtMs:
      request.caseName === "pty:timeout-escalation"
        ? request.monotonicExecutionDeadlineMs + request.terminationGraceMs
        : request.monotonicExecutionDeadlineMs - 1,
  };
};

describe("semantic PTY contract", () => {
  it.each(suite)("verifies the fixed $name component oracle", (candidate) => {
    const run = candidate.instantiate();
    const envelope = run.encode(traceFor(run));
    expect(envelope.byteLength).toBeLessThanOrEqual(
      ptySemanticTraceEnvelopeLimitBytes,
    );
    const trace = run.verify(envelope);
    expect(trace.caseName).toBe(candidate.name);
    expect(trace.componentEvidenceOnly).toBe(true);
    expect(trace.containmentAuthority).toBe("not-claimed");
    expect(trace.retainedRawTerminalBytes).toBe(false);
    expect(JSON.stringify(trace)).not.toContain("Password");
    expect(JSON.stringify(trace)).not.toContain("AGENTSCOPE_PTY");
  });

  it("rejects a deliberate oracle that converts cleanup uncertainty into pass", () => {
    const run = suite[0]!.instantiate();
    const trace = traceFor(run);
    expect(() =>
      run.encode({
        ...trace,
        lifecycle: {
          ...trace.lifecycle,
          cleanup: "uncertain",
          processJoined: false,
        },
      }),
    ).toThrowError(new PtySemanticContractError("testkit.pty.trace.cleanup"));
  });

  it("rejects semantic, binding, raw-field, and action-order substitution", () => {
    const run = suite[0]!.instantiate();
    const trace = traceFor(run);
    expect(() =>
      run.encode({
        ...trace,
        finalSnapshot: { ...trace.finalSnapshot, semanticState: "completed" },
        outcome: "completed",
      }),
    ).toThrowError(new PtySemanticContractError("testkit.pty.trace.oracle"));
    expect(() =>
      run.encode({ ...trace, requestFingerprint: digest("substituted") }),
    ).toThrowError(new PtySemanticContractError("testkit.pty.trace"));
    expect(() =>
      run.encode({ ...trace, rawTerminal: "forbidden" }),
    ).toThrowError(new PtySemanticContractError("testkit.pty.trace"));
    expect(() =>
      run.encode({ ...trace, actions: [...trace.actions].reverse() }),
    ).toThrowError(
      new PtySemanticContractError("testkit.pty.trace.action-order"),
    );
  });

  it("requires exact TERM-to-KILL escalation inside the original deadline", () => {
    const run = suite
      .find((candidate) => candidate.name === "pty:timeout-escalation")!
      .instantiate();
    const trace = traceFor(run);
    expect(() =>
      run.encode({ ...trace, actions: trace.actions.slice(0, -1) }),
    ).toThrowError(
      new PtySemanticContractError("testkit.pty.trace.escalation"),
    );
    expect(() =>
      run.encode({
        ...trace,
        returnedAtMs: run.request.monotonicShutdownDeadlineMs + 1,
      }),
    ).toThrowError(new PtySemanticContractError("testkit.pty.trace"));
  });

  it("rejects malformed and oversized canonical envelopes", () => {
    const run = suite[0]!.instantiate();
    expect(() => run.verify("not-bytes")).toThrowError(
      new PtySemanticContractError("testkit.pty.trace.envelope"),
    );
    expect(() => run.verify(encoder.encode("{"))).toThrowError(
      new PtySemanticContractError("testkit.pty.trace.envelope"),
    );
    expect(() =>
      run.verify(new Uint8Array(ptySemanticTraceEnvelopeLimitBytes + 1)),
    ).toThrowError(
      new PtySemanticContractError("testkit.pty.trace.envelope-limit"),
    );
  });

  it("keeps undocumented interactive modes explicitly not applicable", () => {
    expect(
      validatePtyModeApplicability({
        status: "not-applicable",
        reason: "no-documented-interactive-mode",
      }),
    ).toEqual({
      status: "not-applicable",
      reason: "no-documented-interactive-mode",
    });
    expect(
      validatePtyModeApplicability({
        status: "available",
        documentedMode: "interactive",
        exactHarnessVersion: "1.2.3",
      }),
    ).toEqual({
      status: "available",
      documentedMode: "interactive",
      exactHarnessVersion: "1.2.3",
    });
    expect(() =>
      validatePtyModeApplicability({
        status: "not-applicable",
        reason: "untested",
      }),
    ).toThrowError(
      new PtySemanticContractError("testkit.pty.mode-applicability"),
    );
  });
});
