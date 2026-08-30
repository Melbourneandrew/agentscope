import { performance } from "node:perf_hooks";
import { types } from "node:util";

import {
  encodeCanonicalHeadlessExecutionTrace,
  type HeadlessCanonicalTraceEnvelope,
  type HeadlessExecutionRequest,
  type HeadlessExecutionResult,
  type HeadlessExecutionTrace,
  type HeadlessObservedSignal,
  type HeadlessObserverScenario,
  type HeadlessProcessIdentity,
  type HeadlessProcessSetObservation,
} from "../headless-supervisor-contract.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
  type HeadlessSupervisorExecutionOptions,
} from "../headless-supervisor.js";

type BackendTerminalReceipt = Readonly<{
  cleanup: "clean" | "uncertain";
  monotonicShutdownDeadlineMs: number;
  requestFingerprint: string;
  runId: string;
  trace: HeadlessExecutionTrace;
}>;
type ArmedBackendAuthority = Readonly<{
  expiryReceipt: Promise<BackendTerminalReceipt>;
  launch: () => Promise<BackendTerminalReceipt>;
}>;
type SelectedIsolationBackendAuthority = Readonly<{
  arm: (
    request: HeadlessExecutionRequest,
    whenAborted: Promise<void>,
  ) => Promise<ArmedBackendAuthority>;
  kind: "selected-isolation-backend";
}>;
type ScriptedBackendAuthority = Readonly<{
  arm: (
    request: HeadlessExecutionRequest,
    whenAborted: Promise<void>,
  ) => Promise<ArmedBackendAuthority>;
  kind: "scripted-component-protocol";
}>;
type ExecutionBackendAuthority =
  SelectedIsolationBackendAuthority | ScriptedBackendAuthority;

const selectedBackendAuthorities = new WeakMap<
  object,
  SelectedIsolationBackendAuthority
>();
// Deliberately write-closed in c1k.2. c1k.5 owns the restricted composition
// with a real external parent/container isolation backend.
const internalErrorCodes = new WeakMap<object, string>();
const SafePromise = Promise;
const SafeArray = Array;
const SafeTextEncoder = TextEncoder;
const SafeUint8Array = Uint8Array;
const safeReflectApply = Reflect.apply;
const safeSetTimeout = setTimeout;
const safeClearTimeout = clearTimeout;
const isProxy = types.isProxy;
const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const jsonStringify = JSON.stringify;
const maximum = Math.max;
const minimum = Math.min;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const uint8ArrayPrototype = Uint8Array.prototype;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;
// eslint-disable-next-line @typescript-eslint/unbound-method
const performanceNow = performance.now;
// eslint-disable-next-line @typescript-eslint/unbound-method
const textEncoderEncode = TextEncoder.prototype.encode;
// eslint-disable-next-line @typescript-eslint/unbound-method
const uint8ArrayFill = Uint8Array.prototype.fill;
const typedArrayPrototype = getPrototypeOf(uint8ArrayPrototype) as object;
const arrayBufferPrototype = ArrayBuffer.prototype;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayBuffer = getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method
const typedArrayByteLength = getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method
const arrayBufferByteLength = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  "byteLength",
)!.get!;
// eslint-disable-next-line @typescript-eslint/unbound-method
const arrayBufferResizable = getOwnPropertyDescriptor(
  arrayBufferPrototype,
  "resizable",
)?.get;
const typedArraySet = getOwnPropertyDescriptor(typedArrayPrototype, "set")!
  .value as (source: ArrayLike<number>) => void;
// eslint-disable-next-line @typescript-eslint/unbound-method
const abortSignalAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const addEventListener = EventTarget.prototype.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method
const removeEventListener = EventTarget.prototype.removeEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method
const promiseThen = Promise.prototype.then;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapGet = WeakMap.prototype.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapSet = WeakMap.prototype.set;
const maximumStreamBytes = 1_048_576;
const maximumStdinBytes = 1_048_576;

type Terminal<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;
const readWeakMap = <K extends object, V>(map: WeakMap<K, V>, key: K) =>
  safeReflectApply(weakMapGet, map, [key]) as V | undefined;
const writeWeakMap = <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
): void => {
  safeReflectApply(weakMapSet, map, [key, value]);
};
const kernelError = (code: string): HeadlessSupervisorError => {
  const error = new HeadlessSupervisorError(code);
  writeWeakMap(internalErrorCodes, error, code);
  return error;
};
const fail = (code: string): never => {
  throw kernelError(code);
};
const trustedErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? readWeakMap(internalErrorCodes, error)
    : undefined;
const terminalOf = <T>(promise: Promise<T>): Promise<Terminal<T>> =>
  safeReflectApply(promiseThen, promise, [
    (value: T) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  ]) as Promise<Terminal<T>>;
const observeAtCreation = <T>(promise: Promise<T>): Promise<T> => {
  void terminalOf(promise);
  return promise;
};
const terminalSnapshot = <T>(
  promise: Promise<T>,
): (() => Terminal<T> | undefined) => {
  let terminal: Terminal<T> | undefined;
  const observed = terminalOf(promise);
  void safeReflectApply(promiseThen, observed, [
    (value: Terminal<T>) => {
      terminal = value;
    },
  ]);
  return () => terminal;
};
const isAborted = (signal: AbortSignal): boolean => {
  if (abortSignalAborted === undefined) return fail("testkit.headless.aborted");
  try {
    if (safeReflectApply(isProxy, types, [signal]))
      return fail("testkit.headless.aborted");
    return Boolean(safeReflectApply(abortSignalAborted, signal, []));
  } catch {
    return fail("testkit.headless.aborted");
  }
};
const cancellationAuthority = (
  signal: AbortSignal | undefined,
): Readonly<{
  abortedAtCreation: boolean;
  close: () => void;
  whenAborted: Promise<void>;
}> => {
  if (signal === undefined)
    return {
      abortedAtCreation: false,
      close: () => undefined,
      whenAborted: observeAtCreation(new SafePromise(() => undefined)),
    };
  let listener: (() => void) | undefined;
  try {
    const abortedAtCreation = isAborted(signal);
    const whenAborted = observeAtCreation(
      new SafePromise<void>((resolve) => {
        if (abortedAtCreation) {
          resolve();
          return;
        }
        listener = resolve;
        safeReflectApply(addEventListener, signal, [
          "abort",
          resolve,
          {
            once: true,
          },
        ]);
      }),
    );
    return {
      abortedAtCreation,
      close: () => {
        if (listener !== undefined)
          try {
            safeReflectApply(removeEventListener, signal, ["abort", listener]);
          } catch {
            // A forged signal never gains cancellation authority. Cleanup is
            // deliberately content-free and cannot replace the fixed failure.
          }
      },
      whenAborted,
    };
  } catch {
    return fail("testkit.headless.aborted");
  }
};
const remaining = (deadline: number): number =>
  maximum(0, deadline - safeReflectApply(performanceNow, performance, []));
const boundedInvoke = <T>(
  operation: () => Promise<T>,
  deadline: number,
  code: string,
): Promise<T> => {
  const initialWait = remaining(deadline);
  if (initialWait <= 0) return fail(code);
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error: unknown) {
    return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
  }
  const observed = terminalOf(operationPromise);
  const wait = remaining(deadline);
  if (wait <= 0) return fail(code);
  return observeAtCreation(
    new SafePromise<T>((resolve, reject) => {
      const timer = safeSetTimeout(() => {
        reject(kernelError(code));
      }, wait);
      void safeReflectApply(promiseThen, observed, [
        (settled: Terminal<T>) => {
          safeClearTimeout(timer);
          if (settled.ok) resolve(settled.value);
          else
            reject(
              kernelError(
                trustedErrorCode(settled.error) ??
                  "testkit.headless.kernel.failure",
              ),
            );
        },
      ]);
    }),
  );
};

const ownData = (value: object, key: string): unknown => {
  const descriptor = getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !("value" in descriptor)
  )
    return fail("testkit.headless.kernel.request");
  return descriptor.value;
};
const plainRecord = (value: unknown): value is object =>
  typeof value === "object" &&
  value !== null &&
  !isProxy(value) &&
  (getPrototypeOf(value) === objectPrototype || getPrototypeOf(value) === null);
const validScenario = (scenario: HeadlessObserverScenario): boolean =>
  scenario === "correct" ||
  scenario === "stdout-limit" ||
  scenario === "stderr-limit" ||
  scenario === "timeout" ||
  scenario === "descendant";
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && numberIsFinite(value);
const boundedInteger = (
  value: unknown,
  maximumValue: number,
): value is number =>
  typeof value === "number" &&
  numberIsSafeInteger(value) &&
  value >= 1 &&
  value <= maximumValue;
const snapshotArguments = (
  value: unknown,
  expectedLength: number,
): readonly string[] => {
  if (
    !arrayIsArray(value) ||
    isProxy(value) ||
    getPrototypeOf(value) !== arrayPrototype ||
    value.length !== expectedLength
  )
    return fail("testkit.headless.kernel.request");
  const result = new SafeArray<string>(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const argument = ownData(value, String(index));
    if (typeof argument !== "string")
      return fail("testkit.headless.kernel.request");
    result[index] = argument;
  }
  return safeReflectApply(freeze, Object, [result]) as readonly string[];
};
const snapshotEnvironment = (
  value: unknown,
): Readonly<Record<string, string>> => {
  if (!plainRecord(value)) return fail("testkit.headless.kernel.request");
  const visible = ownData(value, "AGENTSCOPE_ORACLE_VISIBLE");
  if (typeof visible !== "string")
    return fail("testkit.headless.kernel.request");
  return safeReflectApply(freeze, Object, [
    { AGENTSCOPE_ORACLE_VISIBLE: visible },
  ]);
};
const snapshotStdin = (value: unknown): Uint8Array => {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    getPrototypeOf(value) !== uint8ArrayPrototype
  )
    return fail("testkit.headless.kernel.request");
  let length: number;
  let buffer: ArrayBuffer;
  try {
    buffer = safeReflectApply(typedArrayBuffer, value, []) as ArrayBuffer;
    if (getPrototypeOf(buffer) !== arrayBufferPrototype)
      return fail("testkit.headless.kernel.request");
    safeReflectApply(arrayBufferByteLength, buffer, []);
    if (
      arrayBufferResizable !== undefined &&
      safeReflectApply(arrayBufferResizable, buffer, []) === true
    )
      return fail("testkit.headless.kernel.request");
    length = safeReflectApply(typedArrayByteLength, value, []) as number;
  } catch {
    return fail("testkit.headless.kernel.request");
  }
  if (length > maximumStdinBytes)
    return fail("testkit.headless.kernel.request");
  const result = new SafeUint8Array(length);
  try {
    safeReflectApply(typedArraySet, result, [value]);
    if (
      safeReflectApply(typedArrayByteLength, value, []) !== length ||
      safeReflectApply(typedArrayBuffer, value, []) !== buffer
    )
      return fail("testkit.headless.kernel.request");
  } catch {
    return fail("testkit.headless.kernel.request");
  }
  return result;
};
const snapshotRequest = (
  scenario: HeadlessObserverScenario,
  candidate: HeadlessExecutionRequest,
): HeadlessExecutionRequest => {
  if (!validScenario(scenario) || !plainRecord(candidate))
    return fail("testkit.headless.kernel.request");
  const runId = ownData(candidate, "runId");
  const requestFingerprint = ownData(candidate, "requestFingerprint");
  const executable = ownData(candidate, "executable");
  const argumentsCandidate = ownData(candidate, "arguments");
  const cwd = ownData(candidate, "cwd");
  const environmentCandidate = ownData(candidate, "environment");
  const stdinCandidate = ownData(candidate, "stdin");
  const stdoutLimitBytes = ownData(candidate, "stdoutLimitBytes");
  const stderrLimitBytes = ownData(candidate, "stderrLimitBytes");
  const monotonicStartupDeadlineMs = ownData(
    candidate,
    "monotonicStartupDeadlineMs",
  );
  const monotonicExecutionDeadlineMs = ownData(
    candidate,
    "monotonicExecutionDeadlineMs",
  );
  const monotonicShutdownDeadlineMs = ownData(
    candidate,
    "monotonicShutdownDeadlineMs",
  );
  const terminationGraceMs = ownData(candidate, "terminationGraceMs");
  if (
    typeof runId !== "string" ||
    typeof requestFingerprint !== "string" ||
    typeof executable !== "string" ||
    typeof cwd !== "string" ||
    !boundedInteger(stdoutLimitBytes, maximumStreamBytes) ||
    !boundedInteger(stderrLimitBytes, maximumStreamBytes) ||
    !finiteNumber(monotonicStartupDeadlineMs) ||
    !finiteNumber(monotonicExecutionDeadlineMs) ||
    !finiteNumber(monotonicShutdownDeadlineMs) ||
    !finiteNumber(terminationGraceMs) ||
    terminationGraceMs < 0 ||
    monotonicStartupDeadlineMs > monotonicExecutionDeadlineMs ||
    monotonicExecutionDeadlineMs + terminationGraceMs >=
      monotonicShutdownDeadlineMs
  )
    return fail("testkit.headless.kernel.request");
  const argumentsSnapshot = snapshotArguments(
    argumentsCandidate,
    scenario === "correct" ? 3 : 1,
  );
  const environment = snapshotEnvironment(environmentCandidate);
  const stdin = snapshotStdin(stdinCandidate);
  return safeReflectApply(freeze, Object, [
    {
      runId,
      requestFingerprint,
      executable,
      arguments: argumentsSnapshot,
      cwd,
      environment,
      stdin,
      stdoutLimitBytes,
      stderrLimitBytes,
      monotonicStartupDeadlineMs,
      monotonicExecutionDeadlineMs,
      monotonicShutdownDeadlineMs,
      terminationGraceMs,
    },
  ]) as HeadlessExecutionRequest;
};
const assertReceipt = (
  receipt: BackendTerminalReceipt,
  request: HeadlessExecutionRequest,
): void => {
  if (
    receipt.cleanup !== "clean" ||
    receipt.runId !== request.runId ||
    receipt.requestFingerprint !== request.requestFingerprint ||
    receipt.monotonicShutdownDeadlineMs !==
      request.monotonicShutdownDeadlineMs ||
    receipt.trace.runId !== request.runId ||
    receipt.trace.requestFingerprint !== request.requestFingerprint
  )
    fail("testkit.headless.backend.receipt");
};
const execute = async (
  backend: ExecutionBackendAuthority,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  abortSignal: AbortSignal | undefined,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  request = snapshotRequest(scenario, request);
  // The backend receives its own bounded copy. In particular, mutable stdin
  // storage cannot change the kernel's receipt and canonical-envelope view.
  const backendRequest = snapshotRequest(scenario, request);
  const cancellation = cancellationAuthority(abortSignal);
  try {
    if (cancellation.abortedAtCreation) return fail("testkit.headless.aborted");
    const armed = await boundedInvoke(
      () => backend.arm(backendRequest, cancellation.whenAborted),
      request.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    // The terminal receipt is observed from the instant the selected backend is
    // armed. After the absolute shutdown authority expires, the kernel only
    // reads this already-started observation; it never invokes a fresh backend
    // callback, creates a new grace window, or waits without a bound.
    const readExpiryReceipt = terminalSnapshot(armed.expiryReceipt);
    let receipt: BackendTerminalReceipt;
    try {
      receipt = await boundedInvoke(
        armed.launch,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
    } catch (error: unknown) {
      if (
        trustedErrorCode(error) === "testkit.headless.shutdown.deadline" ||
        remaining(request.monotonicShutdownDeadlineMs) <= 0
      ) {
        const expiry = readExpiryReceipt();
        if (expiry?.ok === true && expiry.value.cleanup === "clean")
          assertReceipt(expiry.value, request);
        return fail("testkit.headless.reconciliation.deadline");
      }
      return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
    }
    assertReceipt(receipt, request);
    if (abortSignal !== undefined && isAborted(abortSignal))
      return fail("testkit.headless.aborted");
    return encodeCanonicalHeadlessExecutionTrace(
      receipt.trace,
      scenario,
      request,
    );
  } finally {
    cancellation.close();
  }
};

const bytes = (length: number, value: number): Uint8Array => {
  const output = new SafeUint8Array(length);
  safeReflectApply(uint8ArrayFill, output, [value]);
  return output;
};
const baseResult = (stdout: Uint8Array, stderr: Uint8Array) => ({
  resultVersion: 1 as const,
  stdout,
  stderr,
  cleanup: "clean" as const,
  residualProcessCount: 0,
});
const scriptedResult = (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): HeadlessExecutionResult => {
  const empty = new SafeUint8Array();
  if (scenario === "correct") {
    const encoder = new SafeTextEncoder();
    const stdout = safeReflectApply(textEncoderEncode, encoder, [
      jsonStringify({
        arguments: ["argument one", "--literal=$VALUE"],
        cwd: request.cwd,
        environment: { AGENTSCOPE_ORACLE_VISIBLE: "visible-canary" },
        input: "oracle-stdin",
        unexpectedEnvironmentCount: 0,
      }),
    ]);
    return {
      ...baseResult(
        stdout,
        safeReflectApply(textEncoderEncode, encoder, ["fixture-stderr"]),
      ),
      outcome: "exited",
      exitCode: 0,
      signal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      termRequested: false,
      killRequested: false,
      diagnosticCode: null,
    };
  }
  if (scenario === "stdout-limit" || scenario === "stderr-limit")
    return {
      ...baseResult(
        scenario === "stdout-limit"
          ? bytes(request.stdoutLimitBytes, 120)
          : empty,
        scenario === "stderr-limit"
          ? bytes(request.stderrLimitBytes, 121)
          : empty,
      ),
      outcome: "output-limit",
      exitCode: null,
      signal: "SIGTERM",
      stdoutTruncated: scenario === "stdout-limit",
      stderrTruncated: scenario === "stderr-limit",
      termRequested: true,
      killRequested: false,
      diagnosticCode: "testkit.headless.output-limit",
    };
  if (scenario === "timeout")
    return {
      ...baseResult(empty, empty),
      outcome: "timed-out",
      exitCode: null,
      signal: "SIGKILL",
      stdoutTruncated: false,
      stderrTruncated: false,
      termRequested: true,
      killRequested: true,
      diagnosticCode: "testkit.headless.timeout",
    };
  return {
    ...baseResult(empty, empty),
    outcome: "exited",
    exitCode: 0,
    signal: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    termRequested: true,
    killRequested: true,
    diagnosticCode: null,
  };
};
const scriptedTrace = (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): HeadlessExecutionTrace => {
  const root: HeadlessProcessIdentity = {
    pid: 41001,
    role: "root",
    startIdentity: `${request.runId}:root`,
  };
  const descendant: HeadlessProcessIdentity = {
    pid: 41002,
    role: "descendant",
    startIdentity: `${request.runId}:descendant`,
  };
  const processes = scenario === "descendant" ? [root, descendant] : [root];
  const readyAtMs = minimum(
    request.monotonicStartupDeadlineMs,
    safeReflectApply(performanceNow, performance, []) + 1,
  );
  const termAtMs =
    scenario === "timeout"
      ? maximum(readyAtMs, request.monotonicExecutionDeadlineMs)
      : readyAtMs + 1;
  const killAtMs = termAtMs + request.terminationGraceMs;
  const target = scenario === "descendant" ? descendant : root;
  const signals: HeadlessObservedSignal[] =
    scenario === "correct"
      ? []
      : scenario === "stdout-limit" || scenario === "stderr-limit"
        ? [
            {
              monotonicAtMs: termAtMs,
              signal: "SIGTERM",
              targetStartIdentity: root.startIdentity,
            },
          ]
        : [
            {
              monotonicAtMs: termAtMs,
              signal: "SIGTERM",
              targetStartIdentity: target.startIdentity,
            },
            {
              monotonicAtMs: killAtMs,
              signal: "SIGKILL",
              targetStartIdentity: target.startIdentity,
            },
          ];
  const settledAtMs = maximum(
    readyAtMs,
    signals.length === 0 ? 0 : signals[signals.length - 1]!.monotonicAtMs,
  );
  const result = scriptedResult(scenario, request);
  const observation: HeadlessProcessSetObservation = {
    observationVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    processes,
    signals,
    spawnedAtMs: readyAtMs - 1,
    readyAtMs,
    settledAtMs,
    processJoined: true,
    stdinJoined: true,
    stdoutJoined: true,
    stderrJoined: true,
    cleanup: "clean",
    residualStartIdentities: [],
  };
  return {
    traceVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    returnedAtMs: settledAtMs,
    result,
    observation,
  };
};

type ScriptedSeed =
  "cancelled" | "clean" | "late" | "wrong-binding" | "uncertain";
let scriptedLaunches = 0;
let scriptedCancellationDeliveries = 0;
const scriptedBackend = (
  scenario: HeadlessObserverScenario,
  seed: ScriptedSeed,
): ScriptedBackendAuthority => ({
  kind: "scripted-component-protocol",
  arm: (request, whenAborted) => {
    let resolveExpiry!: (receipt: BackendTerminalReceipt) => void;
    const expiryReceipt = observeAtCreation(
      new SafePromise<BackendTerminalReceipt>((resolve) => {
        resolveExpiry = resolve;
      }),
    );
    const receipt = (): BackendTerminalReceipt => ({
      cleanup: seed === "uncertain" ? "uncertain" : "clean",
      monotonicShutdownDeadlineMs: request.monotonicShutdownDeadlineMs,
      requestFingerprint:
        seed === "wrong-binding" ? "wrong" : request.requestFingerprint,
      runId: request.runId,
      trace: scriptedTrace(scenario, request),
    });
    if (seed === "late") {
      const expiryDelay = maximum(
        0,
        request.monotonicShutdownDeadlineMs -
          safeReflectApply(performanceNow, performance, []) -
          25,
      );
      safeSetTimeout(() => {
        resolveExpiry({ ...receipt(), cleanup: "uncertain" });
      }, expiryDelay);
    }
    const armed: ArmedBackendAuthority = {
      expiryReceipt,
      launch: () => {
        scriptedLaunches += 1;
        if (seed === "cancelled")
          return observeAtCreation(
            safeReflectApply(promiseThen, whenAborted, [
              () => {
                scriptedCancellationDeliveries += 1;
                const terminal = receipt();
                resolveExpiry(terminal);
                return terminal;
              },
            ]),
          );
        if (seed === "late")
          return observeAtCreation(new SafePromise(() => undefined));
        const terminal = receipt();
        resolveExpiry(terminal);
        return observeAtCreation(
          new SafePromise((resolve) => {
            resolve(terminal);
          }),
        );
      },
    };
    return observeAtCreation(
      new SafePromise((resolve) => {
        resolve(armed);
      }),
    );
  },
});

export const readHeadlessSupervisorKernelErrorCode = (error: unknown) =>
  trustedErrorCode(error);
export const executeWithHeadlessSupervisorCapability = async (
  capability: HeadlessSupervisorCapability,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  options: HeadlessSupervisorExecutionOptions,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  const backend =
    typeof capability === "object" && capability !== null
      ? readWeakMap(selectedBackendAuthorities, capability)
      : undefined;
  if (backend === undefined) return fail("testkit.headless.capability");
  try {
    return await execute(backend, scenario, request, options.signal);
  } catch (error: unknown) {
    return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
  }
};
/** Package-private scripted protocol evidence; never containment evidence. */
export const executeScriptedHeadlessSupervisorForTest = async (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  seed: ScriptedSeed = "clean",
  signal?: AbortSignal,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  scriptedLaunches = 0;
  scriptedCancellationDeliveries = 0;
  try {
    return await execute(
      scriptedBackend(scenario, seed),
      scenario,
      request,
      signal,
    );
  } catch (error: unknown) {
    return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
  }
};
/** Package-private sequencing counter; never execution evidence. */
export const readScriptedHeadlessLaunchCountForTest = (): number =>
  scriptedLaunches;
/** Package-private cancellation-delivery counter; never execution evidence. */
export const readScriptedHeadlessCancellationDeliveriesForTest = (): number =>
  scriptedCancellationDeliveries;
