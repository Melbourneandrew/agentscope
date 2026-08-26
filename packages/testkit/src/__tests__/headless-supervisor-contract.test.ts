import { describe, expect, it } from "vitest";

import {
  createBoundedHeadlessSupervisorContractSuite,
  type HeadlessExecutionResult,
  type HeadlessExecutionTrace,
  type HeadlessProcessSetObservation,
  type HeadlessSupervisorContractRun,
} from "../headless-supervisor-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const root = Object.freeze({
  pid: 41_001,
  startIdentity: "root-start-identity",
  role: "root" as const,
});
const descendant = Object.freeze({
  pid: 41_002,
  startIdentity: "descendant-start-identity",
  role: "descendant" as const,
});

const cases = createBoundedHeadlessSupervisorContractSuite();

const contractRun = (name: string): HeadlessSupervisorContractRun => {
  const selected = cases.find((candidate) => candidate.name === name);
  if (selected === undefined) throw new Error("seed.contract.case");
  return selected.instantiate({
    root: "/synthetic/root",
    fixturePath: "/synthetic/root/fixture.mjs",
  });
};

const result = (
  overrides: Partial<HeadlessExecutionResult> = {},
): HeadlessExecutionResult => ({
  resultVersion: 1,
  outcome: "exited",
  exitCode: 0,
  signal: null,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  stdoutTruncated: false,
  stderrTruncated: false,
  termRequested: false,
  killRequested: false,
  cleanup: "clean",
  residualProcessCount: 0,
  diagnosticCode: null,
  ...overrides,
});

const correctResult = (
  request: HeadlessSupervisorContractRun["request"],
): HeadlessExecutionResult =>
  result({
    stdout: encoder.encode(
      JSON.stringify({
        arguments: request.arguments.slice(1),
        cwd: request.cwd,
        environment: request.environment,
        input: decoder.decode(request.stdin),
      }),
    ),
    stderr: encoder.encode("fixture-stderr"),
  });

const validTrace = (
  name: string,
  run: HeadlessSupervisorContractRun,
): HeadlessExecutionTrace => {
  const { request } = run;
  const readyAtMs = request.monotonicStartupDeadlineMs - 1_000;
  let processes: HeadlessProcessSetObservation["processes"] = [root];
  let signals: HeadlessProcessSetObservation["signals"] = [];
  let settledAtMs = readyAtMs;
  let executionResult: HeadlessExecutionResult;
  if (name === "headless:correct-invocation")
    executionResult = correctResult(request);
  else if (name === "headless:stdout-limit") {
    signals = [
      {
        signal: "SIGTERM",
        targetStartIdentity: root.startIdentity,
        monotonicAtMs: readyAtMs,
      },
    ];
    executionResult = result({
      outcome: "output-limit",
      exitCode: null,
      signal: "SIGTERM",
      stdout: new Uint8Array(request.stdoutLimitBytes).fill(79),
      stdoutTruncated: true,
      termRequested: true,
      diagnosticCode: "testkit.headless.output-limit",
    });
  } else if (name === "headless:stderr-limit") {
    signals = [
      {
        signal: "SIGTERM",
        targetStartIdentity: root.startIdentity,
        monotonicAtMs: readyAtMs,
      },
    ];
    executionResult = result({
      outcome: "output-limit",
      exitCode: null,
      signal: "SIGTERM",
      stderr: new Uint8Array(request.stderrLimitBytes).fill(69),
      stderrTruncated: true,
      termRequested: true,
      diagnosticCode: "testkit.headless.output-limit",
    });
  } else if (name === "headless:timeout-escalation") {
    const termAt = request.monotonicExecutionDeadlineMs;
    const killAt = termAt + request.terminationGraceMs;
    signals = [
      {
        signal: "SIGTERM",
        targetStartIdentity: root.startIdentity,
        monotonicAtMs: termAt,
      },
      {
        signal: "SIGKILL",
        targetStartIdentity: root.startIdentity,
        monotonicAtMs: killAt,
      },
    ];
    settledAtMs = killAt;
    executionResult = result({
      outcome: "timed-out",
      exitCode: null,
      signal: "SIGKILL",
      termRequested: true,
      killRequested: true,
      diagnosticCode: "testkit.headless.timeout",
    });
  } else {
    processes = [root, descendant];
    const killAt = readyAtMs + request.terminationGraceMs;
    signals = [
      {
        signal: "SIGTERM",
        targetStartIdentity: descendant.startIdentity,
        monotonicAtMs: readyAtMs,
      },
      {
        signal: "SIGKILL",
        targetStartIdentity: descendant.startIdentity,
        monotonicAtMs: killAt,
      },
    ];
    settledAtMs = killAt;
    executionResult = result({ termRequested: true, killRequested: true });
  }
  return {
    traceVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    returnedAtMs: settledAtMs,
    result: executionResult,
    observation: {
      observationVersion: 1,
      runId: request.runId,
      requestFingerprint: request.requestFingerprint,
      processes,
      signals,
      spawnedAtMs: readyAtMs,
      readyAtMs,
      settledAtMs,
      processJoined: true,
      stdinJoined: true,
      stdoutJoined: true,
      stderrJoined: true,
      cleanup: "clean",
      residualStartIdentities: [],
    },
  };
};

const mutateObservation = (
  trace: HeadlessExecutionTrace,
  mutation: Partial<HeadlessProcessSetObservation>,
): HeadlessExecutionTrace => ({
  ...trace,
  observation: { ...trace.observation, ...mutation },
});

describe("bounded headless supervisor trace protocol", () => {
  it("owns a frozen alpha-critical case inventory and fixture stimuli", () => {
    expect(Object.isFrozen(cases)).toBe(true);
    expect(cases.every((candidate) => Object.isFrozen(candidate))).toBe(true);
    expect(cases.map(({ name }) => name)).toEqual([
      "headless:correct-invocation",
      "headless:stdout-limit",
      "headless:stderr-limit",
      "headless:timeout-escalation",
      "headless:descendant-cleanup",
    ]);
    expect(cases.every(({ fixtureSource }) => fixtureSource.length > 20)).toBe(
      true,
    );
  });

  it("accepts the five closed synthetic protocol traces", () => {
    for (const candidate of cases) {
      const run = candidate.instantiate({
        root: "/synthetic/root",
        fixturePath: "/synthetic/root/fixture.mjs",
      });
      expect(run.verify(validTrace(candidate.name, run)).runId).toBe(
        run.request.runId,
      );
    }
  });

  it.each([
    ["arguments", "testkit.headless.invocation.arguments", { arguments: [] }],
    ["cwd", "testkit.headless.invocation.cwd", { cwd: "/wrong" }],
    [
      "environment",
      "testkit.headless.invocation.environment",
      { environment: { AMBIENT_SECRET: "PRIVATE_CANARY" } },
    ],
  ])("rejects synthetic output that loses exact %s", (_, code, mutation) => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    const invocation = {
      arguments: run.request.arguments.slice(1),
      cwd: run.request.cwd,
      environment: run.request.environment,
      input: decoder.decode(run.request.stdin),
      ...mutation,
    };
    expect(() =>
      run.verify({
        ...trace,
        result: {
          ...trace.result,
          stdout: encoder.encode(JSON.stringify(invocation)),
        },
      }),
    ).toThrow(code);
  });
});

describe("bounded trace binding and identity negatives", () => {
  it.each([
    [
      "wrong trace run",
      "testkit.headless.trace.binding",
      (value: HeadlessExecutionTrace) => ({ ...value, runId: "wrong-run" }),
    ],
    [
      "wrong observation request",
      "testkit.headless.observer.binding",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, { requestFingerprint: "0".repeat(64) }),
    ],
    [
      "PID reuse",
      "testkit.headless.observer.process",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          processes: [
            ...value.observation.processes,
            {
              pid: root.pid,
              startIdentity: "reused-start",
              role: "descendant",
            },
          ],
        }),
    ],
    [
      "omitted root",
      "testkit.headless.observer.process-set",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, { processes: [] }),
    ],
  ])("rejects %s", (_, code, mutation) => {
    const run = contractRun("headless:timeout-escalation");
    expect(() =>
      run.verify(mutation(validTrace("headless:timeout-escalation", run))),
    ).toThrow(code);
  });
});

describe("bounded trace signal negatives", () => {
  it.each([
    [
      "duplicate signal",
      "testkit.headless.observer.signal",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          signals: [...value.observation.signals, ...value.observation.signals],
        }),
    ],
    [
      "omitted signal",
      "testkit.headless.observer.signal-sequence",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          signals: value.observation.signals.slice(0, 1),
        }),
    ],
    [
      "misordered signals",
      "testkit.headless.observer.signal-order",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          signals: [...value.observation.signals].reverse(),
        }),
    ],
    [
      "signals after settlement",
      "testkit.headless.observer.signal-window",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          signals: value.observation.signals.map((event, index) => ({
            ...event,
            monotonicAtMs: value.observation.settledAtMs + 100 + index * 1_000,
          })),
        }),
    ],
    [
      "unobserved KILL self-report",
      "testkit.headless.observer.signal-correlation",
      (value: HeadlessExecutionTrace) => ({
        ...value,
        result: { ...value.result, killRequested: true },
      }),
    ],
  ])("rejects %s", (_, code, mutation) => {
    const name =
      code === "testkit.headless.observer.signal-correlation"
        ? "headless:stdout-limit"
        : "headless:timeout-escalation";
    const run = contractRun(name);
    expect(() => run.verify(mutation(validTrace(name, run)))).toThrow(code);
  });
});

describe("bounded trace timing and closure negatives", () => {
  it.each([
    [
      "startup after deadline",
      "testkit.headless.observer.startup",
      (value: HeadlessExecutionTrace, run: HeadlessSupervisorContractRun) =>
        mutateObservation(value, {
          readyAtMs: run.request.monotonicStartupDeadlineMs + 1,
          settledAtMs: run.request.monotonicStartupDeadlineMs + 1,
        }),
    ],
    [
      "TERM before execution deadline",
      "testkit.headless.timeout.early-term",
      (value: HeadlessExecutionTrace, run: HeadlessSupervisorContractRun) =>
        mutateObservation(value, {
          signals: value.observation.signals.map((event) =>
            event.signal === "SIGTERM"
              ? {
                  ...event,
                  monotonicAtMs: run.request.monotonicExecutionDeadlineMs - 1,
                }
              : event,
          ),
        }),
    ],
    [
      "KILL before grace",
      "testkit.headless.timeout.short-grace",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          signals: value.observation.signals.map((event) =>
            event.signal === "SIGKILL"
              ? {
                  ...event,
                  monotonicAtMs:
                    value.observation.signals[0]!.monotonicAtMs + 999,
                }
              : event,
          ),
        }),
    ],
    [
      "return after shutdown",
      "testkit.headless.observer.settlement",
      (value: HeadlessExecutionTrace, run: HeadlessSupervisorContractRun) => ({
        ...value,
        returnedAtMs: run.request.monotonicShutdownDeadlineMs + 100,
      }),
    ],
  ])("rejects %s", (_, code, mutation) => {
    const run = contractRun("headless:timeout-escalation");
    expect(() =>
      run.verify(mutation(validTrace("headless:timeout-escalation", run), run)),
    ).toThrow(code);
  });

  it("rejects missing handle closure and residual descendants", () => {
    const run = contractRun("headless:descendant-cleanup");
    const trace = validTrace("headless:descendant-cleanup", run);
    expect(() =>
      run.verify(mutateObservation(trace, { stdoutJoined: false })),
    ).toThrow("testkit.headless.observer.handles");
    expect(() =>
      run.verify(
        mutateObservation(trace, {
          cleanup: "residual",
          residualStartIdentities: [descendant.startIdentity],
        }),
      ),
    ).toThrow("testkit.headless.cleanup.complete");
  });
});

describe("bounded trace result negatives", () => {
  it("rejects output above the declared ceiling", () => {
    const run = contractRun("headless:stdout-limit");
    const trace = validTrace("headless:stdout-limit", run);
    expect(() =>
      run.verify({
        ...trace,
        result: {
          ...trace.result,
          stdout: new Uint8Array(run.request.stdoutLimitBytes + 1),
        },
      }),
    ).toThrow("testkit.headless.stdout.bound");
  });

  it("rejects unsanitized extra result fields", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    expect(() =>
      run.verify({
        ...trace,
        result: { ...trace.result, message: "PRIVATE_CANARY" },
      }),
    ).toThrow("testkit.headless.result.shape");
  });
});
