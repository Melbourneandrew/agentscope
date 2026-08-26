import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  createBoundedHeadlessSupervisorContractSuite,
  encodeCanonicalHeadlessExecutionTrace,
  headlessTraceEnvelopeLimitBytes,
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

const tracePayload = (trace: HeadlessExecutionTrace): object => ({
  traceVersion: trace.traceVersion,
  runId: trace.runId,
  requestFingerprint: trace.requestFingerprint,
  returnedAtMs: trace.returnedAtMs,
  result: {
    ...trace.result,
    stdout: [...trace.result.stdout],
    stderr: [...trace.result.stderr],
  },
  observation: trace.observation,
});

const encodeTrace = (
  run: HeadlessSupervisorContractRun,
  trace: HeadlessExecutionTrace,
): Uint8Array => run.encode(trace);

const verifyTrace = (
  run: HeadlessSupervisorContractRun,
  trace: HeadlessExecutionTrace,
): HeadlessExecutionTrace => run.verify(encodeTrace(run, trace));

const reachableIntrinsicTargets = (): readonly (readonly [
  object,
  PropertyKey,
])[] => {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  ) as object;
  const hashPrototype = Object.getPrototypeOf(createHash("sha256")) as object;
  const performancePrototype = Object.getPrototypeOf(performance) as object;
  return [
    [Object, "create"],
    [Object, "defineProperty"],
    [Object, "freeze"],
    [Object, "getPrototypeOf"],
    [Object, "getOwnPropertyDescriptor"],
    [Object, "getOwnPropertyDescriptors"],
    [Object, "hasOwn"],
    [Object, "keys"],
    [Object, "setPrototypeOf"],
    [Object.prototype, "toJSON"],
    [JSON, "parse"],
    [JSON, "stringify"],
    [Number, "isFinite"],
    [Number, "isSafeInteger"],
    [Reflect, "apply"],
    [Reflect, "ownKeys"],
    [Array, "isArray"],
    [Array.prototype, "every"],
    [Array.prototype, "find"],
    [Array.prototype, "includes"],
    [Array.prototype, Symbol.iterator],
    [Array.prototype, "keys"],
    [Array.prototype, "map"],
    [Array.prototype, "slice"],
    [Array.prototype, "some"],
    [Array.prototype, "sort"],
    [Array.prototype, "toJSON"],
    [TextDecoder.prototype, "decode"],
    [TextEncoder.prototype, "encode"],
    [Uint8Array, "from"],
    [typedArrayPrototype, "buffer"],
    [typedArrayPrototype, "byteLength"],
    [typedArrayPrototype, "byteOffset"],
    [typedArrayPrototype, "set"],
    [ArrayBuffer.prototype, "resizable"],
    [hashPrototype, "update"],
    [hashPrototype, "digest"],
    [performancePrototype, "now"],
  ];
};

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
      expect(verifyTrace(run, validTrace(candidate.name, run)).runId).toBe(
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
      verifyTrace(run, {
        ...trace,
        result: {
          ...trace.result,
          stdout: encoder.encode(JSON.stringify(invocation)),
        },
      }),
    ).toThrow(code);
  });
});

describe("bounded trace input safety", () => {
  it("exports one drift-free encoder that round-trips through the run", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    const exported = encodeCanonicalHeadlessExecutionTrace(
      trace,
      "correct",
      run.request,
    );
    expect(exported).toEqual(run.encode(trace));
    expect(run.verify(exported).runId).toBe(run.request.runId);
  });

  it("rejects hostile DTO records without invoking their traps or getters", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    let calls = 0;
    const proxied = new Proxy(trace, {
      ownKeys: (target) => {
        calls += 1;
        return Reflect.ownKeys(target);
      },
    });
    expect(() => run.encode(proxied)).toThrow("testkit.headless.trace.shape");
    expect(calls).toBe(0);

    const accessor = { ...trace };
    Object.defineProperty(accessor, "runId", {
      enumerable: true,
      get: () => {
        calls += 1;
        return trace.runId;
      },
    });
    expect(() => run.encode(accessor)).toThrow("testkit.headless.trace.shape");
    expect(calls).toBe(0);

    const customPrototype = { ...trace };
    Object.setPrototypeOf(customPrototype, {});
    expect(() => run.encode(customPrototype)).toThrow(
      "testkit.headless.trace.shape",
    );

    const missingRunId = { ...trace } as Record<string, unknown>;
    delete missingRunId.runId;
    expect(() => run.encode(missingRunId)).toThrow(
      "testkit.headless.trace.shape",
    );
  });

  it("projects 150,000 surplus DTO fields without reading them", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    const expected = run.encode(trace);
    const noisy = { ...trace } as Record<string, unknown>;
    for (let index = 0; index < 150_000; index += 1)
      noisy[`surplus-${index}`] = index;
    let getterCalls = 0;
    Object.defineProperty(noisy, "surplus-getter", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "PRIVATE_CANARY";
      },
    });

    expect(run.encode(noisy)).toEqual(expected);
    expect(getterCalls).toBe(0);
  });

  it("rejects hostile DTO output backing with fixed diagnostics", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    const ResizableArrayBuffer = ArrayBuffer as unknown as new (
      byteLength: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer;
    const customPrototype = new Uint8Array(8);
    Object.setPrototypeOf(customPrototype, {});
    const detached = new Uint8Array(8);
    (
      detached.buffer as ArrayBuffer & { transfer: () => ArrayBuffer }
    ).transfer();
    let traps = 0;
    const proxied = new Proxy(new Uint8Array(8), {
      getPrototypeOf: (target) => {
        traps += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
    for (const stdout of [
      new Uint8Array(new SharedArrayBuffer(8)),
      new Uint8Array(new ResizableArrayBuffer(8, { maxByteLength: 16 })),
      detached,
      customPrototype,
      proxied,
    ])
      expect(() =>
        run.encode({ ...trace, result: { ...trace.result, stdout } }),
      ).toThrow("testkit.headless.result.output");
    expect(traps).toBe(0);
  });
});

describe("bounded canonical envelope safety", () => {
  it("rejects a proxied envelope without invoking its traps", () => {
    const run = contractRun("headless:correct-invocation");
    const encoded = encodeTrace(
      run,
      validTrace("headless:correct-invocation", run),
    );
    let trapCalls = 0;
    const proxiedEnvelope = new Proxy(encoded, {
      getPrototypeOf: (target) => {
        trapCalls += 1;
        return Reflect.getPrototypeOf(target);
      },
    });

    expect(() => run.verify(proxiedEnvelope)).toThrow(
      "testkit.headless.envelope.shape",
    );
    expect(trapCalls).toBe(0);
  });

  it("rejects oversized and attacker-key envelopes before parsing", () => {
    const run = contractRun("headless:timeout-escalation");
    expect(() =>
      run.verify(new Uint8Array(headlessTraceEnvelopeLimitBytes + 1)),
    ).toThrow("testkit.headless.envelope.bound");

    const attackerKeys: Record<string, number> = {};
    for (let index = 0; index < 150_000; index += 1)
      attackerKeys[`extra-${index}`] = index;
    const attackerEnvelope = encoder.encode(JSON.stringify(attackerKeys));
    expect(attackerEnvelope.byteLength).toBeGreaterThan(
      headlessTraceEnvelopeLimitBytes,
    );
    expect(() => run.verify(attackerEnvelope)).toThrow(
      "testkit.headless.envelope.bound",
    );
  });

  it("rejects shared, resizable, detached, and custom envelope backing", () => {
    const run = contractRun("headless:correct-invocation");
    const ResizableArrayBuffer = ArrayBuffer as unknown as new (
      byteLength: number,
      options: { maxByteLength: number },
    ) => ArrayBuffer;
    const customPrototype = new Uint8Array(8);
    Object.setPrototypeOf(customPrototype, {});
    const detached = new Uint8Array(8);
    (
      detached.buffer as ArrayBuffer & { transfer: () => ArrayBuffer }
    ).transfer();
    for (const envelope of [
      new Uint8Array(new SharedArrayBuffer(8)),
      new Uint8Array(new ResizableArrayBuffer(8, { maxByteLength: 16 })),
      detached,
      customPrototype,
    ])
      expect(() => run.verify(envelope)).toThrow(
        "testkit.headless.envelope.shape",
      );
  });

  it("rejects duplicate, surplus, whitespace, and alternate-order JSON", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    const canonical = decoder.decode(encodeTrace(run, trace));
    const duplicate = canonical.replace(
      '"traceVersion":1',
      '"traceVersion":1,"traceVersion":1',
    );
    const alternateOrder = JSON.stringify({
      runId: trace.runId,
      ...tracePayload(trace),
    });
    const alternateNumber = canonical.replace(
      '"traceVersion":1',
      '"traceVersion":1e0',
    );
    const alternateEscape = canonical.replace(
      '"outcome":"exited"',
      '"outcome":"\\u0065xited"',
    );
    for (const source of [
      ` ${canonical}`,
      duplicate,
      alternateOrder,
      alternateNumber,
      alternateEscape,
    ])
      expect(() => run.verify(encoder.encode(source))).toThrow(
        "testkit.headless.envelope.canonical",
      );
    expect(() =>
      run.verify(
        encoder.encode(
          JSON.stringify({ ...tracePayload(trace), surplus: true }),
        ),
      ),
    ).toThrow("testkit.headless.trace.shape");
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
      "omitted root",
      "testkit.headless.observer.processes",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, { processes: [] }),
    ],
  ])("rejects %s", (_, code, mutation) => {
    const run = contractRun("headless:timeout-escalation");
    expect(() =>
      verifyTrace(
        run,
        mutation(validTrace("headless:timeout-escalation", run)),
      ),
    ).toThrow(code);
  });

  it("rejects PID reuse with a different start identity", () => {
    const run = contractRun("headless:descendant-cleanup");
    const trace = validTrace("headless:descendant-cleanup", run);
    expect(() =>
      verifyTrace(
        run,
        mutateObservation(trace, {
          processes: [
            root,
            { ...descendant, pid: root.pid, startIdentity: "reused-start" },
          ],
        }),
      ),
    ).toThrow("testkit.headless.observer.process");
  });
});

describe("bounded trace signal negatives", () => {
  it.each([
    [
      "duplicate signal",
      "testkit.headless.observer.signals",
      (value: HeadlessExecutionTrace) =>
        mutateObservation(value, {
          signals: [...value.observation.signals, ...value.observation.signals],
        }),
    ],
    [
      "omitted signal",
      "testkit.headless.observer.signals",
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
    expect(() => verifyTrace(run, mutation(validTrace(name, run)))).toThrow(
      code,
    );
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
      verifyTrace(
        run,
        mutation(validTrace("headless:timeout-escalation", run), run),
      ),
    ).toThrow(code);
  });

  it("rejects missing handle closure and residual descendants", () => {
    const run = contractRun("headless:descendant-cleanup");
    const trace = validTrace("headless:descendant-cleanup", run);
    expect(() =>
      verifyTrace(run, mutateObservation(trace, { stdoutJoined: false })),
    ).toThrow("testkit.headless.observer.handles");
    expect(() =>
      verifyTrace(
        run,
        mutateObservation(trace, {
          cleanup: "residual",
          residualStartIdentities: [descendant.startIdentity],
        }),
      ),
    ).toThrow("testkit.headless.observer.residual");
  });
});

describe("bounded trace diagnostic safety", () => {
  it("keeps diagnostics fixed when Error.prototype.name is poisoned", () => {
    const run = contractRun("headless:correct-invocation");
    const original = Object.getOwnPropertyDescriptor(Error.prototype, "name")!;
    const originalCode = Object.getOwnPropertyDescriptor(
      Error.prototype,
      "code",
    );
    let setterCalls = 0;
    let message: string | undefined;
    let code: string | undefined;
    try {
      Object.defineProperty(Error.prototype, "name", {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      Object.defineProperty(Error.prototype, "code", {
        configurable: true,
        set: () => {
          setterCalls += 1;
        },
      });
      try {
        run.verify(new Uint8Array());
      } catch (error) {
        const diagnostic = error as { code?: unknown; message?: unknown };
        if (typeof diagnostic.message === "string")
          message = diagnostic.message;
        if (typeof diagnostic.code === "string") code = diagnostic.code;
      }
    } finally {
      Object.defineProperty(Error.prototype, "name", original);
      if (originalCode === undefined)
        Reflect.deleteProperty(Error.prototype, "code");
      else Object.defineProperty(Error.prototype, "code", originalCode);
    }
    expect(setterCalls).toBe(0);
    expect(message).toBe("testkit.headless.envelope.encoding");
    expect(code).toBe("testkit.headless.envelope.encoding");
  });
});

describe("bounded trace result negatives", () => {
  it("rejects output above the declared ceiling", () => {
    const run = contractRun("headless:stdout-limit");
    const trace = validTrace("headless:stdout-limit", run);
    expect(() =>
      verifyTrace(run, {
        ...trace,
        result: {
          ...trace.result,
          stdout: new Uint8Array(run.request.stdoutLimitBytes + 1),
        },
      }),
    ).toThrow("testkit.headless.stdout.bound");
  });

  it("rejects a wrong invocation after reachable intrinsics are poisoned", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    const invocation = {
      arguments: ["wrong"],
      cwd: run.request.cwd,
      environment: { AMBIENT_SECRET: "PRIVATE_CANARY" },
      input: "oracle-stdin",
    };
    const encoded = encoder.encode(
      JSON.stringify(
        tracePayload({
          ...trace,
          result: {
            ...trace.result,
            stdout: encoder.encode(JSON.stringify(invocation)),
          },
        }),
      ),
    );
    const replacements = reachableIntrinsicTargets();
    const defineProperty = Object.defineProperty;
    const originals = replacements.map(([owner, key]) => [
      owner,
      key,
      Object.getOwnPropertyDescriptor(owner, key),
    ]) as readonly (readonly [
      object,
      PropertyKey,
      PropertyDescriptor | undefined,
    ])[];
    let diagnostic: string | undefined;
    let instantiated: boolean | undefined;
    try {
      for (let index = 0; index < replacements.length; index += 1) {
        const owner = replacements[index]![0];
        const key = replacements[index]![1];
        defineProperty(owner, key, {
          configurable: true,
          value: () => {
            throw new Error("mutated intrinsic invoked");
          },
          writable: true,
        });
      }
      const poisonedRun = cases[0]!.instantiate({
        root: "/synthetic/root",
        fixturePath: "/synthetic/root/fixture.mjs",
      });
      instantiated = poisonedRun.request.requestFingerprint.length === 64;
      try {
        run.verify(encoded);
      } catch (error) {
        diagnostic =
          error instanceof Error && typeof error.message === "string"
            ? error.message
            : "unknown";
      }
    } finally {
      for (let index = 0; index < originals.length; index += 1) {
        const owner = originals[index]![0];
        const key = originals[index]![1];
        const descriptor = originals[index]![2];
        if (descriptor === undefined) Reflect.deleteProperty(owner, key);
        else defineProperty(owner, key, descriptor);
      }
    }
    expect(instantiated).toBe(true);
    expect(diagnostic).toBe("testkit.headless.invocation.arguments");
  });

  it("projects surplus DTO fields but rejects surplus wire fields", () => {
    const run = contractRun("headless:correct-invocation");
    const trace = validTrace("headless:correct-invocation", run);
    expect(
      run.encode({
        ...trace,
        result: { ...trace.result, message: "PRIVATE_CANARY" },
      }),
    ).toEqual(run.encode(trace));
    const source = decoder
      .decode(encodeTrace(run, trace))
      .replace(
        '"diagnosticCode":null',
        '"diagnosticCode":null,"message":"PRIVATE_CANARY"',
      );
    expect(() => run.verify(encoder.encode(source))).toThrow(
      "testkit.headless.result.shape",
    );
  });
});
