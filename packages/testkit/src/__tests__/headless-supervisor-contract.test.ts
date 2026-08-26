import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import {
  createBoundedHeadlessSupervisorContractSuite,
  type HeadlessExecutionResult,
  type HeadlessObserverPlan,
  type HeadlessProcessSetObservation,
  type HeadlessProcessSetObserverBackend,
  type HeadlessSupervisorContractAdapter,
} from "../headless-supervisor-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

const baselineObservation = (
  plan: HeadlessObserverPlan,
): HeadlessProcessSetObservation => {
  const spawnedAtMs = performance.now();
  const processes =
    plan.scenario === "descendant" ? [root, descendant] : [root];
  let signals: HeadlessProcessSetObservation["signals"] = [];
  let settledAtMs = spawnedAtMs;
  if (plan.scenario === "timeout") {
    const termAt = plan.monotonicExecutionDeadlineMs;
    const killAt = termAt + plan.terminationGraceMs;
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
  } else if (
    plan.scenario === "stdout-limit" ||
    plan.scenario === "stderr-limit"
  ) {
    signals = [
      {
        signal: "SIGTERM",
        targetStartIdentity: root.startIdentity,
        monotonicAtMs: spawnedAtMs,
      },
    ];
  } else if (plan.scenario === "descendant") {
    signals = [
      {
        signal: "SIGTERM",
        targetStartIdentity: descendant.startIdentity,
        monotonicAtMs: spawnedAtMs,
      },
      {
        signal: "SIGKILL",
        targetStartIdentity: descendant.startIdentity,
        monotonicAtMs: spawnedAtMs + plan.terminationGraceMs,
      },
    ];
    settledAtMs = spawnedAtMs + plan.terminationGraceMs;
  }
  return {
    observationVersion: 1,
    runId: plan.runId,
    requestFingerprint: plan.requestFingerprint,
    processes,
    signals,
    spawnedAtMs,
    readyAtMs: spawnedAtMs,
    settledAtMs,
    processJoined: true,
    stdinJoined: true,
    stdoutJoined: true,
    stderrJoined: true,
    cleanup: "clean",
    residualStartIdentities: [],
  };
};

type ObservationMutation = (
  observation: HeadlessProcessSetObservation,
  plan: HeadlessObserverPlan,
) => unknown;

const backend = (
  mutation: ObservationMutation = (observation) => observation,
  waitForSettlement = true,
): HeadlessProcessSetObserverBackend => ({
  open: (plan) => ({
    observeTerminal: async () => {
      const observation = baselineObservation(plan);
      const value = mutation(observation, plan);
      if (waitForSettlement && value === observation)
        await delay(
          Math.ceil(Math.max(0, observation.settledAtMs - performance.now())),
        );
      return value;
    },
  }),
});

const baselineAdapter: HeadlessSupervisorContractAdapter = {
  run: async (request) => {
    await request.processSetObserver.observeTerminal();
    const source = request.arguments[0] ?? "";
    const fixture = await import("node:fs/promises").then(({ readFile }) =>
      readFile(source, "utf8"),
    );
    if (request.arguments.length > 1) {
      return result({
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
    }
    if (fixture.includes('"O".repeat(4096)'))
      return result({
        outcome: "output-limit",
        exitCode: null,
        signal: "SIGTERM",
        stdout: new Uint8Array(request.stdoutLimitBytes).fill(79),
        stdoutTruncated: true,
        termRequested: true,
        diagnosticCode: "testkit.headless.output-limit",
      });
    if (fixture.includes('"E".repeat(4096)'))
      return result({
        outcome: "output-limit",
        exitCode: null,
        signal: "SIGTERM",
        stderr: new Uint8Array(request.stderrLimitBytes).fill(69),
        stderrTruncated: true,
        termRequested: true,
        diagnosticCode: "testkit.headless.output-limit",
      });
    if (fixture.includes("PRIVATE_TIMEOUT_CANARY"))
      return result({
        outcome: "timed-out",
        exitCode: null,
        signal: "SIGKILL",
        termRequested: true,
        killRequested: true,
        diagnosticCode: "testkit.headless.timeout",
      });
    return result({ termRequested: true, killRequested: true });
  },
};

const contractCase = (
  name: string,
  adapter: HeadlessSupervisorContractAdapter = baselineAdapter,
  observerBackend: HeadlessProcessSetObserverBackend = backend(),
) => {
  const selected = createBoundedHeadlessSupervisorContractSuite(
    adapter,
    observerBackend,
  ).find((candidate) => candidate.name === name);
  if (selected === undefined) throw new Error("seed.contract.case");
  return selected;
};

describe("bounded headless supervisor contract", () => {
  it("owns a frozen bounded alpha-critical case inventory", async () => {
    const cases = createBoundedHeadlessSupervisorContractSuite(
      baselineAdapter,
      backend(),
    );
    expect(Object.isFrozen(cases)).toBe(true);
    expect(cases.every((candidate) => Object.isFrozen(candidate))).toBe(true);
    expect(cases.map(({ name }) => name)).toEqual([
      "headless:correct-invocation",
      "headless:stdout-limit",
      "headless:stderr-limit",
      "headless:timeout-escalation",
      "headless:descendant-cleanup",
    ]);
    for (const candidate of cases) await candidate.run();
  }, 15_000);

  it.each([
    ["arguments", "testkit.headless.invocation.arguments", { arguments: [] }],
    ["cwd", "testkit.headless.invocation.cwd", { cwd: "/wrong" }],
    [
      "environment",
      "testkit.headless.invocation.environment",
      { environment: { AMBIENT_SECRET: "PRIVATE_CANARY" } },
    ],
  ])("rejects a supervisor that loses exact %s", async (_, code, mutation) => {
    const adapter: HeadlessSupervisorContractAdapter = {
      run: async (request) => {
        await request.processSetObserver.observeTerminal();
        const invocation = {
          arguments: request.arguments.slice(1),
          cwd: request.cwd,
          environment: request.environment,
          input: decoder.decode(request.stdin),
          ...mutation,
        };
        return result({
          stdout: encoder.encode(JSON.stringify(invocation)),
          stderr: encoder.encode("fixture-stderr"),
        });
      },
    };
    await expect(
      contractCase("headless:correct-invocation", adapter).run(),
    ).rejects.toThrow(code);
  });
});

describe("bounded headless supervisor adversarial seeds", () => {
  it("rejects fabricated success without execution or observer consumption", async () => {
    const noExecution: HeadlessSupervisorContractAdapter = {
      run: (request) =>
        Promise.resolve(
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
          }),
        ),
    };
    await expect(
      contractCase("headless:correct-invocation", noExecution).run(),
    ).rejects.toThrow("testkit.headless.observer.not-consumed");
  });

  it.each([
    [
      "wrong run",
      "testkit.headless.observer.binding",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        runId: "wrong-run",
      }),
    ],
    [
      "wrong request",
      "testkit.headless.observer.binding",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        requestFingerprint: "0".repeat(64),
      }),
    ],
    [
      "PID reuse",
      "testkit.headless.observer.process",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        processes: [
          ...value.processes,
          { pid: root.pid, startIdentity: "reused-start", role: "descendant" },
        ],
      }),
    ],
    [
      "omitted process",
      "testkit.headless.observer.process-set",
      (value: HeadlessProcessSetObservation) => ({ ...value, processes: [] }),
    ],
    [
      "duplicate event",
      "testkit.headless.observer.signal",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        signals: [...value.signals, ...value.signals],
      }),
    ],
    [
      "omitted event",
      "testkit.headless.observer.signal-sequence",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        signals: value.signals.slice(0, 1),
      }),
    ],
    [
      "misordered events",
      "testkit.headless.observer.signal-order",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        signals: [...value.signals].reverse(),
      }),
    ],
  ])("rejects %s observer evidence", async (_, code, mutation) => {
    await expect(
      contractCase(
        "headless:timeout-escalation",
        baselineAdapter,
        backend(mutation, false),
      ).run(),
    ).rejects.toThrow(code);
  });
});

describe("bounded headless supervisor cleanup and timing seeds", () => {
  it.each([
    [
      "missing handle settlement",
      "testkit.headless.observer.handles",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        settledAtMs: performance.now(),
        stdoutJoined: false,
      }),
    ],
    [
      "residual descendant despite clean self-report",
      "testkit.headless.cleanup.complete",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        settledAtMs: performance.now(),
        cleanup: "residual",
        residualStartIdentities: [descendant.startIdentity],
      }),
    ],
  ])("rejects %s", async (_, code, mutation) => {
    await expect(
      contractCase(
        "headless:descendant-cleanup",
        baselineAdapter,
        backend(mutation, false),
      ).run(),
    ).rejects.toThrow(code);
  });
});

describe("bounded headless supervisor settlement and result seeds", () => {
  it.each([
    [
      "TERM before execution deadline",
      "testkit.headless.timeout.early-term",
      (value: HeadlessProcessSetObservation, plan: HeadlessObserverPlan) => ({
        ...value,
        settledAtMs: performance.now(),
        signals: value.signals.map((event) =>
          event.signal === "SIGTERM"
            ? { ...event, monotonicAtMs: plan.monotonicExecutionDeadlineMs - 1 }
            : event,
        ),
      }),
    ],
    [
      "KILL before grace equality boundary",
      "testkit.headless.timeout.short-grace",
      (value: HeadlessProcessSetObservation) => ({
        ...value,
        settledAtMs: performance.now(),
        signals: value.signals.map((event) =>
          event.signal === "SIGKILL"
            ? { ...event, monotonicAtMs: value.signals[0]!.monotonicAtMs + 999 }
            : event,
        ),
      }),
    ],
    [
      "late 7100ms settlement",
      "testkit.headless.observer.settlement",
      (value: HeadlessProcessSetObservation, plan: HeadlessObserverPlan) => ({
        ...value,
        settledAtMs: plan.monotonicShutdownDeadlineMs + 100,
      }),
    ],
  ])("rejects %s", async (_, code, mutation) => {
    await expect(
      contractCase(
        "headless:timeout-escalation",
        baselineAdapter,
        backend(mutation, false),
      ).run(),
    ).rejects.toThrow(code);
  });

  it("rejects startup after the startup deadline", async () => {
    await expect(
      contractCase(
        "headless:correct-invocation",
        baselineAdapter,
        backend(
          (value, plan) => ({
            ...value,
            readyAtMs: plan.monotonicStartupDeadlineMs + 1,
            settledAtMs: plan.monotonicStartupDeadlineMs + 1,
          }),
          false,
        ),
      ).run(),
    ).rejects.toThrow("testkit.headless.observer.startup");
  });
});

describe("bounded headless supervisor callback and result seeds", () => {
  it("rejects observer rejection without leaking its content", async () => {
    const rejecting: HeadlessProcessSetObserverBackend = {
      open: () => ({
        observeTerminal: () => Promise.reject(new Error("PRIVATE_CANARY")),
      }),
    };
    await expect(
      contractCase(
        "headless:correct-invocation",
        baselineAdapter,
        rejecting,
      ).run(),
    ).rejects.toThrow("testkit.headless.adapter.deadline.failure");
  });

  it("bounds an adapter waiting on an observer that never settles", async () => {
    const neverSettles: HeadlessProcessSetObserverBackend = {
      open: () => ({ observeTerminal: () => new Promise(() => undefined) }),
    };
    await expect(
      contractCase(
        "headless:correct-invocation",
        baselineAdapter,
        neverSettles,
      ).run(),
    ).rejects.toThrow("testkit.headless.adapter.deadline");
  }, 10_000);

  it("bounds the independently awaited terminal observation", async () => {
    const neverSettles: HeadlessProcessSetObserverBackend = {
      open: () => ({ observeTerminal: () => new Promise(() => undefined) }),
    };
    const returnsWhileObserverRuns: HeadlessSupervisorContractAdapter = {
      run: (request) => {
        void request.processSetObserver.observeTerminal();
        return Promise.resolve(
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
          }),
        );
      },
    };
    await expect(
      contractCase(
        "headless:correct-invocation",
        returnsWhileObserverRuns,
        neverSettles,
      ).run(),
    ).rejects.toThrow("testkit.headless.observer.deadline");
  }, 10_000);

  it("rejects output ceiling violations", async () => {
    const overflow: HeadlessSupervisorContractAdapter = {
      run: async (request) => {
        await request.processSetObserver.observeTerminal();
        return result({
          outcome: "output-limit",
          exitCode: null,
          signal: "SIGTERM",
          stdout: new Uint8Array(request.stdoutLimitBytes + 1),
          stdoutTruncated: true,
          termRequested: true,
          diagnosticCode: "testkit.headless.output-limit",
        });
      },
    };
    await expect(
      contractCase("headless:stdout-limit", overflow).run(),
    ).rejects.toThrow("testkit.headless.stdout.bound");
  });

  it("rejects unsanitized result fields with a content-free code", async () => {
    const unsanitized: HeadlessSupervisorContractAdapter = {
      run: async (request) => {
        await request.processSetObserver.observeTerminal();
        return {
          ...((await baselineAdapter.run(request)) as HeadlessExecutionResult),
          message: "PRIVATE_CANARY",
        };
      },
    };
    await expect(
      contractCase("headless:correct-invocation", unsanitized).run(),
    ).rejects.toThrow("testkit.headless.result.shape");
  });
});
