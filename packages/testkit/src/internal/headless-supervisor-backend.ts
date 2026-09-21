import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";

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
  type HostileHeadlessProcessSeed,
} from "../headless-supervisor-contract.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
  type HeadlessSupervisorExecutionOptions,
} from "../headless-supervisor.js";
import {
  BoundedTerminalEmulator,
  defaultPtyTerminalEmulatorLimits,
  type PtyTerminalGeometry,
  validatePtyTerminalSemanticSnapshot,
} from "../bounded-terminal-emulator.js";
import type {
  PtyTransportAction,
  SelectedPtyExecutionAction,
  SelectedPtyExecutionReceipt,
  SelectedPtyExecutionRequest,
} from "../pty-terminal-contract.js";

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
type ArmedPtyBackendAuthority = Readonly<{
  expiryReceipt: Promise<SelectedPtyExecutionReceipt>;
  launch: () => Promise<SelectedPtyExecutionReceipt>;
}>;
type SelectedIsolationBackendAuthority = Readonly<{
  arm: (
    request: HeadlessExecutionRequest,
    whenAborted: Promise<void>,
  ) => Promise<ArmedBackendAuthority>;
  armPty?: (
    request: SelectedPtyExecutionRequest,
    whenAborted: Promise<void>,
  ) => Promise<ArmedPtyBackendAuthority>;
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
// The emulator is public API, but its mutable prototype is not execution
// authority. Capture the exact implementation selected with this kernel so a
// caller cannot synthesize marker or semantic observations after import.
/* eslint-disable @typescript-eslint/unbound-method -- these unbound methods are intentionally invoked through captured Reflect.apply */
const emulatorWrite = BoundedTerminalEmulator.prototype.write;
const emulatorResize = BoundedTerminalEmulator.prototype.resize;
const emulatorEnd = BoundedTerminalEmulator.prototype.end;
const emulatorSnapshot = BoundedTerminalEmulator.prototype.snapshot;
const emulatorMalformedControlReason =
  BoundedTerminalEmulator.prototype.malformedControlReason;
const emulatorUnsupportedControlReason =
  BoundedTerminalEmulator.prototype.unsupportedControlReason;
const emulatorReadinessObserved =
  BoundedTerminalEmulator.prototype.readinessObserved;
const emulatorReadinessObservationGeneration =
  BoundedTerminalEmulator.prototype.readinessObservationGeneration;
const emulatorRequiredTerminalProtocolReady =
  BoundedTerminalEmulator.prototype.requiredTerminalProtocolReady;
const emulatorCompletionObserved =
  BoundedTerminalEmulator.prototype.completionObserved;
const emulatorTakeTerminalResponses =
  BoundedTerminalEmulator.prototype.takeTerminalResponses;
/* eslint-enable @typescript-eslint/unbound-method */
const safeSetTimeout = setTimeout;
const safeClearTimeout = clearTimeout;
const safeSetInterval = setInterval;
const safeClearInterval = clearInterval;
const isProxy = types.isProxy;
const arrayIsArray = Array.isArray;
const numberIsFinite = Number.isFinite;
const numberIsSafeInteger = Number.isSafeInteger;
const jsonStringify = JSON.stringify;
const objectKeys = Object.keys;
const maximum = Math.max;
const minimum = Math.min;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const arrayPush = Array.prototype.push;
const arraySome = Array.prototype.some;
const reflectDefineProperty = Reflect.defineProperty;
const reflectOwnKeys = Reflect.ownKeys;
const uint8ArrayPrototype = Uint8Array.prototype;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;
// eslint-disable-next-line @typescript-eslint/unbound-method
const performanceNow = performance.now;
// eslint-disable-next-line @typescript-eslint/unbound-method
const processHrtimeBigint = process.hrtime.bigint;
// eslint-disable-next-line @typescript-eslint/unbound-method
const processDlopen = process.dlopen;
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
// eslint-disable-next-line @typescript-eslint/unbound-method
const safeBufferByteLength = Buffer.byteLength;
// eslint-disable-next-line @typescript-eslint/unbound-method
const safeBufferConcat = Buffer.concat;
// eslint-disable-next-line @typescript-eslint/unbound-method
const safeBufferFrom = Buffer.from;
const maximumStreamBytes = 1_048_576;
const maximumStdinBytes = 1_048_576;
const maximumArguments = 256;
const maximumEnvironmentEntries = 128;
const maximumStringBytes = 16_384;
const containerPollMilliseconds = 10;
let selectedContainerCompositionConsumed = false;

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
const defineArrayIndex = <T>(values: T[], index: number, value: T): void => {
  if (
    !safeReflectApply(reflectDefineProperty, Reflect, [
      values,
      String(index),
      {
        configurable: false,
        enumerable: true,
        value,
        writable: false,
      },
    ])
  )
    return fail("testkit.pty.request");
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
    const value = safeReflectApply(abortSignalAborted, signal, []) as unknown;
    if (value === true) return true;
    if (value === false) return false;
    return fail("testkit.headless.aborted");
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
const boundedNonnegativeInteger = (
  value: unknown,
  maximumValue: number,
): value is number =>
  typeof value === "number" &&
  numberIsSafeInteger(value) &&
  value >= 0 &&
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
    defineArrayIndex(result, index, argument);
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
const snapshotSelectedRequest = (
  candidate: HeadlessExecutionRequest,
  // The closed production request has several independent hostile fields.
  // eslint-disable-next-line complexity
): HeadlessExecutionRequest => {
  if (!plainRecord(candidate)) return fail("testkit.headless.kernel.request");
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
    !/^[a-f0-9]{16}$/u.test(runId) ||
    typeof requestFingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(requestFingerprint) ||
    typeof executable !== "string" ||
    !executable.startsWith("/") ||
    safeBufferByteLength(executable, "utf8") > maximumStringBytes ||
    typeof cwd !== "string" ||
    !cwd.startsWith("/") ||
    safeBufferByteLength(cwd, "utf8") > maximumStringBytes ||
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
  if (
    !arrayIsArray(argumentsCandidate) ||
    isProxy(argumentsCandidate) ||
    getPrototypeOf(argumentsCandidate) !== arrayPrototype ||
    argumentsCandidate.length > maximumArguments
  )
    return fail("testkit.headless.kernel.request");
  const argumentsSnapshot = new SafeArray<string>(argumentsCandidate.length);
  for (let index = 0; index < argumentsCandidate.length; index += 1) {
    const value = ownData(argumentsCandidate, String(index));
    if (
      typeof value !== "string" ||
      safeBufferByteLength(value, "utf8") > maximumStringBytes
    )
      return fail("testkit.headless.kernel.request");
    defineArrayIndex(argumentsSnapshot, index, value);
  }
  if (!plainRecord(environmentCandidate))
    return fail("testkit.headless.kernel.request");
  const environmentKeys = safeReflectApply(objectKeys, Object, [
    environmentCandidate,
  ]);
  if (environmentKeys.length > maximumEnvironmentEntries)
    return fail("testkit.headless.kernel.request");
  environmentKeys.sort();
  const environment: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const key of environmentKeys) {
    const value = ownData(environmentCandidate, key);
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key) ||
      typeof value !== "string" ||
      safeBufferByteLength(value, "utf8") > maximumStringBytes
    )
      return fail("testkit.headless.kernel.request");
    environment[key] = value;
  }
  return safeReflectApply(freeze, Object, [
    {
      runId,
      requestFingerprint,
      executable,
      arguments: safeReflectApply(freeze, Object, [argumentsSnapshot]),
      cwd,
      environment: safeReflectApply(freeze, Object, [environment]),
      stdin: snapshotStdin(stdinCandidate),
      stdoutLimitBytes,
      stderrLimitBytes,
      monotonicStartupDeadlineMs,
      monotonicExecutionDeadlineMs,
      monotonicShutdownDeadlineMs,
      terminationGraceMs,
    },
  ]) as HeadlessExecutionRequest;
};
const readOptionsSignal = (
  options: HeadlessSupervisorExecutionOptions,
): AbortSignal | undefined => {
  if (!plainRecord(options)) return fail("testkit.headless.kernel.options");
  const descriptor = getOwnPropertyDescriptor(options, "signal");
  if (descriptor === undefined) return undefined;
  if (
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    !("value" in descriptor)
  )
    return fail("testkit.headless.kernel.options");
  return descriptor.value as AbortSignal | undefined;
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
    receipt.trace.requestFingerprint !== request.requestFingerprint ||
    receipt.trace.result.cleanup !== "clean"
  )
    fail("testkit.headless.backend.receipt");
};
const assertReceiptBinding = (
  receipt: BackendTerminalReceipt,
  request: HeadlessExecutionRequest,
): void => {
  if (
    receipt.runId !== request.runId ||
    receipt.requestFingerprint !== request.requestFingerprint ||
    receipt.monotonicShutdownDeadlineMs !==
      request.monotonicShutdownDeadlineMs ||
    receipt.trace.runId !== request.runId ||
    receipt.trace.requestFingerprint !== request.requestFingerprint ||
    (receipt.trace.result.cleanup === "clean"
      ? receipt.cleanup !== "clean"
      : receipt.cleanup !== "uncertain")
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

type CapturedOutput = Readonly<{ bytes: Uint8Array; truncated: boolean }>;
type MutableOutput = { chunks: Buffer[]; length: number; truncated: boolean };
type ProcessSnapshot = Readonly<{
  parentPid: number;
  pid: number;
  startIdentity: string;
  state: string;
}>;
type AdoptedZombieReapReceipt = Readonly<{
  pid: number;
  startIdentity: string;
  status: "already-absent" | "not-ready" | "reaped";
}>;
type ContainerComposition = Readonly<{
  immutableCandidate?: ImmutableCandidateAuthority;
  maximumShutdownDeadlineMs: number;
  namespaceIdentity: string;
}>;
type ImmutableCandidateRecord = Readonly<{
  authorityVersion: 1;
  candidateBundleIdentity: string;
  candidateInventorySha256: string;
  candidateRoot: "/opt/agentscope/prepared";
  imageConfigSha256: string;
  imageId: string;
  runId: string;
  scenarioId: string;
}>;
type ImmutableCandidateAuthority = Readonly<{
  assertFile: (descriptor: number, path: string) => void;
  assertRuntime: () => void;
}>;
const immutableCandidateAuthorities = new WeakSet<object>();
let immutableCandidateAuthorityCreated = false;
type SelectedContainerRuntime = Readonly<{
  assertNamespaceIdentity: (expected: string) => void;
  listProcesses: (namespaceIdentity: string) => readonly ProcessSnapshot[];
  readProcess: (pid: number) => ProcessSnapshot | undefined;
  reapAdoptedZombie: (
    pid: number,
    startIdentity: string,
    rootPid: number,
    monotonicDeadlineNs: bigint,
  ) => AdoptedZombieReapReceipt;
  sendSignal: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL") => void;
  spawnProcess: (request: HeadlessExecutionRequest) => ChildProcess;
}>;
type ProcessAuthorityRuntime = Pick<
  SelectedContainerRuntime,
  | "assertNamespaceIdentity"
  | "listProcesses"
  | "readProcess"
  | "reapAdoptedZombie"
  | "sendSignal"
>;

const readProcessSnapshot = (pid: number): ProcessSnapshot | undefined => {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 1) return fail("testkit.headless.observer.read");
    const fields = value
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const encodedParent = fields[1];
    const start = fields[19];
    if (
      state === undefined ||
      !/^[DIKPRSTWXYZtx]$/u.test(state) ||
      encodedParent === undefined ||
      !/^\d+$/u.test(encodedParent) ||
      start === undefined ||
      !/^\d+$/u.test(start)
    )
      return fail("testkit.headless.observer.read");
    const parentPid = Number(encodedParent);
    if (!numberIsSafeInteger(parentPid) || parentPid < 0)
      return fail("testkit.headless.observer.read");
    return { parentPid, pid, startIdentity: `${pid}:${start}`, state };
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    )
      return undefined;
    return fail("testkit.headless.observer.read");
  }
};

const assertNamespaceIdentity = (expected: string): void => {
  try {
    if (
      readlinkSync("/proc/self/ns/pid") !== expected ||
      readlinkSync("/proc/1/ns/pid") !== expected
    )
      return fail("testkit.headless.observer.identity");
  } catch (error: unknown) {
    if (trustedErrorCode(error) !== undefined) throw error;
    return fail("testkit.headless.observer.read");
  }
};

const boundedProcFile = (path: string, maximumBytes = 256 * 1024): string => {
  const value = readFileSync(path, "utf8");
  if (value.length < 1 || value.length > maximumBytes)
    return fail("testkit.pty.immutable-candidate");
  return value;
};

const exactImmutableCandidateRecord = (
  value: unknown,
): ImmutableCandidateRecord => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "authorityVersion\0candidateBundleIdentity\0candidateInventorySha256\0candidateRoot\0imageConfigSha256\0imageId\0runId\0scenarioId" ||
    ownData(value, "authorityVersion") !== 1 ||
    !/^sha256-[a-f0-9]{64}$/u.test(
      ownData(value, "candidateBundleIdentity") as string,
    ) ||
    !/^[a-f0-9]{64}$/u.test(
      ownData(value, "candidateInventorySha256") as string,
    ) ||
    ownData(value, "candidateRoot") !== "/opt/agentscope/prepared" ||
    !/^[a-f0-9]{64}$/u.test(ownData(value, "imageConfigSha256") as string) ||
    !/^sha256:[a-f0-9]{64}$/u.test(ownData(value, "imageId") as string) ||
    !/^[a-f0-9]{16}$/u.test(ownData(value, "runId") as string) ||
    typeof ownData(value, "scenarioId") !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(
      ownData(value, "scenarioId") as string,
    )
  )
    return fail("testkit.pty.immutable-candidate");
  return safeReflectApply(freeze, Object, [
    { ...value },
  ]) as ImmutableCandidateRecord;
};

const validatePrincipalFacts = (facts: {
  uid: number | undefined;
  euid: number | undefined;
  gid: number | undefined;
  egid: number | undefined;
  groups: readonly number[] | undefined;
  status: string;
}): void => {
  if (
    facts.uid !== 1000 ||
    facts.euid !== 1000 ||
    facts.gid !== 1000 ||
    facts.egid !== 1000 ||
    facts.groups === undefined ||
    facts.groups.length < 1 ||
    safeReflectApply(arraySome, facts.groups, [(group) => group !== 1000])
  )
    return fail("testkit.pty.immutable-candidate");
  const field = (name: string): string => {
    const values = facts.status
      .split("\n")
      .filter((line) => line.startsWith(`${name}:`));
    if (values.length !== 1) return fail("testkit.pty.immutable-candidate");
    return values[0]!.slice(name.length + 1).trim();
  };
  if (
    field("Uid") !== "1000\t1000\t1000\t1000" ||
    field("Gid") !== "1000\t1000\t1000\t1000" ||
    field("CapEff") !== "0000000000000000" ||
    field("CapPrm") !== "0000000000000000" ||
    field("CapInh") !== "0000000000000000" ||
    field("CapAmb") !== "0000000000000000" ||
    field("CapBnd") !== "0000000000000000" ||
    field("NoNewPrivs") !== "1"
  )
    return fail("testkit.pty.immutable-candidate");
};

const parseImmutableMountTable = (
  mountinfo: string,
): ReadonlyMap<number, ReadonlySet<string>> => {
  const mountTable = new Map<number, ReadonlySet<string>>();
  const lines = mountinfo.trimEnd().split("\n");
  if (
    lines.length < 1 ||
    safeReflectApply(arraySome, lines, [(line: string) => line.length < 1])
  )
    return fail("testkit.pty.immutable-candidate");
  for (const line of lines) {
    const fields = line.split(" ");
    const mountId = Number(fields[0]);
    const separator = fields.indexOf("-");
    if (
      !numberIsSafeInteger(mountId) ||
      mountId < 1 ||
      separator < 6 ||
      fields[5] === undefined
    )
      return fail("testkit.pty.immutable-candidate");
    const options = new Set(fields[5].split(","));
    if (mountTable.has(mountId) || options.has("rw") === options.has("ro"))
      return fail("testkit.pty.immutable-candidate");
    mountTable.set(mountId, options);
  }
  return mountTable;
};

const parseImmutableFdMountId = (source: string): number => {
  const values = source
    .split("\n")
    .filter((line) => line.startsWith("mnt_id:"));
  if (values.length !== 1) return fail("testkit.pty.immutable-candidate");
  const value = Number(values[0]!.slice("mnt_id:".length).trim());
  if (!numberIsSafeInteger(value) || value < 1)
    return fail("testkit.pty.immutable-candidate");
  return value;
};

const validateImmutableFileFacts = (facts: {
  after: { dev: number | bigint; ino: number | bigint; size: number };
  before: { dev: number | bigint; ino: number | bigint; size: number };
  digest: string;
  expectedDigest: string;
  expectedPath: string;
  isFile: boolean;
  linkPath: string;
  mountId: number;
  mountTable: ReadonlyMap<number, ReadonlySet<string>>;
}): void => {
  const options = facts.mountTable.get(facts.mountId);
  if (
    !facts.isFile ||
    facts.before.dev !== facts.after.dev ||
    facts.before.ino !== facts.after.ino ||
    facts.before.size !== facts.after.size ||
    facts.before.size < 1 ||
    facts.digest !== facts.expectedDigest ||
    options === undefined ||
    !options.has("ro") ||
    options.has("rw") ||
    facts.linkPath !== facts.expectedPath
  )
    return fail("testkit.pty.immutable-candidate");
};

const readPrincipalAuthority = (): Readonly<{
  mountIdentity: string;
  mountNamespace: string;
  mountTable: ReadonlyMap<number, ReadonlySet<string>>;
}> => {
  const groups = process.getgroups?.();
  const status = boundedProcFile("/proc/self/status", 64 * 1024);
  validatePrincipalFacts({
    uid: process.getuid?.(),
    euid: process.geteuid?.(),
    gid: process.getgid?.(),
    egid: process.getegid?.(),
    groups,
    status,
  });
  const mountNamespace = readlinkSync("/proc/self/ns/mnt");
  const mountinfo = boundedProcFile("/proc/self/mountinfo");
  const mountTable = parseImmutableMountTable(mountinfo);
  return {
    mountIdentity: createHash("sha256").update(mountinfo).digest("hex"),
    mountNamespace,
    mountTable,
  };
};

const fdMountId = (descriptor: number): number => {
  const source = boundedProcFile(`/proc/self/fdinfo/${descriptor}`, 4 * 1024);
  return parseImmutableFdMountId(source);
};

const createImmutableCandidateAuthority = (
  candidate: unknown,
): ImmutableCandidateAuthority => {
  if (immutableCandidateAuthorityCreated)
    return fail("testkit.pty.immutable-candidate");
  immutableCandidateAuthorityCreated = true;
  exactImmutableCandidateRecord(candidate);
  const initial = readPrincipalAuthority();
  const assertRuntime = (): void => {
    const current = readPrincipalAuthority();
    if (
      current.mountNamespace !== initial.mountNamespace ||
      current.mountIdentity !== initial.mountIdentity
    )
      return fail("testkit.pty.immutable-candidate");
  };
  const expectedFileDigests = new Map<string, string>();
  const authority = safeReflectApply(freeze, Object, [
    {
      assertFile: (descriptor: number, path: string): void => {
        assertRuntime();
        const before = fstatSync(descriptor);
        if (before.size < 1 || before.size > 256 * 1024 * 1024)
          return fail("testkit.pty.immutable-candidate");
        const digest = createHash("sha256")
          .update(readFileSync(`/proc/self/fd/${descriptor}`))
          .digest("hex");
        const after = fstatSync(descriptor);
        const mountId = fdMountId(descriptor);
        const expectedDigest = expectedFileDigests.get(path) ?? digest;
        validateImmutableFileFacts({
          after,
          before,
          digest,
          expectedDigest,
          expectedPath: path,
          isFile: before.isFile() && after.isFile(),
          linkPath: readlinkSync(`/proc/self/fd/${descriptor}`),
          mountId,
          mountTable: initial.mountTable,
        });
        expectedFileDigests.set(path, expectedDigest);
      },
      assertRuntime,
    },
  ]) as ImmutableCandidateAuthority;
  const pending = [resolve(import.meta.dirname, "..")];
  let entries = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const children = readdirSync(directory, { withFileTypes: true });
    for (const child of children) {
      entries += 1;
      if (entries > 1_024 || child.isSymbolicLink())
        return fail("testkit.pty.immutable-candidate");
      const path = resolve(directory, child.name);
      if (child.isDirectory()) {
        safeReflectApply(arrayPush, pending, [path]);
        continue;
      }
      if (!child.isFile()) return fail("testkit.pty.immutable-candidate");
      const descriptor = openSync(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          linuxCloseOnExec,
      );
      try {
        const before = fstatSync(descriptor);
        bytes += before.size;
        if (before.size < 1 || bytes > 64 * 1024 * 1024)
          return fail("testkit.pty.immutable-candidate");
        const digest = createHash("sha256")
          .update(readFileSync(`/proc/self/fd/${descriptor}`))
          .digest("hex");
        const after = fstatSync(descriptor);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size
        )
          return fail("testkit.pty.immutable-candidate");
        expectedFileDigests.set(path, digest);
        authority.assertFile(descriptor, path);
      } finally {
        closeSync(descriptor);
      }
    }
  }
  immutableCandidateAuthorities.add(authority);
  return authority;
};

const listContainerProcesses = (
  namespaceIdentity: string,
): readonly ProcessSnapshot[] => {
  assertNamespaceIdentity(namespaceIdentity);
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return fail("testkit.headless.observer.read");
  }
  const snapshots: ProcessSnapshot[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    if (!numberIsSafeInteger(pid) || pid < 2) continue;
    const snapshot = readProcessSnapshot(pid);
    if (snapshot !== undefined)
      safeReflectApply(arrayPush, snapshots, [snapshot]);
  }
  return snapshots.sort((left, right) => left.pid - right.pid);
};

const strictContainerProcessSnapshot = ():
  readonly ProcessSnapshot[] | undefined => {
  let names: string[];
  try {
    names = readdirSync("/proc")
      .filter((name) => /^\d+$/u.test(name))
      .sort((left, right) => Number(left) - Number(right));
  } catch {
    return fail("testkit.headless.observer.read");
  }
  const snapshots: ProcessSnapshot[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!numberIsSafeInteger(pid) || pid < 2 || pid === process.pid) continue;
    const snapshot = readProcessSnapshot(pid);
    if (snapshot === undefined) return undefined;
    safeReflectApply(arrayPush, snapshots, [snapshot]);
  }
  return snapshots;
};

const sameProcessSnapshotSet = (
  left: readonly ProcessSnapshot[],
  right: readonly ProcessSnapshot[],
): boolean =>
  left.length === right.length &&
  left.every(
    (identity, index) =>
      identity.pid === right[index]?.pid &&
      identity.parentPid === right[index]?.parentPid &&
      identity.startIdentity === right[index]?.startIdentity &&
      identity.state === right[index]?.state,
  );

const stopProcessForCheckpoint = (identity: ProcessSnapshot): void => {
  if (identity.state === "T" || identity.state === "t") return;
  try {
    process.kill(identity.pid, "SIGSTOP");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      return fail("testkit.headless.observer.signal");
  }
};

const freezeContainerProcessSet = (
  namespaceIdentity: string,
  monotonicDeadlineMs: number,
): readonly ProcessSnapshot[] => {
  assertNamespaceIdentity(namespaceIdentity);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    if (
      safeReflectApply(performanceNow, performance, []) >= monotonicDeadlineMs
    )
      return fail("testkit.headless.execution.deadline");
    const before = strictContainerProcessSnapshot();
    if (before === undefined) continue;
    for (const identity of before) stopProcessForCheckpoint(identity);
    const after = strictContainerProcessSnapshot();
    if (
      after !== undefined &&
      after.every(({ state }) => state === "T" || state === "t") &&
      sameProcessSnapshotSet(
        before.map((identity) => ({ ...identity, state: "T" })),
        after.map((identity) => ({
          ...identity,
          state: identity.state === "t" ? "T" : identity.state,
        })),
      )
    )
      return after;
  }
  return fail("testkit.headless.observer.process-set");
};

const releaseFrozenContainerProcessSet = (
  namespaceIdentity: string,
  processes: readonly ProcessSnapshot[],
  rootPid: number,
  notifyRoot: boolean,
): void => {
  assertNamespaceIdentity(namespaceIdentity);
  const ordered = [...processes].sort((left, right) => {
    if (left.pid === rootPid) return 1;
    if (right.pid === rootPid) return -1;
    return right.pid - left.pid;
  });
  for (const expected of ordered) {
    const current = readProcessSnapshot(expected.pid);
    if (
      current === undefined ||
      current.startIdentity !== expected.startIdentity ||
      (current.state !== "T" && current.state !== "t")
    )
      return fail("testkit.headless.observer.identity");
  }
  for (const expected of ordered) {
    if (expected.pid === rootPid) {
      if (notifyRoot) process.kill(expected.pid, "SIGUSR2");
      process.kill(expected.pid, "SIGCONT");
    } else process.kill(expected.pid, "SIGCONT");
  }
};

const delay = (milliseconds: number): Promise<void> =>
  observeAtCreation(
    new SafePromise((resolve) => {
      safeSetTimeout(resolve, maximum(0, milliseconds));
    }),
  );

const captureStream = (
  stream: NodeJS.ReadableStream,
  limit: number,
  overflow: () => void,
): Readonly<{ close: Promise<void>; read: () => CapturedOutput }> => {
  const state: MutableOutput = { chunks: [], length: 0, truncated: false };
  let resolveClose!: () => void;
  let rejectClose!: (error: unknown) => void;
  const close = observeAtCreation(
    new SafePromise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    }),
  );
  stream.on("data", (candidate: unknown) => {
    const chunk = Buffer.isBuffer(candidate)
      ? candidate
      : safeBufferFrom(candidate as Uint8Array);
    const available = maximum(0, limit - state.length);
    if (available > 0) {
      const selected = chunk.subarray(0, minimum(available, chunk.length));
      safeReflectApply(arrayPush, state.chunks, [safeBufferFrom(selected)]);
      state.length += selected.length;
    }
    if (chunk.length > available && !state.truncated) {
      state.truncated = true;
      overflow();
    }
  });
  stream.once("end", resolveClose);
  stream.once("close", resolveClose);
  stream.once("error", rejectClose);
  return {
    close,
    read: () => ({
      bytes: new SafeUint8Array(safeBufferConcat(state.chunks, state.length)),
      truncated: state.truncated,
    }),
  };
};

const processClose = (
  child: ChildProcess,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> =>
  observeAtCreation(
    new SafePromise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }),
  );

const signalExactProcess = (
  identity: ProcessSnapshot,
  signal: "SIGTERM" | "SIGKILL",
  ledger: HeadlessObservedSignal[],
  namespaceIdentity: string,
  runtime: ProcessAuthorityRuntime,
): boolean => {
  runtime.assertNamespaceIdentity(namespaceIdentity);
  const current = runtime.readProcess(identity.pid);
  if (current === undefined) return false;
  if (current.startIdentity !== identity.startIdentity)
    return fail("testkit.headless.observer.identity");
  try {
    runtime.sendSignal(identity.pid, signal);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    )
      return false;
    return fail("testkit.headless.observer.signal");
  }
  safeReflectApply(arrayPush, ledger, [
    {
      monotonicAtMs: safeReflectApply(performanceNow, performance, []),
      signal,
      targetStartIdentity: identity.startIdentity,
    },
  ]);
  return true;
};

type PtyExit = Readonly<{ code: number; signal: number }>;
type PtyTerminalHandle = object;
type PtyTerminalObservation = Readonly<{
  canonical: boolean;
  columns: number;
  eofByte: number;
  isTTY: boolean;
  rows: number;
}>;
type PtyReadObservation =
  | Readonly<{ status: "data"; bytes: Buffer }>
  | Readonly<{ status: "eof" | "eio" | "would-block" }>;
type PtyWriteObservation = Readonly<{
  status: "complete" | "partial" | "would-block";
  bytesWritten: number;
}>;
type PtyProcess = Readonly<{
  pid: number;
  closed: Promise<PtyExit>;
  close: () => void;
  eof: () => Readonly<{
    canonical: true;
    eofByte: number;
    bytesWritten: 1;
    status: "eof-byte-written";
  }>;
  inspect: () => PtyTerminalObservation;
  read: (maximumBytes: number) => PtyReadObservation;
  resize: (columns: number, rows: number) => void;
  write: (bytes: Buffer) => PtyWriteObservation;
}>;
type PtyRuntime = Readonly<{
  assertImmutableCandidateFile: (descriptor: number, path: string) => void;
  assertImmutableCandidateRuntime: () => void;
  assertNamespaceIdentity: (expected: string) => void;
  freezeProcessSet: (
    namespaceIdentity: string,
    monotonicDeadlineMs: number,
  ) => readonly ProcessSnapshot[];
  listProcesses: (namespaceIdentity: string) => readonly ProcessSnapshot[];
  readProcess: (pid: number) => ProcessSnapshot | undefined;
  reapAdoptedZombie: (
    pid: number,
    startIdentity: string,
    rootPid: number,
    monotonicDeadlineNs: bigint,
  ) => AdoptedZombieReapReceipt;
  releaseFrozenProcessSet: (
    namespaceIdentity: string,
    processes: readonly ProcessSnapshot[],
    rootPid: number,
    notifyRoot: boolean,
  ) => void;
  sendSignal: (pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL") => void;
  spawnPty: (
    request: HeadlessExecutionRequest,
    geometry: Readonly<{ columns: number; rows: number }>,
    interpreter: Readonly<{ path: string; sha256: string }>,
    scriptSha256: string,
  ) => PtyProcess;
}>;
type NativePtyBinding = Readonly<{
  // Mirrors the fixed upstream N-API entry point; callers cannot vary it.
  // eslint-disable-next-line max-params
  fork: (
    interpreterFd: number,
    scriptFd: number,
    arguments_: readonly string[],
    environment: readonly string[],
    cwd: string,
    columns: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helperPath: string,
    monotonicDeadlineNs: bigint,
    onExit: (code: number, signal: number) => void,
  ) => Readonly<{ handle: PtyTerminalHandle; pid: number }>;
  close: (handle: PtyTerminalHandle) => void;
  eof: (handle: PtyTerminalHandle) => Readonly<{
    canonical: true;
    eofByte: number;
    bytesWritten: 1;
    status: "eof-byte-written";
  }>;
  inspect: (handle: PtyTerminalHandle) => PtyTerminalObservation;
  read: (handle: PtyTerminalHandle, maximumBytes: number) => PtyReadObservation;
  reapAdoptedZombie: (
    pid: number,
    startIdentity: string,
    rootPid: number,
    monotonicDeadlineNs: bigint,
  ) => AdoptedZombieReapReceipt;
  resize: (
    handle: PtyTerminalHandle,
    columns: number,
    rows: number,
    xPixel: number,
    yPixel: number,
  ) => void;
  write: (handle: PtyTerminalHandle, bytes: Buffer) => PtyWriteObservation;
}>;
const ptyRuntimeArtifacts = Object.freeze({
  glibc: Object.freeze({
    digest: "18bc800a4dcf564822df1ca0bedd18adfd3fe602669218933d39723e12686727",
    tuple: "node127-linux-x64-glibc",
  }),
  musl: Object.freeze({
    digest: "00c2d70427923ec598dd105a78d5eb099e7ad52accfa98ef65cc9f2195c3a8ff",
    tuple: "node127-linux-x64-musl",
  }),
});
type PtyRuntimePlatformFacts = Readonly<{
  alpineRelease?: string;
  architecture: string;
  nodeAbi: string;
  os: string;
  osRelease?: string;
}>;
const exactPtyRuntimeArtifact = (facts: PtyRuntimePlatformFacts) => {
  if (
    facts.os !== "linux" ||
    facts.architecture !== "x64" ||
    facts.nodeAbi !== "127"
  )
    return fail("testkit.pty.runtime.identity");
  if (facts.alpineRelease !== undefined) {
    if (facts.alpineRelease === "3.24.1\n" && facts.osRelease === undefined)
      return ptyRuntimeArtifacts.musl;
    return fail("testkit.pty.runtime.identity");
  }
  const fields = facts.osRelease?.trimEnd().split("\n") ?? [];
  if (
    fields.length > 32 ||
    fields.some((field) => field.length > 256) ||
    fields.filter((field) => field === "ID=debian").length !== 1 ||
    fields.filter((field) => field === 'VERSION_ID="12"').length !== 1
  )
    return fail("testkit.pty.runtime.identity");
  return ptyRuntimeArtifacts.glibc;
};
const selectedPtyRuntimeArtifact = () => {
  let alpineRelease: string | undefined;
  try {
    alpineRelease = readFileSync("/etc/alpine-release", "utf8");
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ENOENT"
    )
      throw error;
  }
  return exactPtyRuntimeArtifact({
    architecture: process.arch,
    nodeAbi: process.versions.modules,
    os: process.platform,
    ...(alpineRelease === undefined
      ? { osRelease: boundedProcFile("/etc/os-release", 4 * 1024) }
      : { alpineRelease }),
  });
};
/** Package-private platform oracle; it conveys no loading authority. */
export const selectPtyRuntimeTupleForTest = (
  facts: PtyRuntimePlatformFacts,
): string => exactPtyRuntimeArtifact(facts).tuple;
// Linux O_CLOEXEC is not exposed by every supported @types/node version.
const linuxCloseOnExec = 0x8_0000;
const assertAuthenticatedRegularFileDescriptor = (
  descriptor: number,
  path: string,
  expected: string,
  maximumBytes: number,
  assertImmutable?: (descriptor: number, path: string) => void,
): void => {
  const before = fstatSync(descriptor);
  if (!before.isFile() || before.size < 1 || before.size > maximumBytes)
    return fail("testkit.pty.runtime.identity");
  const bytes_ = readFileSync(`/proc/self/fd/${descriptor}`);
  const after = fstatSync(descriptor);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    createHash("sha256").update(bytes_).digest("hex") !== expected
  )
    return fail("testkit.pty.runtime.identity");
  assertImmutable?.(descriptor, path);
};
const openAuthenticatedRegularFile = (
  path: string,
  expected: string,
  maximumBytes: number,
  assertImmutable?: (descriptor: number, path: string) => void,
): number => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      linuxCloseOnExec,
  );
  try {
    assertAuthenticatedRegularFileDescriptor(
      descriptor,
      path,
      expected,
      maximumBytes,
      assertImmutable,
    );
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
};
let nativePtyBinding: NativePtyBinding | undefined;
const loadNativePtyBinding = (
  authority: ImmutableCandidateAuthority,
): NativePtyBinding => {
  if (nativePtyBinding !== undefined) return nativePtyBinding;
  const artifact = selectedPtyRuntimeArtifact();
  const path = resolve(
    import.meta.dirname,
    `../pty-runtime/${artifact.tuple}/pty.node`,
  );
  const descriptor = openAuthenticatedRegularFile(
    path,
    artifact.digest,
    1024 * 1024,
    authority.assertFile,
  );
  let candidate: unknown;
  try {
    authority.assertRuntime();
    assertAuthenticatedRegularFileDescriptor(
      descriptor,
      path,
      artifact.digest,
      1024 * 1024,
      authority.assertFile,
    );
    const moduleAuthority: { exports: unknown } = { exports: {} };
    safeReflectApply(processDlopen, process, [
      moduleAuthority,
      `/proc/self/fd/${descriptor}`,
    ]);
    candidate = moduleAuthority.exports;
  } finally {
    closeSync(descriptor);
  }
  if (
    !plainRecord(candidate) ||
    typeof ownData(candidate, "fork") !== "function" ||
    typeof ownData(candidate, "resize") !== "function" ||
    typeof ownData(candidate, "inspect") !== "function" ||
    typeof ownData(candidate, "read") !== "function" ||
    typeof ownData(candidate, "write") !== "function" ||
    typeof ownData(candidate, "reapAdoptedZombie") !== "function" ||
    typeof ownData(candidate, "eof") !== "function" ||
    typeof ownData(candidate, "close") !== "function"
  )
    return fail("testkit.pty.runtime.identity");
  nativePtyBinding = candidate as NativePtyBinding;
  return nativePtyBinding;
};
const deriveNativeMonotonicDeadline = (
  deadlineMs: number,
  nativeNowNs: bigint,
  performanceNowMs: number,
): bigint => {
  const remainingMilliseconds = deadlineMs - performanceNowMs;
  if (remainingMilliseconds <= 0)
    return fail("testkit.headless.reconciliation.deadline");
  return nativeNowNs + BigInt(Math.floor(remainingMilliseconds * 1e6));
};
const captureNativeMonotonicDeadline = (deadlineMs: number): bigint => {
  // Native time is sampled first, so preemption before the performance-clock
  // sample can only shorten this authority; it can never renew the deadline.
  const nativeNowNs = safeReflectApply(processHrtimeBigint, process.hrtime, []);
  const performanceNowMs = safeReflectApply(performanceNow, performance, []);
  return deriveNativeMonotonicDeadline(
    deadlineMs,
    nativeNowNs,
    performanceNowMs,
  );
};
/** Package-private clock-bridge oracle; it conveys no execution authority. */
export const deriveNativeMonotonicDeadlineForTest = (
  deadlineMs: number,
  nativeNowNs: bigint,
  performanceNowMs: number,
): bigint =>
  deriveNativeMonotonicDeadline(deadlineMs, nativeNowNs, performanceNowMs);
const exactAdoptedZombieReapReceipt = (
  value: AdoptedZombieReapReceipt,
  identity: ProcessSnapshot,
): AdoptedZombieReapReceipt => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "pid\0startIdentity\0status" ||
    ownData(value, "pid") !== identity.pid ||
    ownData(value, "startIdentity") !== identity.startIdentity ||
    (ownData(value, "status") !== "already-absent" &&
      ownData(value, "status") !== "not-ready" &&
      ownData(value, "status") !== "reaped")
  )
    return fail("testkit.headless.observer.reap");
  return value;
};
const processesDescendantsFirst = (
  processes: readonly ProcessSnapshot[],
  rootPid: number,
): readonly ProcessSnapshot[] => {
  const byPid = new Map<number, ProcessSnapshot>();
  const identities = new Set<string>();
  for (const identity of processes) {
    if (byPid.has(identity.pid) || identities.has(identity.startIdentity))
      return fail("testkit.headless.observer.identity");
    byPid.set(identity.pid, identity);
    identities.add(identity.startIdentity);
  }
  const depths = new Map<number, number>();
  const depth = (identity: ProcessSnapshot, visiting: Set<number>): number => {
    const cached = depths.get(identity.pid);
    if (cached !== undefined) return cached;
    if (visiting.has(identity.pid))
      return fail("testkit.headless.observer.identity");
    visiting.add(identity.pid);
    const parent = byPid.get(identity.parentPid);
    if (parent === undefined && identity.parentPid !== 1)
      return fail("testkit.headless.observer.identity");
    const value = parent === undefined ? 0 : depth(parent, visiting) + 1;
    visiting.delete(identity.pid);
    depths.set(identity.pid, value);
    return value;
  };
  return [...processes].sort((left, right) => {
    if (left.pid === rootPid) return 1;
    if (right.pid === rootPid) return -1;
    const depthDifference = depth(right, new Set()) - depth(left, new Set());
    if (depthDifference !== 0) return depthDifference;
    return right.pid - left.pid;
  });
};
const reapAdoptedZombies = (
  processes: readonly ProcessSnapshot[],
  rootPid: number,
  nativeDeadlineNs: bigint,
  namespaceIdentity: string,
  runtime: ProcessAuthorityRuntime,
): void => {
  for (const identity of processesDescendantsFirst(processes, rootPid)) {
    if (
      identity.pid === rootPid ||
      identity.parentPid !== 1 ||
      identity.state !== "Z"
    )
      continue;
    runtime.assertNamespaceIdentity(namespaceIdentity);
    const current = runtime.readProcess(identity.pid);
    if (
      current === undefined ||
      current.startIdentity !== identity.startIdentity ||
      current.parentPid !== 1 ||
      current.state !== "Z"
    )
      return fail("testkit.headless.observer.identity");
    const receipt = exactAdoptedZombieReapReceipt(
      runtime.reapAdoptedZombie(
        identity.pid,
        identity.startIdentity,
        rootPid,
        nativeDeadlineNs,
      ),
      identity,
    );
    const after = runtime.readProcess(identity.pid);
    if (after !== undefined && after.startIdentity !== identity.startIdentity)
      return fail("testkit.headless.observer.identity");
    if (
      (receipt.status !== "reaped" && receipt.status !== "already-absent") ||
      after !== undefined
    )
      return fail("testkit.headless.observer.reap");
  }
};
const productionContainerRuntime = (
  authority: ImmutableCandidateAuthority,
): SelectedContainerRuntime => {
  const binding = loadNativePtyBinding(authority);
  return {
    assertNamespaceIdentity,
    listProcesses: listContainerProcesses,
    readProcess: readProcessSnapshot,
    reapAdoptedZombie: (pid, startIdentity, rootPid, deadline) => {
      authority.assertRuntime();
      return binding.reapAdoptedZombie(pid, startIdentity, rootPid, deadline);
    },
    sendSignal: (pid, signal) => process.kill(pid, signal),
    spawnProcess: (request) =>
      spawn(request.executable, [...request.arguments], {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
  };
};
const productionPtyRuntime = (
  authority: ImmutableCandidateAuthority,
): PtyRuntime => ({
  assertImmutableCandidateFile: authority.assertFile,
  assertImmutableCandidateRuntime: authority.assertRuntime,
  assertNamespaceIdentity,
  freezeProcessSet: freezeContainerProcessSet,
  listProcesses: listContainerProcesses,
  readProcess: readProcessSnapshot,
  reapAdoptedZombie: (pid, startIdentity, rootPid, deadline) => {
    authority.assertRuntime();
    return loadNativePtyBinding(authority).reapAdoptedZombie(
      pid,
      startIdentity,
      rootPid,
      deadline,
    );
  },
  releaseFrozenProcessSet: releaseFrozenContainerProcessSet,
  sendSignal: (pid, signal) => process.kill(pid, signal),
  spawnPty: (request, geometry, interpreter, scriptSha256) => {
    authority.assertRuntime();
    const binding = loadNativePtyBinding(authority);
    let resolveClose!: (exit: PtyExit) => void;
    const closed = observeAtCreation(
      new SafePromise<PtyExit>((resolve_) => {
        resolveClose = resolve_;
      }),
    );
    const environment = safeReflectApply(objectKeys, Object, [
      request.environment,
    ]).map((key) => `${key}=${request.environment[key]}`);
    const interpreterFd = openAuthenticatedRegularFile(
      interpreter.path,
      interpreter.sha256,
      256 * 1024 * 1024,
      authority.assertFile,
    );
    let scriptFd: number | undefined;
    let result: Readonly<{ handle: PtyTerminalHandle; pid: number }>;
    try {
      scriptFd = openAuthenticatedRegularFile(
        request.executable,
        scriptSha256,
        16 * 1024 * 1024,
        authority.assertFile,
      );
      const remainingMilliseconds = maximum(
        0,
        request.monotonicShutdownDeadlineMs -
          safeReflectApply(performanceNow, performance, []),
      );
      authority.assertRuntime();
      assertAuthenticatedRegularFileDescriptor(
        interpreterFd,
        interpreter.path,
        interpreter.sha256,
        256 * 1024 * 1024,
        authority.assertFile,
      );
      assertAuthenticatedRegularFileDescriptor(
        scriptFd,
        request.executable,
        scriptSha256,
        16 * 1024 * 1024,
        authority.assertFile,
      );
      result = binding.fork(
        interpreterFd,
        scriptFd,
        request.arguments,
        environment,
        request.cwd,
        geometry.columns,
        geometry.rows,
        -1,
        -1,
        true,
        "",
        safeReflectApply(processHrtimeBigint, process.hrtime, []) +
          BigInt(Math.floor(remainingMilliseconds * 1e6)),
        (code, signal) => {
          resolveClose({ code, signal });
        },
      );
    } finally {
      if (scriptFd !== undefined) closeSync(scriptFd);
      closeSync(interpreterFd);
    }
    if (
      !numberIsSafeInteger(result.pid) ||
      result.pid < 2 ||
      typeof result.handle !== "object" ||
      result.handle === null
    ) {
      if (typeof result.handle === "object" && result.handle !== null)
        try {
          binding.close(result.handle);
        } catch {
          // The caller receives uncertainty regardless of close behavior.
        }
      return fail("testkit.headless.reconciliation.deadline");
    }
    return {
      pid: result.pid,
      closed,
      close: () => {
        binding.close(result.handle);
      },
      eof: () => binding.eof(result.handle),
      inspect: () => binding.inspect(result.handle),
      read: (maximumBytes) => binding.read(result.handle, maximumBytes),
      resize: (columns, rows) => {
        binding.resize(result.handle, columns, rows, 0, 0);
      },
      write: (bytes) => binding.write(result.handle, bytes),
    };
  },
});

// The closed request schema intentionally validates every nested authority field.
const snapshotPtyRequest = (
  candidate: SelectedPtyExecutionRequest,
  // eslint-disable-next-line complexity,max-lines-per-function
): SelectedPtyExecutionRequest => {
  if (!plainRecord(candidate)) return fail("testkit.pty.request");
  const keys = safeReflectApply(objectKeys, Object, [candidate]).sort();
  if (
    keys.length !== 7 ||
    keys[0] !== "completion" ||
    keys[1] !== "initialGeometry" ||
    keys[2] !== "interaction" ||
    keys[3] !== "interpreter" ||
    keys[4] !== "process" ||
    keys[5] !== "readiness" ||
    keys[6] !== "scriptSha256"
  )
    return fail("testkit.pty.request");
  const process_ = snapshotSelectedRequest(
    ownData(candidate, "process") as HeadlessExecutionRequest,
  );
  const geometry = ownData(candidate, "initialGeometry");
  if (!plainRecord(geometry)) return fail("testkit.pty.geometry");
  const geometryKeys = safeReflectApply(objectKeys, Object, [geometry]).sort();
  const columns = ownData(geometry, "columns");
  const rows = ownData(geometry, "rows");
  if (
    geometryKeys.length !== 2 ||
    geometryKeys[0] !== "columns" ||
    geometryKeys[1] !== "rows" ||
    !boundedInteger(columns, 512) ||
    !boundedInteger(rows, 512) ||
    columns * rows > 65_536
  )
    return fail("testkit.pty.geometry");
  const interpreter = ownData(candidate, "interpreter");
  const interaction = ownData(candidate, "interaction");
  const completion = ownData(candidate, "completion");
  const readiness = ownData(candidate, "readiness");
  const scriptSha256 = ownData(candidate, "scriptSha256");
  if (!plainRecord(interpreter)) return fail("testkit.pty.runtime.identity");
  const interpreterKeys = safeReflectApply(objectKeys, Object, [
    interpreter,
  ]).sort();
  const interpreterPath = ownData(interpreter, "path");
  const interpreterSha256 = ownData(interpreter, "sha256");
  if (
    interpreterKeys.length !== 2 ||
    interpreterKeys[0] !== "path" ||
    interpreterKeys[1] !== "sha256" ||
    typeof interpreterPath !== "string" ||
    !interpreterPath.startsWith("/") ||
    typeof interpreterSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(interpreterSha256) ||
    typeof scriptSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(scriptSha256)
  )
    return fail("testkit.pty.runtime.identity");
  if (!plainRecord(completion)) return fail("testkit.pty.request");
  const completionKeys = safeReflectApply(objectKeys, Object, [
    completion,
  ]).sort();
  const completionKind = ownData(completion, "kind");
  if (
    (completionKind === "semantic-marker" &&
      completionKeys.join("\0") !== "kind") ||
    (completionKind === "exact-output" &&
      (completionKeys.join("\0") !== "kind\0outputBytes\0outputSha256" ||
        !boundedInteger(ownData(completion, "outputBytes"), 4_096) ||
        ownData(completion, "outputBytes") === 0 ||
        !/^[a-f0-9]{64}$/u.test(
          ownData(completion, "outputSha256") as string,
        ))) ||
    (completionKind !== "semantic-marker" && completionKind !== "exact-output")
  )
    return fail("testkit.pty.request");
  if (!plainRecord(readiness)) return fail("testkit.pty.request");
  const readinessKeys = safeReflectApply(objectKeys, Object, [readiness])
    .sort()
    .join("\0");
  const readinessKind = ownData(readiness, "kind");
  let stableReadiness;
  let readinessChallenge: string | undefined;
  if (readinessKind === "semantic-marker" && readinessKeys === "kind")
    stableReadiness = safeReflectApply(freeze, Object, [
      { kind: "semantic-marker" as const },
    ]);
  else if (
    readinessKind === "challenge-process-topology" &&
    readinessKeys === "challenge\0kind"
  ) {
    const challenge = ownData(readiness, "challenge");
    if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/u.test(challenge))
      return fail("testkit.pty.request");
    readinessChallenge = challenge;
    stableReadiness = safeReflectApply(freeze, Object, [
      { kind: "challenge-process-topology" as const, challenge },
    ]);
  } else if (
    readinessKind === "challenge-marker" &&
    readinessKeys === "challenge\0kind"
  ) {
    const challenge = ownData(readiness, "challenge");
    if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/u.test(challenge))
      return fail("testkit.pty.request");
    readinessChallenge = challenge;
    stableReadiness = safeReflectApply(freeze, Object, [
      { kind: "challenge-marker" as const, challenge },
    ]);
  } else if (
    readinessKind === "challenge-styled-text" &&
    readinessKeys ===
      "bold\0challenge\0dim\0kind\0requiredTerminalProtocol\0requiredText\0text"
  ) {
    const challenge = ownData(readiness, "challenge");
    const readinessText = ownData(readiness, "text");
    const readinessBold = ownData(readiness, "bold");
    const readinessDim = ownData(readiness, "dim");
    const requiredText = ownData(readiness, "requiredText");
    const requiredTerminalProtocol = ownData(
      readiness,
      "requiredTerminalProtocol",
    );
    if (
      typeof challenge !== "string" ||
      !/^[a-f0-9]{64}$/u.test(challenge) ||
      typeof readinessText !== "string" ||
      [...readinessText].length !== 1 ||
      (readinessText.codePointAt(0) ?? 0) < 0x20 ||
      readinessText.codePointAt(0) === 0x7f ||
      typeof readinessBold !== "boolean" ||
      typeof readinessDim !== "boolean" ||
      typeof requiredText !== "string" ||
      requiredText.length < 1 ||
      requiredText.length > 32 ||
      [...requiredText].some(
        (character) =>
          (character.codePointAt(0) ?? 0) < 0x20 ||
          character.codePointAt(0) === 0x7f,
      ) ||
      requiredTerminalProtocol !== "csi-u-flags-7-query-v1"
    )
      return fail("testkit.pty.request");
    readinessChallenge = challenge;
    stableReadiness = safeReflectApply(freeze, Object, [
      {
        kind: "challenge-styled-text" as const,
        challenge,
        text: readinessText,
        requiredText,
        requiredTerminalProtocol,
        bold: readinessBold,
        dim: readinessDim,
      },
    ]);
  } else if (
    readinessKind === "styled-text-after-completion" &&
    readinessKeys === "bold\0dim\0kind\0text"
  ) {
    const readinessText = ownData(readiness, "text");
    const readinessBold = ownData(readiness, "bold");
    const readinessDim = ownData(readiness, "dim");
    if (
      typeof readinessText !== "string" ||
      [...readinessText].length !== 1 ||
      (readinessText.codePointAt(0) ?? 0) < 0x20 ||
      readinessText.codePointAt(0) === 0x7f ||
      typeof readinessBold !== "boolean" ||
      typeof readinessDim !== "boolean"
    )
      return fail("testkit.pty.request");
    stableReadiness = safeReflectApply(freeze, Object, [
      {
        kind: "styled-text-after-completion" as const,
        text: readinessText,
        bold: readinessBold,
        dim: readinessDim,
      },
    ]);
  } else return fail("testkit.pty.request");
  if (!plainRecord(interaction)) return fail("testkit.pty.request");
  const interactionKeys = safeReflectApply(objectKeys, Object, [
    interaction,
  ]).sort();
  const trigger = ownData(interaction, "trigger");
  const actions = ownData(interaction, "actions");
  const actionOwnKeys = arrayIsArray(actions)
    ? safeReflectApply(reflectOwnKeys, Reflect, [actions])
    : [];
  if (
    interactionKeys.join("\0") !== "actions\0trigger" ||
    (trigger !== "immediate" && trigger !== "semantic-ready") ||
    !arrayIsArray(actions) ||
    isProxy(actions) ||
    getPrototypeOf(actions) !== arrayPrototype ||
    actions.length < 1 ||
    actions.length > 64 ||
    actionOwnKeys.length !== actions.length + 1 ||
    (completionKind === "semantic-marker" &&
      trigger !== "semantic-ready" &&
      !(
        (readinessKind === "challenge-process-topology" ||
          readinessKind === "challenge-marker" ||
          readinessKind === "challenge-styled-text") &&
        trigger === "immediate"
      )) ||
    (completionKind === "exact-output" && trigger !== "immediate")
  )
    return fail("testkit.pty.request");
  const stableActions = new SafeArray<SelectedPtyExecutionAction>(
    actions.length,
  );
  let describedInputBytes = 0;
  let eofCount = 0;
  let semanticWaitCount = 0;
  let semanticWaitIndex = -1;
  let describedInputBytesAtSemanticWait = -1;
  let topologyCheckpointCount = 0;
  let topologyCheckpointIndex = -1;
  let inputCountBeforeSemanticWait = 0;
  let firstInputIndex = -1;
  let firstInputByteLength = -1;
  let secondInputIndex = -1;
  let secondInputByteLength = -1;
  let thirdInputIndex = -1;
  let thirdInputByteLength = -1;
  let controlBeforeSemanticWait = false;
  for (let index = 0; index < actions.length; index += 1) {
    const action = ownData(actions, String(index));
    if (!plainRecord(action)) return fail("testkit.pty.request");
    const actionKind = ownData(action, "action");
    const actionKeys = safeReflectApply(objectKeys, Object, [action])
      .sort()
      .join("\0");
    if (
      safeReflectApply(reflectOwnKeys, Reflect, [action]).length !==
      safeReflectApply(objectKeys, Object, [action]).length
    )
      return fail("testkit.pty.request");
    if (actionKind === "input") {
      const byteLength = ownData(action, "byteLength");
      const inputSha256 = ownData(action, "inputSha256");
      if (
        actionKeys !== "action\0byteLength\0inputSha256" ||
        !boundedNonnegativeInteger(byteLength, maximumStdinBytes) ||
        byteLength === 0 ||
        typeof inputSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(inputSha256) ||
        createHash("sha256")
          .update(
            safeBufferFrom(process_.stdin).subarray(
              describedInputBytes,
              describedInputBytes + byteLength,
            ),
          )
          .digest("hex") !== inputSha256
      )
        return fail("testkit.pty.request");
      if (semanticWaitCount === 0) {
        inputCountBeforeSemanticWait += 1;
        if (inputCountBeforeSemanticWait === 1) {
          firstInputIndex = index;
          firstInputByteLength = byteLength;
        } else if (inputCountBeforeSemanticWait === 2) {
          secondInputIndex = index;
          secondInputByteLength = byteLength;
        } else if (inputCountBeforeSemanticWait === 3) {
          thirdInputIndex = index;
          thirdInputByteLength = byteLength;
        }
      }
      describedInputBytes += byteLength;
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          { action: "input", byteLength, inputSha256 },
        ]) as SelectedPtyExecutionAction,
      );
    } else if (actionKind === "checkpoint-process-topology") {
      const topology = ownData(action, "topology");
      if (
        actionKeys !== "action\0topology" ||
        topology !== "root-with-contained-process-set"
      )
        return fail("testkit.pty.request");
      topologyCheckpointCount += 1;
      topologyCheckpointIndex = index;
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          {
            action: "checkpoint-process-topology",
            topology,
          },
        ]) as SelectedPtyExecutionAction,
      );
    } else if (actionKind === "resize") {
      const next = ownData(action, "geometry");
      if (
        actionKeys !== "action\0geometry" ||
        !plainRecord(next) ||
        safeReflectApply(objectKeys, Object, [next]).sort().join("\0") !==
          "columns\0rows" ||
        !boundedInteger(ownData(next, "columns"), 512) ||
        !boundedInteger(ownData(next, "rows"), 512) ||
        ownData(next, "columns") === 0 ||
        ownData(next, "rows") === 0 ||
        (ownData(next, "columns") as number) *
          (ownData(next, "rows") as number) >
          65_536
      )
        return fail("testkit.pty.request");
      if (
        safeReflectApply(reflectOwnKeys, Reflect, [next]).length !==
        safeReflectApply(objectKeys, Object, [next]).length
      )
        return fail("testkit.pty.request");
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          {
            action: "resize",
            geometry: safeReflectApply(freeze, Object, [
              {
                columns: ownData(next, "columns"),
                rows: ownData(next, "rows"),
              },
            ]),
          },
        ]) as SelectedPtyExecutionAction,
      );
    } else if (actionKind === "eof") {
      if (actionKeys !== "action") return fail("testkit.pty.request");
      if (semanticWaitCount === 0) controlBeforeSemanticWait = true;
      eofCount += 1;
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          { action: "eof" },
        ]) as SelectedPtyExecutionAction,
      );
    } else if (actionKind === "wait-for-semantic-completion") {
      if (actionKeys !== "action") return fail("testkit.pty.request");
      semanticWaitCount += 1;
      semanticWaitIndex = index;
      describedInputBytesAtSemanticWait = describedInputBytes;
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          { action: "wait-for-semantic-completion" },
        ]) as SelectedPtyExecutionAction,
      );
    } else if (actionKind === "interrupt-byte") {
      if (actionKeys !== "action\0byte" || ownData(action, "byte") !== 3)
        return fail("testkit.pty.request");
      if (semanticWaitCount === 0) controlBeforeSemanticWait = true;
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          { action: "interrupt-byte", byte: 3 },
        ]) as SelectedPtyExecutionAction,
      );
    } else if (actionKind === "signal") {
      const signal = ownData(action, "signal");
      if (
        actionKeys !== "action\0signal" ||
        (signal !== "SIGINT" && signal !== "SIGTERM" && signal !== "SIGKILL")
      )
        return fail("testkit.pty.request");
      if (semanticWaitCount === 0) controlBeforeSemanticWait = true;
      defineArrayIndex(
        stableActions,
        index,
        safeReflectApply(freeze, Object, [
          { action: "signal", signal },
        ]) as SelectedPtyExecutionAction,
      );
    } else return fail("testkit.pty.request");
  }
  if (
    describedInputBytes !==
      safeReflectApply(typedArrayByteLength, process_.stdin, []) ||
    eofCount > 1 ||
    ((readinessKind === "challenge-process-topology" ||
      readinessKind === "challenge-marker" ||
      readinessKind === "challenge-styled-text") &&
      (trigger !== "immediate" ||
        semanticWaitCount !== 1 ||
        topologyCheckpointCount !== 1 ||
        controlBeforeSemanticWait ||
        inputCountBeforeSemanticWait < 1 ||
        inputCountBeforeSemanticWait > 3 ||
        firstInputByteLength !== 65 ||
        topologyCheckpointIndex !== firstInputIndex + 1 ||
        (readinessKind === "challenge-styled-text"
          ? inputCountBeforeSemanticWait !== 3 ||
            secondInputIndex !== topologyCheckpointIndex + 1 ||
            thirdInputIndex !== secondInputIndex + 1 ||
            semanticWaitIndex !== thirdInputIndex + 1 ||
            secondInputByteLength < 1 ||
            thirdInputByteLength !== 5 ||
            safeBufferFrom(process_.stdin)[
              describedInputBytesAtSemanticWait - 5
            ] !== 0x1b ||
            safeBufferFrom(process_.stdin)[
              describedInputBytesAtSemanticWait - 4
            ] !== 0x5b ||
            safeBufferFrom(process_.stdin)[
              describedInputBytesAtSemanticWait - 3
            ] !== 0x31 ||
            safeBufferFrom(process_.stdin)[
              describedInputBytesAtSemanticWait - 2
            ] !== 0x33 ||
            safeBufferFrom(process_.stdin)[
              describedInputBytesAtSemanticWait - 1
            ] !== 0x75
          : inputCountBeforeSemanticWait === 1
            ? semanticWaitIndex !== topologyCheckpointIndex + 1
            : inputCountBeforeSemanticWait === 2
              ? secondInputIndex !== topologyCheckpointIndex + 1 ||
                semanticWaitIndex !== secondInputIndex + 1
              : secondInputIndex !== topologyCheckpointIndex + 1 ||
                thirdInputIndex !== secondInputIndex + 1 ||
                semanticWaitIndex !== thirdInputIndex + 1 ||
                secondInputByteLength < 1 ||
                thirdInputByteLength !== 5 ||
                safeBufferFrom(process_.stdin)[
                  describedInputBytesAtSemanticWait - 5
                ] !== 0x1b ||
                safeBufferFrom(process_.stdin)[
                  describedInputBytesAtSemanticWait - 4
                ] !== 0x5b ||
                safeBufferFrom(process_.stdin)[
                  describedInputBytesAtSemanticWait - 3
                ] !== 0x31 ||
                safeBufferFrom(process_.stdin)[
                  describedInputBytesAtSemanticWait - 2
                ] !== 0x33 ||
                safeBufferFrom(process_.stdin)[
                  describedInputBytesAtSemanticWait - 1
                ] !== 0x75) ||
        describedInputBytesAtSemanticWait < 65 ||
        describedInputBytesAtSemanticWait > 165 ||
        describedInputBytes - describedInputBytesAtSemanticWait > 32 ||
        safeBufferFrom(process_.stdin).subarray(0, 65).toString("utf8") !==
          `${readinessChallenge}\n`))
  )
    return fail("testkit.pty.request");
  return safeReflectApply(freeze, Object, [
    {
      process: process_,
      completion: safeReflectApply(freeze, Object, [{ ...completion }]),
      initialGeometry: safeReflectApply(freeze, Object, [{ columns, rows }]),
      interaction: safeReflectApply(freeze, Object, [
        {
          actions: safeReflectApply(freeze, Object, [stableActions]),
          trigger,
        },
      ]),
      interpreter: safeReflectApply(freeze, Object, [
        { path: interpreterPath, sha256: interpreterSha256 },
      ]),
      readiness: stableReadiness,
      scriptSha256,
    },
  ]) as SelectedPtyExecutionRequest;
};

const selectedPtyRequestFingerprint = (
  request: SelectedPtyExecutionRequest,
): Readonly<{
  fingerprint: `sha256:${string}`;
  inputBytes: number;
  inputSha256: string;
}> => {
  const input = safeBufferFrom(request.process.stdin);
  const inputSha256 = createHash("sha256").update(input).digest("hex");
  const authority = {
    processRequestFingerprint: request.process.requestFingerprint,
    completion: request.completion,
    readiness: request.readiness,
    initialGeometry: request.initialGeometry,
    interaction: request.interaction,
    interpreter: request.interpreter,
    scriptSha256: request.scriptSha256,
    inputBytes: input.length,
    inputSha256,
  };
  const serialized = safeReflectApply(jsonStringify, JSON, [authority]);
  if (typeof serialized !== "string") return fail("testkit.pty.request");
  return safeReflectApply(freeze, Object, [
    {
      fingerprint: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
      inputBytes: input.length,
      inputSha256,
    },
  ]) as Readonly<{
    fingerprint: `sha256:${string}`;
    inputBytes: number;
    inputSha256: string;
  }>;
};

const ptySignal = (signal: number): "SIGINT" | "SIGTERM" | "SIGKILL" | null =>
  signal === 2
    ? "SIGINT"
    : signal === 15
      ? "SIGTERM"
      : signal === 9
        ? "SIGKILL"
        : null;

const exactPtyExit = (value: PtyExit): PtyExit => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "code\0signal" ||
    !boundedNonnegativeInteger(ownData(value, "signal"), 64) ||
    !(
      boundedNonnegativeInteger(ownData(value, "code"), 255) &&
      (ownData(value, "signal") === 0 || ownData(value, "code") === 0)
    )
  )
    return fail("testkit.pty.transport");
  return value;
};

const exactPtyObservation = (
  value: PtyTerminalObservation,
  geometry: Readonly<{ columns: number; rows: number }>,
  requireCanonicalMode: boolean,
): PtyTerminalObservation => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "canonical\0columns\0eofByte\0isTTY\0rows" ||
    ownData(value, "isTTY") !== true ||
    typeof ownData(value, "canonical") !== "boolean" ||
    (requireCanonicalMode && ownData(value, "canonical") !== true) ||
    ownData(value, "columns") !== geometry.columns ||
    ownData(value, "rows") !== geometry.rows ||
    !boundedNonnegativeInteger(ownData(value, "eofByte"), 255)
  )
    return fail("testkit.pty.geometry");
  return value;
};

const exactPtyRead = (value: PtyReadObservation): PtyReadObservation => {
  if (!plainRecord(value)) return fail("testkit.pty.transport");
  const status = ownData(value, "status");
  const keys = safeReflectApply(objectKeys, Object, [value]).sort();
  if (status === "data") {
    const bytes = ownData(value, "bytes");
    if (
      keys.join("\0") !== "bytes\0status" ||
      !Buffer.isBuffer(bytes) ||
      bytes.length < 1 ||
      bytes.length > 4_096
    )
      return fail("testkit.pty.transport");
  } else if (
    (status !== "eof" && status !== "eio" && status !== "would-block") ||
    keys.length !== 1 ||
    keys[0] !== "status"
  )
    return fail("testkit.pty.transport");
  return value;
};

const exactPtyWrite = (
  value: PtyWriteObservation,
  maximumBytes: number,
): PtyWriteObservation => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "bytesWritten\0status" ||
    (ownData(value, "status") !== "complete" &&
      ownData(value, "status") !== "partial" &&
      ownData(value, "status") !== "would-block") ||
    !boundedNonnegativeInteger(ownData(value, "bytesWritten"), maximumBytes) ||
    (ownData(value, "status") === "would-block" &&
      ownData(value, "bytesWritten") !== 0) ||
    (ownData(value, "status") === "complete" &&
      ownData(value, "bytesWritten") !== maximumBytes) ||
    (ownData(value, "status") === "partial" &&
      (ownData(value, "bytesWritten") === 0 ||
        ownData(value, "bytesWritten") === maximumBytes))
  )
    return fail("testkit.pty.transport");
  return value;
};

const armSelectedPty = (
  composition: ContainerComposition,
  runtime: PtyRuntime,
  request: SelectedPtyExecutionRequest,
  whenAborted: Promise<void>,
  // The lifecycle deliberately keeps launch, transport and teardown together.
  // eslint-disable-next-line max-lines-per-function
): Promise<ArmedPtyBackendAuthority> => {
  const processRequest = request.process;
  const requestRequiresCanonicalEof = request.interaction.actions.some(
    (action) => action.action === "eof",
  );
  if (
    processRequest.monotonicShutdownDeadlineMs >
      composition.maximumShutdownDeadlineMs ||
    safeReflectApply(performanceNow, performance, []) >=
      processRequest.monotonicStartupDeadlineMs
  )
    return fail("testkit.headless.startup.deadline");
  let resolveExpiry!: (receipt: SelectedPtyExecutionReceipt) => void;
  const expiryReceipt = observeAtCreation(
    new SafePromise<SelectedPtyExecutionReceipt>((resolve_) => {
      resolveExpiry = resolve_;
    }),
  );
  let launched = false;
  // One selected lifecycle owns the PTY, process set, deadlines and teardown.
  // eslint-disable-next-line complexity,max-lines-per-function
  const launch = async (): Promise<SelectedPtyExecutionReceipt> => {
    if (launched) return fail("testkit.headless.backend.replay");
    launched = true;
    const ptyAuthority = selectedPtyRequestFingerprint(request);
    runtime.assertImmutableCandidateRuntime();
    runtime.assertNamespaceIdentity(composition.namespaceIdentity);
    if (
      safeReflectApply(performanceNow, performance, []) >=
      processRequest.monotonicStartupDeadlineMs
    )
      return fail("testkit.headless.startup.deadline");
    const nativeShutdownDeadlineNs = captureNativeMonotonicDeadline(
      processRequest.monotonicShutdownDeadlineMs,
    );
    runtime.assertImmutableCandidateRuntime();
    const child = runtime.spawnPty(
      processRequest,
      request.initialGeometry,
      request.interpreter,
      request.scriptSha256,
    );
    let primaryFailure: string | undefined;
    if (
      safeReflectApply(performanceNow, performance, []) >=
      processRequest.monotonicStartupDeadlineMs
    )
      primaryFailure = "testkit.headless.startup.deadline";
    let terminalObservation: PtyTerminalObservation = {
      canonical: false,
      columns: request.initialGeometry.columns,
      eofByte: 0,
      isTTY: false,
      rows: request.initialGeometry.rows,
    };
    try {
      if (primaryFailure === undefined) {
        child.resize(
          request.initialGeometry.columns,
          request.initialGeometry.rows,
        );
        terminalObservation = exactPtyObservation(
          child.inspect(),
          request.initialGeometry,
          requestRequiresCanonicalEof,
        );
      }
    } catch (error) {
      primaryFailure =
        trustedErrorCode(error) ?? "testkit.pty.transport.initialization";
    }
    let root: ProcessSnapshot | undefined;
    try {
      root = runtime.readProcess(child.pid);
      if (root === undefined)
        primaryFailure ??= "testkit.headless.observer.root";
    } catch (error) {
      primaryFailure ??=
        trustedErrorCode(error) ?? "testkit.headless.observer.read";
    }
    const observed = new Map<string, ProcessSnapshot>();
    if (root !== undefined) observed.set(root.startIdentity, root);
    let authorityFailure: string | undefined;
    const currentProcessSet = (): readonly ProcessSnapshot[] => {
      if (authorityFailure !== undefined) return [];
      try {
        const current = runtime.listProcesses(composition.namespaceIdentity);
        for (const identity of current)
          if (
            root !== undefined &&
            identity.pid === root.pid &&
            identity.startIdentity !== root.startIdentity
          )
            return fail("testkit.headless.observer.identity");
        return current;
      } catch (error) {
        authorityFailure =
          trustedErrorCode(error) ?? "testkit.headless.observer.read";
        return [];
      }
    };
    const failAfterHandleSettlement = async (): Promise<never> => {
      try {
        child.close();
      } catch {
        return fail("testkit.headless.reconciliation.deadline");
      }
      await boundedInvoke(
        () => child.closed,
        processRequest.monotonicShutdownDeadlineMs,
        "testkit.headless.reconciliation.deadline",
      );
      return fail("testkit.headless.reconciliation.deadline");
    };
    const signals: HeadlessObservedSignal[] = [];
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    const outputLimitBytes = minimum(
      processRequest.stdoutLimitBytes,
      processRequest.stderrLimitBytes,
    );
    let outputLimited = false;
    let transportError = false;
    let inputOffset = 0;
    let actionInputOffset = 0;
    let actionIndex = 0;
    let lastCompletedInputOutputBytes = -1;
    let lastCompletedInputReadinessGeneration = -1;
    let drainedInputActionIndex = -1;
    let semanticCompletionObservedAtOutputBytes = -1;
    const actionsApplied: PtyTransportAction[] = [];
    const recordAction = (action: PtyTransportAction): void => {
      defineArrayIndex(
        actionsApplied,
        actionsApplied.length,
        safeReflectApply(freeze, Object, [action]) as PtyTransportAction,
      );
    };
    let readinessObserved = false;
    const topologyReadinessMarker =
      request.readiness.kind === "challenge-process-topology"
        ? safeBufferFrom(
            `AGENTSCOPE_PTY_TOPOLOGY:${request.readiness.challenge}`,
          )
        : safeBufferFrom([]);
    let topologyReadinessMarkerIndex = 0;
    let topologyReadinessMarkerObserved = false;
    const observeTopologyReadinessMarker = (captured: Buffer): void => {
      if (
        request.readiness.kind !== "challenge-process-topology" ||
        topologyReadinessMarkerObserved
      )
        return;
      for (const byte of captured) {
        if (byte === topologyReadinessMarker[topologyReadinessMarkerIndex])
          topologyReadinessMarkerIndex += 1;
        else
          topologyReadinessMarkerIndex =
            byte === topologyReadinessMarker[0] ? 1 : 0;
        if (topologyReadinessMarkerIndex === topologyReadinessMarker.length) {
          topologyReadinessMarkerObserved = true;
          return;
        }
      }
    };
    let terminalProtocolOrderingRejected = false;
    let pendingTerminalResponse = safeBufferFrom([]);
    let pendingTerminalResponseOffset = 0;
    let eofAttempted = false;
    let eofByteWritten = false;
    let outputTerminal = false;
    let transportClosed: boolean;
    let aborted = false;
    const terminal = new BoundedTerminalEmulator(
      request.initialGeometry,
      {
        ...defaultPtyTerminalEmulatorLimits,
        maximumOutputBytes: outputLimitBytes,
      },
      request.readiness.kind === "challenge-process-topology"
        ? { kind: "semantic-marker" }
        : request.readiness,
    );
    const input = safeBufferFrom(processRequest.stdin);
    // The PTY pump keeps read, semantic readiness, and the write-closed action
    // sequence adjacent so no action can escape the selected backend authority.
    // eslint-disable-next-line complexity,max-lines-per-function
    const pumpTransport = (allowInput: boolean): void => {
      try {
        const flushTerminalResponse = (): boolean => {
          if (pendingTerminalResponseOffset >= pendingTerminalResponse.length)
            return true;
          const pending = pendingTerminalResponse.subarray(
            pendingTerminalResponseOffset,
          );
          const written = exactPtyWrite(child.write(pending), pending.length);
          pendingTerminalResponseOffset += written.bytesWritten;
          const responseFlushed =
            pendingTerminalResponseOffset === pendingTerminalResponse.length;
          if (
            responseFlushed &&
            request.readiness.kind !== "challenge-process-topology"
          )
            readinessObserved = safeReflectApply(
              emulatorReadinessObserved,
              terminal,
              [],
            );
          return responseFlushed;
        };
        const collectTerminalResponse = (): void => {
          if (pendingTerminalResponseOffset < pendingTerminalResponse.length)
            return fail("testkit.pty.transport");
          const response = safeReflectApply(
            emulatorTakeTerminalResponses,
            terminal,
            [],
          );
          pendingTerminalResponse = safeBufferFrom(response);
          pendingTerminalResponseOffset = 0;
        };
        const pendingActionBeforeRead =
          request.interaction.actions[actionIndex];
        const priorAction = actionsApplied[actionsApplied.length - 1];
        const requiresCausalInputDrain =
          pendingActionBeforeRead?.action === "input" &&
          priorAction?.action === "checkpoint-process-topology" &&
          actionInputOffset === 0 &&
          drainedInputActionIndex !== actionIndex;
        const waitingForPriorInputOutput =
          pendingActionBeforeRead?.action === "input" &&
          priorAction?.action === "input" &&
          outputBytes === lastCompletedInputOutputBytes;
        const waitingForPriorInputSemanticRedraw =
          pendingActionBeforeRead?.action === "input" &&
          priorAction?.action === "input" &&
          request.readiness.kind === "challenge-styled-text" &&
          safeReflectApply(
            emulatorReadinessObservationGeneration,
            terminal,
            [],
          ) <= lastCompletedInputReadinessGeneration;
        const requiresLiveReadiness =
          request.readiness.kind === "challenge-styled-text" &&
          inputOffset >= 65;
        const requiresTerminalProtocol =
          request.readiness.kind === "challenge-styled-text" &&
          request.readiness.requiredTerminalProtocol ===
            "csi-u-flags-7-query-v1" &&
          inputOffset >= 65 &&
          semanticCompletionObservedAtOutputBytes < 0;
        const shouldReadBeforeAction =
          !allowInput ||
          pendingActionBeforeRead === undefined ||
          (request.interaction.trigger === "semantic-ready" &&
            !readinessObserved) ||
          (requiresLiveReadiness && !readinessObserved) ||
          (requiresTerminalProtocol &&
            !safeReflectApply(
              emulatorRequiredTerminalProtocolReady,
              terminal,
              [],
            )) ||
          pendingActionBeforeRead.action === "wait-for-semantic-completion" ||
          pendingActionBeforeRead.action === "checkpoint-process-topology" ||
          requiresCausalInputDrain ||
          waitingForPriorInputOutput ||
          waitingForPriorInputSemanticRedraw ||
          pendingTerminalResponseOffset < pendingTerminalResponse.length;
        let causalInputDrainObserved = false;
        for (
          let index = 0;
          shouldReadBeforeAction && index < 64 && !outputTerminal;
          index += 1
        ) {
          if (!flushTerminalResponse()) break;
          // Keep one complete semantic marker inside the emulator's bounded
          // recent window, then stop at readiness so its gated action cannot
          // be overtaken by a fast child's later completion output.
          const observation = exactPtyRead(child.read(512));
          if (observation.status === "would-block") {
            causalInputDrainObserved = requiresCausalInputDrain;
            break;
          }
          if (observation.status === "eof" || observation.status === "eio") {
            outputTerminal = true;
            break;
          }
          if (observation.status !== "data")
            return fail("testkit.pty.transport");
          const available = maximum(0, outputLimitBytes - outputBytes);
          const captured = safeBufferFrom(
            observation.bytes.subarray(
              0,
              minimum(available, observation.bytes.length),
            ),
          );
          if (captured.length > 0) {
            const readinessObservedBeforeCaptured = safeReflectApply(
              emulatorReadinessObserved,
              terminal,
              [],
            );
            observeTopologyReadinessMarker(captured);
            const completionWasObserved = safeReflectApply(
              emulatorCompletionObserved,
              terminal,
              [],
            );
            outputBytes += captured.length;
            defineArrayIndex(chunks, chunks.length, captured);
            safeReflectApply(emulatorWrite, terminal, [
              new SafeUint8Array(captured),
            ]);
            collectTerminalResponse();
            if (
              readinessObservedBeforeCaptured &&
              pendingTerminalResponse.length > 0
            )
              terminalProtocolOrderingRejected = true;
            if (!flushTerminalResponse()) break;
            const semanticState = safeReflectApply(
              emulatorSnapshot,
              terminal,
              [],
            ).semanticState;
            if (request.readiness.kind !== "challenge-process-topology")
              readinessObserved = safeReflectApply(
                emulatorReadinessObserved,
                terminal,
                [],
              );
            if (
              !completionWasObserved &&
              safeReflectApply(emulatorCompletionObserved, terminal, [])
            )
              semanticCompletionObservedAtOutputBytes = outputBytes;
            if (
              semanticState === "credential-prompt" ||
              semanticState === "malformed-control"
            )
              transportError = true;
            else if (readinessObserved && !requiresCausalInputDrain) break;
          }
          if (observation.bytes.length > captured.length) {
            outputLimited = true;
            try {
              safeReflectApply(emulatorWrite, terminal, [
                new SafeUint8Array(
                  observation.bytes.subarray(
                    captured.length,
                    captured.length + 1,
                  ),
                ),
              ]);
            } catch {
              // The canonical emulator records the output-limit state first.
            }
            break;
          }
        }
        if (causalInputDrainObserved) drainedInputActionIndex = actionIndex;
        const inputAdmitted =
          allowInput &&
          (request.interaction.trigger === "immediate" || readinessObserved) &&
          (!requiresLiveReadiness || readinessObserved) &&
          (!requiresTerminalProtocol ||
            safeReflectApply(
              emulatorRequiredTerminalProtocolReady,
              terminal,
              [],
            )) &&
          !terminalProtocolOrderingRejected &&
          pendingTerminalResponseOffset >= pendingTerminalResponse.length &&
          !requiresCausalInputDrain &&
          (!waitingForPriorInputOutput ||
            outputBytes > lastCompletedInputOutputBytes) &&
          (!waitingForPriorInputSemanticRedraw ||
            safeReflectApply(
              emulatorReadinessObservationGeneration,
              terminal,
              [],
            ) > lastCompletedInputReadinessGeneration);
        const adjacentNow = safeReflectApply(performanceNow, performance, []);
        if (
          inputAdmitted &&
          primaryFailure === undefined &&
          !aborted &&
          adjacentNow < processRequest.monotonicExecutionDeadlineMs
        ) {
          const action = request.interaction.actions[actionIndex];
          if (action?.action === "resize") {
            child.resize(action.geometry.columns, action.geometry.rows);
            terminalObservation = exactPtyObservation(
              child.inspect(),
              action.geometry,
              requestRequiresCanonicalEof,
            );
            safeReflectApply(emulatorResize, terminal, [action.geometry]);
            readinessObserved = safeReflectApply(
              emulatorReadinessObserved,
              terminal,
              [],
            );
            recordAction({
              action: "resize",
              geometry: action.geometry,
              monotonicAtMs: safeReflectApply(performanceNow, performance, []),
            });
            actionIndex += 1;
          } else if (action?.action === "input") {
            const remainingActionBytes = action.byteLength - actionInputOffset;
            const pending = input.subarray(
              inputOffset,
              inputOffset + remainingActionBytes,
            );
            const written = exactPtyWrite(child.write(pending), pending.length);
            inputOffset += written.bytesWritten;
            actionInputOffset += written.bytesWritten;
            if (actionInputOffset === action.byteLength) {
              const start = inputOffset - action.byteLength;
              recordAction({
                action: "input",
                byteLength: action.byteLength,
                inputSha256: createHash("sha256")
                  .update(input.subarray(start, inputOffset))
                  .digest("hex"),
                monotonicAtMs: safeReflectApply(
                  performanceNow,
                  performance,
                  [],
                ),
              });
              lastCompletedInputOutputBytes = outputBytes;
              lastCompletedInputReadinessGeneration = safeReflectApply(
                emulatorReadinessObservationGeneration,
                terminal,
                [],
              );
              actionInputOffset = 0;
              actionIndex += 1;
            }
          } else if (action?.action === "checkpoint-process-topology") {
            if (
              (request.readiness.kind === "challenge-process-topology" &&
                !topologyReadinessMarkerObserved) ||
              (request.readiness.kind !== "challenge-process-topology" &&
                !readinessObserved)
            )
              return;
            if (root === undefined)
              return fail("testkit.headless.observer.root");
            runtime.assertNamespaceIdentity(composition.namespaceIdentity);
            const processSet = runtime.freezeProcessSet(
              composition.namespaceIdentity,
              processRequest.monotonicExecutionDeadlineMs,
            );
            const rootMatches = processSet.filter(
              (candidate) =>
                candidate.pid === root.pid &&
                candidate.startIdentity === root.startIdentity &&
                candidate.state !== "Z",
            );
            const liveContainedProcesses = processSet.filter(
              (candidate) =>
                candidate.pid !== root.pid && candidate.state !== "Z",
            );
            const topologyMatches =
              rootMatches.length === 1 &&
              liveContainedProcesses.length >= 1 &&
              new Set(processSet.map(({ startIdentity }) => startIdentity))
                .size === processSet.length;
            if (
              safeReflectApply(performanceNow, performance, []) >=
              processRequest.monotonicExecutionDeadlineMs
            )
              return fail("testkit.headless.execution.deadline");
            if (!topologyMatches) {
              runtime.releaseFrozenProcessSet(
                composition.namespaceIdentity,
                processSet,
                root.pid,
                false,
              );
              return;
            }
            runtime.releaseFrozenProcessSet(
              composition.namespaceIdentity,
              processSet,
              root.pid,
              true,
            );
            recordAction({
              action: "checkpoint-process-topology",
              topology: action.topology,
              monotonicAtMs: safeReflectApply(performanceNow, performance, []),
            });
            if (request.readiness.kind === "challenge-process-topology")
              readinessObserved = true;
            actionIndex += 1;
          } else if (action?.action === "eof") {
            eofAttempted = true;
            const eof = child.eof();
            if (
              !plainRecord(eof) ||
              safeReflectApply(objectKeys, Object, [eof]).sort().join("\0") !==
                "bytesWritten\0canonical\0eofByte\0status" ||
              eof.status !== "eof-byte-written" ||
              eof.canonical !== true ||
              eof.bytesWritten !== 1 ||
              eof.eofByte !== terminalObservation.eofByte
            )
              return fail("testkit.pty.transport");
            eofByteWritten = true;
            recordAction({
              action: "eof",
              monotonicAtMs: safeReflectApply(performanceNow, performance, []),
            });
            actionIndex += 1;
          } else if (action?.action === "wait-for-semantic-completion") {
            if (
              readinessObserved &&
              safeReflectApply(emulatorSnapshot, terminal, []).semanticState ===
                "completed" &&
              semanticCompletionObservedAtOutputBytes >
                lastCompletedInputOutputBytes
            ) {
              recordAction({
                action: "wait-for-semantic-completion",
                monotonicAtMs: safeReflectApply(
                  performanceNow,
                  performance,
                  [],
                ),
              });
              actionIndex += 1;
            }
          } else if (action?.action === "interrupt-byte") {
            const interrupt = safeBufferFrom([action.byte]);
            const written = exactPtyWrite(
              child.write(interrupt),
              interrupt.length,
            );
            if (written.bytesWritten !== 1)
              return fail("testkit.pty.transport");
            recordAction({
              action: "interrupt-byte",
              byte: 3,
              monotonicAtMs: safeReflectApply(performanceNow, performance, []),
            });
            actionIndex += 1;
          } else if (action?.action === "signal") {
            if (root === undefined)
              return fail("testkit.headless.observer.root");
            runtime.assertNamespaceIdentity(composition.namespaceIdentity);
            const current = runtime.readProcess(root.pid);
            if (
              current === undefined ||
              current.startIdentity !== root.startIdentity
            )
              return fail("testkit.headless.observer.identity");
            runtime.sendSignal(root.pid, action.signal);
            recordAction({
              action: "signal",
              monotonicAtMs: safeReflectApply(performanceNow, performance, []),
              signal: action.signal,
              targetStartIdentity: root.startIdentity,
            });
            actionIndex += 1;
          }
        }
      } catch {
        transportError = true;
      }
    };
    void safeReflectApply(promiseThen, whenAborted, [
      () => {
        aborted = true;
      },
    ]);
    let exit: PtyExit | undefined;
    let trigger: "closed" | "failure" | "timeout" | "aborted" | undefined =
      primaryFailure === undefined ? undefined : "failure";
    while (trigger === undefined) {
      for (const process_ of currentProcessSet())
        observed.set(process_.startIdentity, process_);
      if (authorityFailure !== undefined) trigger = "failure";
      else if (aborted) trigger = "aborted";
      else if (
        safeReflectApply(performanceNow, performance, []) >=
        processRequest.monotonicExecutionDeadlineMs
      )
        trigger = "timeout";
      if (trigger === undefined)
        for (let step = 0; step < 64; step += 1) {
          const beforeAction = actionIndex;
          const beforeInput = inputOffset;
          pumpTransport(true);
          if (
            transportError ||
            outputLimited ||
            safeReflectApply(performanceNow, performance, []) >=
              processRequest.monotonicExecutionDeadlineMs ||
            (beforeAction === actionIndex && beforeInput === inputOffset)
          )
            break;
        }
      if (transportError || outputLimited) trigger = "failure";
      else if (
        safeReflectApply(performanceNow, performance, []) >=
        processRequest.monotonicExecutionDeadlineMs
      )
        trigger = "timeout";
      if (trigger !== undefined) break;
      const closed = await SafePromise.race([
        terminalOf(child.closed),
        delay(containerPollMilliseconds).then(() => undefined),
      ]);
      if (closed !== undefined) {
        if (!closed.ok) {
          primaryFailure ??= "testkit.headless.kernel.spawn";
          trigger = "failure";
        } else
          try {
            exit = exactPtyExit(closed.value);
            trigger = "closed";
          } catch (error) {
            primaryFailure ??=
              trustedErrorCode(error) ?? "testkit.pty.transport";
            exit = { code: 0, signal: 15 };
            trigger = "failure";
          }
      } else if (aborted) trigger = "aborted";
      else if (
        safeReflectApply(performanceNow, performance, []) >=
        processRequest.monotonicExecutionDeadlineMs
      )
        trigger = "timeout";
    }
    const termTargets = processesDescendantsFirst(
      currentProcessSet().filter((identity) => {
        try {
          return runtime.readProcess(identity.pid) !== undefined;
        } catch (error) {
          authorityFailure =
            trustedErrorCode(error) ?? "testkit.headless.observer.read";
          return false;
        }
      }),
      child.pid,
    );
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    if (
      trigger !== "closed" ||
      safeReflectApply(arraySome, termTargets, [({ pid }) => pid !== child.pid])
    )
      for (const identity of termTargets)
        try {
          signalExactProcess(
            identity,
            "SIGTERM",
            signals,
            composition.namespaceIdentity,
            runtime,
          );
        } catch (error) {
          authorityFailure =
            trustedErrorCode(error) ?? "testkit.headless.observer.signal";
          break;
        }
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    const graceDeadline = minimum(
      processRequest.monotonicShutdownDeadlineMs -
        containerPollMilliseconds * 2,
      safeReflectApply(performanceNow, performance, []) +
        processRequest.terminationGraceMs,
    );
    while (
      safeReflectApply(performanceNow, performance, []) < graceDeadline &&
      currentProcessSet().length > 0
    ) {
      try {
        reapAdoptedZombies(
          currentProcessSet(),
          child.pid,
          nativeShutdownDeadlineNs,
          composition.namespaceIdentity,
          runtime,
        );
      } catch (error) {
        authorityFailure =
          trustedErrorCode(error) ?? "testkit.headless.observer.reap";
        break;
      }
      pumpTransport(false);
      await delay(containerPollMilliseconds);
    }
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    for (const identity of processesDescendantsFirst(
      currentProcessSet(),
      child.pid,
    ))
      try {
        if (identity.state === "Z") continue;
        signalExactProcess(
          identity,
          "SIGKILL",
          signals,
          composition.namespaceIdentity,
          runtime,
        );
      } catch (error) {
        authorityFailure =
          trustedErrorCode(error) ?? "testkit.headless.observer.signal";
        break;
      }
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    while (
      safeReflectApply(performanceNow, performance, []) <
        processRequest.monotonicShutdownDeadlineMs -
          containerPollMilliseconds * 2 &&
      currentProcessSet().length > 0
    ) {
      try {
        reapAdoptedZombies(
          currentProcessSet(),
          child.pid,
          nativeShutdownDeadlineNs,
          composition.namespaceIdentity,
          runtime,
        );
      } catch (error) {
        authorityFailure =
          trustedErrorCode(error) ?? "testkit.headless.observer.reap";
        break;
      }
      pumpTransport(false);
      await delay(containerPollMilliseconds);
    }
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    try {
      reapAdoptedZombies(
        currentProcessSet(),
        child.pid,
        nativeShutdownDeadlineNs,
        composition.namespaceIdentity,
        runtime,
      );
    } catch (error) {
      authorityFailure =
        trustedErrorCode(error) ?? "testkit.headless.observer.reap";
    }
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    const residual = currentProcessSet();
    if (authorityFailure !== undefined) return failAfterHandleSettlement();
    if (residual.length > 0) {
      try {
        child.close();
      } catch {
        // The terminal classification remains reconciliation uncertainty.
      }
      return fail("testkit.headless.reconciliation.deadline");
    }
    if (exit === undefined)
      exit = exactPtyExit(
        await boundedInvoke(
          () => child.closed,
          processRequest.monotonicShutdownDeadlineMs,
          "testkit.headless.reconciliation.deadline",
        ),
      );
    while (
      !outputTerminal &&
      safeReflectApply(performanceNow, performance, []) <
        processRequest.monotonicShutdownDeadlineMs -
          containerPollMilliseconds * 2
    ) {
      pumpTransport(false);
      if (!outputTerminal) await delay(containerPollMilliseconds);
    }
    try {
      child.close();
      transportClosed = true;
    } catch {
      transportClosed = false;
    }
    if (!outputTerminal || !transportClosed)
      return fail("testkit.headless.reconciliation.deadline");
    if (primaryFailure !== undefined) return fail(primaryFailure);
    if (
      exit.signal !== 0 &&
      exit.signal !== 2 &&
      exit.signal !== 9 &&
      exit.signal !== 15
    )
      return fail("testkit.pty.transport.exit");
    const inputJoined =
      actionIndex === request.interaction.actions.length &&
      inputOffset === input.length &&
      pendingTerminalResponseOffset >= pendingTerminalResponse.length &&
      (!eofAttempted || eofByteWritten);
    const clean = residual.length === 0 && outputTerminal && transportClosed;
    const output = safeBufferConcat(chunks, outputBytes);
    const outputSha256 = createHash("sha256").update(output).digest("hex");
    const finalSnapshot = safeReflectApply(emulatorEnd, terminal, []);
    const exactOutputCompleted =
      request.completion.kind === "exact-output" &&
      request.completion.outputBytes === outputBytes &&
      request.completion.outputSha256 === outputSha256;
    if (!outputLimited) {
      if (finalSnapshot.semanticState === "credential-prompt")
        return fail("testkit.pty.transport.semantic-credential-prompt");
      if (finalSnapshot.semanticState === "malformed-control")
        return fail(
          finalSnapshot.malformedControlCount > 0
            ? `testkit.pty.transport.semantic-malformed-${safeReflectApply(emulatorMalformedControlReason, terminal, []) ?? "unknown"}`
            : `testkit.pty.transport.semantic-unsupported-${safeReflectApply(emulatorUnsupportedControlReason, terminal, []) ?? "unknown"}`,
        );
      if (
        request.interaction.trigger === "semantic-ready" &&
        !readinessObserved
      )
        return fail("testkit.pty.transport.semantic-missing-readiness");
      if (
        (trigger === "closed" || trigger === undefined) &&
        finalSnapshot.semanticState !== "completed" &&
        !exactOutputCompleted
      )
        return fail(
          exit.code === 0
            ? "testkit.pty.transport.semantic-incomplete"
            : "testkit.pty.transport.semantic-nonzero",
        );
    }
    const outcome =
      trigger === "aborted"
        ? "aborted"
        : trigger === "timeout"
          ? "timeout"
          : outputLimited
            ? "output-limit"
            : transportError
              ? "transport-failed"
              : !inputJoined
                ? "input-incomplete"
                : exit.signal !== 0
                  ? "signaled"
                  : exit.code === 0
                    ? "completed"
                    : "exited-nonzero";
    const receipt: SelectedPtyExecutionReceipt = safeReflectApply(
      freeze,
      Object,
      [
        {
          receiptVersion: 1,
          runId: processRequest.runId,
          requestFingerprint: ptyAuthority.fingerprint,
          processRequestFingerprint: processRequest.requestFingerprint,
          inputBytes: ptyAuthority.inputBytes,
          inputSha256: ptyAuthority.inputSha256,
          readinessObserved,
          actions: safeReflectApply(freeze, Object, [actionsApplied]),
          processStartIdentity: root?.startIdentity ?? "",
          isTTY: true,
          initialGeometry: request.initialGeometry,
          observedGeometry: {
            columns: terminalObservation.columns,
            rows: terminalObservation.rows,
          },
          observedCanonicalMode: terminalObservation.canonical,
          eofByte: terminalObservation.eofByte,
          eofByteWritten,
          inputBytesWritten: inputOffset,
          outcome,
          outputBytes,
          outputSha256,
          finalSnapshot,
          exitCode:
            outcome === "completed" || outcome === "exited-nonzero"
              ? exit.code
              : null,
          signal: ptySignal(exit.signal),
          cleanup: clean
            ? "clean"
            : residual.length > 0
              ? "residual"
              : "uncertain",
          residualProcessCount: residual.length,
          processJoined: residual.length === 0,
          terminalInputJoined: inputJoined,
          terminalOutputJoined: outputTerminal,
          terminalTransportClosed: transportClosed,
        },
      ],
    ) as SelectedPtyExecutionReceipt;
    resolveExpiry(receipt);
    return receipt;
  };
  return observeAtCreation(
    new SafePromise((resolve_) => {
      resolve_({ expiryReceipt, launch });
    }),
  );
};

const selectedContainerBackend = (
  composition: ContainerComposition,
  runtime: SelectedContainerRuntime = composition.immutableCandidate ===
  undefined
    ? fail("testkit.pty.immutable-candidate")
    : productionContainerRuntime(composition.immutableCandidate),
  // The backend closes one lifecycle across launch, streams, signals and join.
  // eslint-disable-next-line max-lines-per-function
): SelectedIsolationBackendAuthority => ({
  kind: "selected-isolation-backend",
  armPty: (request, whenAborted) =>
    composition.immutableCandidate === undefined
      ? fail("testkit.pty.immutable-candidate")
      : armSelectedPty(
          composition,
          productionPtyRuntime(composition.immutableCandidate),
          request,
          whenAborted,
        ),
  // eslint-disable-next-line max-lines-per-function
  arm: async (request, whenAborted) => {
    if (
      request.monotonicShutdownDeadlineMs >
        composition.maximumShutdownDeadlineMs ||
      safeReflectApply(performanceNow, performance, []) >=
        request.monotonicStartupDeadlineMs
    )
      return fail("testkit.headless.startup.deadline");
    let resolveExpiry!: (receipt: BackendTerminalReceipt) => void;
    const expiryReceipt = observeAtCreation(
      new SafePromise<BackendTerminalReceipt>((resolve) => {
        resolveExpiry = resolve;
      }),
    );
    let launched = false;
    // eslint-disable-next-line complexity,max-lines-per-function
    const launch = async (): Promise<BackendTerminalReceipt> => {
      if (launched) return fail("testkit.headless.backend.replay");
      launched = true;
      composition.immutableCandidate?.assertRuntime();
      runtime.assertNamespaceIdentity(composition.namespaceIdentity);
      if (
        safeReflectApply(performanceNow, performance, []) >=
        request.monotonicStartupDeadlineMs
      )
        return fail("testkit.headless.startup.deadline");
      const nativeShutdownDeadlineNs = captureNativeMonotonicDeadline(
        request.monotonicShutdownDeadlineMs,
      );
      const spawnedAtMs = safeReflectApply(performanceNow, performance, []);
      const child = runtime.spawnProcess(request);
      // Observe spawn failure before reading pid so a no-exec child cannot emit
      // an unhandled error after this launch path has already failed closed.
      const closed = processClose(child);
      const childPid = child.pid;
      if (
        typeof childPid !== "number" ||
        !numberIsSafeInteger(childPid) ||
        childPid < 2
      )
        return fail("testkit.headless.kernel.spawn");
      const { stdin, stdout: stdoutStream, stderr: stderrStream } = child;
      if (stdin === null || stdoutStream === null || stderrStream === null)
        return fail("testkit.headless.kernel.spawn");
      let overflow: "stdout" | "stderr" | undefined;
      const stdout = captureStream(
        stdoutStream,
        request.stdoutLimitBytes,
        () => {
          overflow ??= "stdout";
        },
      );
      const stderr = captureStream(
        stderrStream,
        request.stderrLimitBytes,
        () => {
          overflow ??= "stderr";
        },
      );
      const readyAtMs = safeReflectApply(performanceNow, performance, []);
      const root = runtime.readProcess(childPid);
      if (root === undefined) return fail("testkit.headless.observer.root");
      const observed = new Map<string, ProcessSnapshot>([
        [root.startIdentity, root],
      ]);
      const signals: HeadlessObservedSignal[] = [];
      let aborted = false;
      void safeReflectApply(promiseThen, whenAborted, [
        () => {
          aborted = true;
        },
      ]);
      let stdinJoined = false;
      stdin.once("error", () => undefined);
      stdin.end(request.stdin, () => {
        stdinJoined = true;
      });
      let exit:
        | Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
        | undefined;
      let trigger: "closed" | "output" | "timeout" | "aborted" | undefined;
      while (trigger === undefined) {
        for (const process_ of runtime.listProcesses(
          composition.namespaceIdentity,
        ))
          observed.set(process_.startIdentity, process_);
        const terminal = await Promise.race([
          terminalOf(closed),
          delay(containerPollMilliseconds).then(() => undefined),
        ]);
        if (terminal !== undefined) {
          if (!terminal.ok) return fail("testkit.headless.kernel.spawn");
          exit = terminal.value;
          trigger = "closed";
        } else if (overflow !== undefined) trigger = "output";
        else if (aborted) trigger = "aborted";
        else if (
          safeReflectApply(performanceNow, performance, []) >=
          request.monotonicExecutionDeadlineMs
        )
          trigger = "timeout";
      }
      const termTargets = processesDescendantsFirst(
        runtime
          .listProcesses(composition.namespaceIdentity)
          .filter((identity) => {
            observed.set(identity.startIdentity, identity);
            return runtime.readProcess(identity.pid) !== undefined;
          }),
        childPid,
      );
      if (
        trigger !== "closed" ||
        safeReflectApply(arraySome, termTargets, [
          ({ pid }) => pid !== childPid,
        ])
      )
        for (const identity of termTargets)
          signalExactProcess(
            identity,
            "SIGTERM",
            signals,
            composition.namespaceIdentity,
            runtime,
          );
      const graceDeadline = minimum(
        request.monotonicShutdownDeadlineMs,
        safeReflectApply(performanceNow, performance, []) +
          request.terminationGraceMs,
      );
      while (
        safeReflectApply(performanceNow, performance, []) < graceDeadline &&
        runtime.listProcesses(composition.namespaceIdentity).length > 0
      ) {
        reapAdoptedZombies(
          runtime.listProcesses(composition.namespaceIdentity),
          childPid,
          nativeShutdownDeadlineNs,
          composition.namespaceIdentity,
          runtime,
        );
        await delay(containerPollMilliseconds);
      }
      for (const identity of processesDescendantsFirst(
        runtime.listProcesses(composition.namespaceIdentity),
        childPid,
      )) {
        observed.set(identity.startIdentity, identity);
        if (identity.state === "Z") continue;
        signalExactProcess(
          identity,
          "SIGKILL",
          signals,
          composition.namespaceIdentity,
          runtime,
        );
      }
      while (
        safeReflectApply(performanceNow, performance, []) <
          request.monotonicShutdownDeadlineMs &&
        runtime.listProcesses(composition.namespaceIdentity).length > 0
      ) {
        reapAdoptedZombies(
          runtime.listProcesses(composition.namespaceIdentity),
          childPid,
          nativeShutdownDeadlineNs,
          composition.namespaceIdentity,
          runtime,
        );
        await delay(containerPollMilliseconds);
      }
      reapAdoptedZombies(
        runtime.listProcesses(composition.namespaceIdentity),
        childPid,
        nativeShutdownDeadlineNs,
        composition.namespaceIdentity,
        runtime,
      );
      const residual = runtime.listProcesses(composition.namespaceIdentity);
      if (exit === undefined) {
        const terminal = await boundedInvoke(
          () => closed,
          request.monotonicShutdownDeadlineMs,
          "testkit.headless.reconciliation.deadline",
        );
        exit = terminal;
      }
      await boundedInvoke(
        () =>
          SafePromise.all([stdout.close, stderr.close]).then(() => undefined),
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.reconciliation.deadline",
      );
      const settledAtMs = safeReflectApply(performanceNow, performance, []);
      const capturedStdout = stdout.read();
      const capturedStderr = stderr.read();
      const terminalSignalIsRepresentable =
        exit.signal === null ||
        exit.signal === "SIGTERM" ||
        exit.signal === "SIGKILL";
      const clean =
        residual.length === 0 && stdinJoined && terminalSignalIsRepresentable;
      const outputLimited = overflow !== undefined;
      const timedOut = trigger === "timeout";
      const trace: HeadlessExecutionTrace = {
        traceVersion: 1,
        runId: request.runId,
        requestFingerprint: request.requestFingerprint,
        returnedAtMs: settledAtMs,
        result: {
          resultVersion: 1,
          outcome: !clean
            ? "cleanup-failed"
            : outputLimited
              ? "output-limit"
              : timedOut
                ? "timed-out"
                : "exited",
          exitCode: outputLimited || timedOut ? null : exit.code,
          signal: outputLimited
            ? "SIGTERM"
            : timedOut
              ? (exit.signal as "SIGTERM" | "SIGKILL" | null)
              : (exit.signal as "SIGTERM" | "SIGKILL" | null),
          stdout: capturedStdout.bytes,
          stderr: capturedStderr.bytes,
          stdoutTruncated: capturedStdout.truncated,
          stderrTruncated: capturedStderr.truncated,
          termRequested: safeReflectApply(arraySome, signals, [
            ({ signal }) => signal === "SIGTERM",
          ]),
          killRequested: safeReflectApply(arraySome, signals, [
            ({ signal }) => signal === "SIGKILL",
          ]),
          cleanup: clean
            ? "clean"
            : residual.length > 0
              ? "residual"
              : "uncertain",
          residualProcessCount: residual.length,
          diagnosticCode: !clean
            ? "testkit.headless.cleanup"
            : outputLimited
              ? "testkit.headless.output-limit"
              : timedOut
                ? "testkit.headless.timeout"
                : null,
        },
        observation: {
          observationVersion: 1,
          runId: request.runId,
          requestFingerprint: request.requestFingerprint,
          processes: [...observed.values()].map((identity, index) => ({
            pid: identity.pid,
            startIdentity: identity.startIdentity,
            role: index === 0 ? "root" : "descendant",
          })),
          signals,
          spawnedAtMs,
          readyAtMs,
          settledAtMs,
          processJoined: residual.length === 0,
          stdinJoined,
          stdoutJoined: true,
          stderrJoined: true,
          cleanup: clean
            ? "clean"
            : residual.length > 0
              ? "residual"
              : "uncertain",
          residualStartIdentities: residual.map(
            ({ startIdentity }) => startIdentity,
          ),
        },
      };
      const receipt: BackendTerminalReceipt = {
        cleanup: clean ? "clean" : "uncertain",
        monotonicShutdownDeadlineMs: request.monotonicShutdownDeadlineMs,
        requestFingerprint: request.requestFingerprint,
        runId: request.runId,
        trace,
      };
      resolveExpiry(receipt);
      return receipt;
    };
    return { expiryReceipt, launch };
  },
});

/**
 * Package-private production composition. It is one-shot and succeeds only in
 * the selected Linux scenario PID namespace where the trusted runner is PID 1.
 */
export const composeSelectedContainerHeadlessSupervisorCapability = (
  maximumShutdownDeadlineMs: number,
  immutableCandidate?: ImmutableCandidateAuthority,
): HeadlessSupervisorCapability => {
  if (
    selectedContainerCompositionConsumed ||
    process.platform !== "linux" ||
    process.pid !== 1 ||
    !finiteNumber(maximumShutdownDeadlineMs) ||
    maximumShutdownDeadlineMs <=
      safeReflectApply(performanceNow, performance, []) ||
    typeof immutableCandidate !== "object" ||
    immutableCandidate === null ||
    !immutableCandidateAuthorities.has(immutableCandidate) ||
    typeof immutableCandidate.assertRuntime !== "function" ||
    readlinkSync("/proc/self/ns/pid") !== readlinkSync("/proc/1/ns/pid")
  )
    return fail("testkit.headless.capability");
  immutableCandidate.assertRuntime();
  selectedContainerCompositionConsumed = true;
  const capability = safeReflectApply(freeze, Object, [{}]) as object;
  writeWeakMap(
    selectedBackendAuthorities,
    capability,
    selectedContainerBackend({
      immutableCandidate,
      maximumShutdownDeadlineMs,
      namespaceIdentity: readlinkSync("/proc/self/ns/pid"),
    }),
  );
  return capability as HeadlessSupervisorCapability;
};
/** Package-private one-shot input hardening; the returned authority is not serializable. */
export const createSelectedContainerImmutableCandidateAuthority = (
  record: unknown,
): ImmutableCandidateAuthority => createImmutableCandidateAuthority(record);
/** Package-private causal parser oracle; it conveys no execution authority. */
export const validateSelectedContainerPrincipalFactsForTest = (
  facts: Parameters<typeof validatePrincipalFacts>[0],
): true => {
  validatePrincipalFacts(facts);
  return true;
};
/** Package-private causal filesystem parser oracle; it conveys no authority. */
export const validateSelectedContainerFilesystemFactsForTest = (facts: {
  after?: { dev: number; ino: number; size: number };
  before?: { dev: number; ino: number; size: number };
  digest?: string;
  expectedDigest?: string;
  expectedPath?: string;
  fdinfo?: string;
  isFile?: boolean;
  linkPath?: string;
  mountinfo?: string;
}): true => {
  const before = facts.before ?? { dev: 1, ino: 2, size: 3 };
  validateImmutableFileFacts({
    after: facts.after ?? before,
    before,
    digest: facts.digest ?? "a".repeat(64),
    expectedDigest: facts.expectedDigest ?? "a".repeat(64),
    expectedPath: facts.expectedPath ?? "/selected/file",
    isFile: facts.isFile ?? true,
    linkPath: facts.linkPath ?? "/selected/file",
    mountId: parseImmutableFdMountId(facts.fdinfo ?? "mnt_id:\t7\n"),
    mountTable: parseImmutableMountTable(
      facts.mountinfo ?? "7 1 0:1 / /selected ro - overlay overlay ro\n",
    ),
  });
  return true;
};
export const executeSelectedHeadlessProcessWithCapability = async (
  capability: HeadlessSupervisorCapability,
  request: HeadlessExecutionRequest,
  options: HeadlessSupervisorExecutionOptions,
): Promise<HeadlessExecutionTrace> => {
  const backend =
    typeof capability === "object" && capability !== null
      ? readWeakMap(selectedBackendAuthorities, capability)
      : undefined;
  if (backend === undefined) return fail("testkit.headless.capability");
  const stableRequest = snapshotSelectedRequest(request);
  const abortSignal = readOptionsSignal(options);
  const cancellation = cancellationAuthority(abortSignal);
  try {
    if (cancellation.abortedAtCreation) return fail("testkit.headless.aborted");
    const armed = await boundedInvoke(
      () => backend.arm(stableRequest, cancellation.whenAborted),
      stableRequest.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    const readExpiryReceipt = terminalSnapshot(armed.expiryReceipt);
    let receipt: BackendTerminalReceipt;
    try {
      receipt = await boundedInvoke(
        armed.launch,
        stableRequest.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
    } catch (error: unknown) {
      if (
        trustedErrorCode(error) === "testkit.headless.shutdown.deadline" ||
        remaining(stableRequest.monotonicShutdownDeadlineMs) <= 0
      ) {
        const expiry = readExpiryReceipt();
        if (expiry?.ok === true && expiry.value.cleanup === "clean")
          assertReceiptBinding(expiry.value, stableRequest);
        return fail("testkit.headless.reconciliation.deadline");
      }
      return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
    }
    assertReceiptBinding(receipt, stableRequest);
    return receipt.trace;
  } finally {
    cancellation.close();
  }
};

const ptyTerminalControlActionMatches = (
  expected: SelectedPtyExecutionAction,
  observed: PtyTransportAction,
): boolean => {
  if (
    expected.action === "interrupt-byte" &&
    observed.action === "interrupt-byte"
  )
    return expected.byte === observed.byte;
  if (
    expected.action === "wait-for-semantic-completion" &&
    observed.action === "wait-for-semantic-completion"
  )
    return true;
  if (
    expected.action === "checkpoint-process-topology" &&
    observed.action === "checkpoint-process-topology"
  )
    return expected.topology === observed.topology;
  if (expected.action === "signal" && observed.action === "signal")
    return (
      expected.signal === observed.signal &&
      /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(observed.targetStartIdentity)
    );
  return true;
};

const ptyReceiptActionsMatch = (
  receipt: SelectedPtyExecutionReceipt,
  request: SelectedPtyExecutionRequest,
): boolean => {
  const receiptActions: readonly PtyTransportAction[] = receipt.actions;
  const receiptActionsAreArray: boolean = safeReflectApply(
    arrayIsArray,
    Array,
    [receiptActions],
  );
  if (
    !receiptActionsAreArray ||
    receiptActions.length > request.interaction.actions.length
  )
    return false;
  const input = safeBufferFrom(request.process.stdin);
  let inputOffset = 0;
  let previousAt = 0;
  for (let index = 0; index < receiptActions.length; index += 1) {
    const expected = request.interaction.actions[index];
    const observed: PtyTransportAction | undefined = receiptActions[index];
    if (
      expected === undefined ||
      observed === undefined ||
      expected.action !== observed.action ||
      observed.monotonicAtMs < previousAt ||
      observed.monotonicAtMs > request.process.monotonicExecutionDeadlineMs
    )
      return false;
    previousAt = observed.monotonicAtMs;
    if (expected.action === "resize" && observed.action === "resize") {
      if (
        expected.geometry.columns !== observed.geometry.columns ||
        expected.geometry.rows !== observed.geometry.rows
      )
        return false;
    } else if (expected.action === "input" && observed.action === "input") {
      const bytes = input.subarray(
        inputOffset,
        inputOffset + expected.byteLength,
      );
      if (
        expected.byteLength !== observed.byteLength ||
        expected.inputSha256 !== observed.inputSha256 ||
        createHash("sha256").update(bytes).digest("hex") !==
          observed.inputSha256
      )
        return false;
      inputOffset += expected.byteLength;
    } else if (
      expected.action === "checkpoint-process-topology" &&
      observed.action === "checkpoint-process-topology"
    ) {
      if (expected.topology !== observed.topology) return false;
    } else if (!ptyTerminalControlActionMatches(expected, observed))
      return false;
  }
  return true;
};

const finalRequestedPtyGeometry = (
  request: SelectedPtyExecutionRequest,
): PtyTerminalGeometry =>
  request.interaction.actions.reduce(
    (geometry, action) =>
      action.action === "resize" ? action.geometry : geometry,
    request.initialGeometry,
  );

const assertPtyReceiptBinding = (
  receipt: SelectedPtyExecutionReceipt,
  request: SelectedPtyExecutionRequest,
  // eslint-disable-next-line complexity,max-lines-per-function
): void => {
  const outcome = receipt.outcome;
  const authority = selectedPtyRequestFingerprint(request);
  const requestRequiresEof = request.interaction.actions.some(
    (action) => action.action === "eof",
  );
  const expectedGeometry = finalRequestedPtyGeometry(request);
  const terminalActionOutcome =
    outcome === "completed" ||
    outcome === "signaled" ||
    outcome === "exited-nonzero";
  if (
    receipt.receiptVersion !== 1 ||
    receipt.runId !== request.process.runId ||
    receipt.requestFingerprint !== authority.fingerprint ||
    receipt.processRequestFingerprint !== request.process.requestFingerprint ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/u.test(
      receipt.processStartIdentity,
    ) ||
    receipt.inputBytes !== authority.inputBytes ||
    receipt.inputSha256 !== authority.inputSha256
  )
    return fail("testkit.pty.receipt-identity");
  if (
    typeof receipt.readinessObserved !== "boolean" ||
    (outcome === "completed" &&
      request.interaction.trigger === "semantic-ready" &&
      !receipt.readinessObserved)
  )
    return fail("testkit.pty.receipt-readiness");
  if (!ptyReceiptActionsMatch(receipt, request))
    return fail("testkit.pty.receipt-actions");
  if (
    receipt.initialGeometry.columns !== request.initialGeometry.columns ||
    receipt.initialGeometry.rows !== request.initialGeometry.rows ||
    receipt.observedGeometry.columns !== expectedGeometry.columns ||
    receipt.observedGeometry.rows !== expectedGeometry.rows ||
    receipt.isTTY !== true ||
    typeof receipt.observedCanonicalMode !== "boolean" ||
    (requestRequiresEof && receipt.observedCanonicalMode !== true) ||
    !boundedNonnegativeInteger(receipt.eofByte, 255)
  )
    return fail("testkit.pty.receipt-terminal");
  if (
    typeof receipt.eofByteWritten !== "boolean" ||
    !boundedNonnegativeInteger(
      receipt.inputBytesWritten,
      request.process.stdin.byteLength,
    )
  )
    return fail("testkit.pty.receipt-input");
  if (
    outcome !== "completed" &&
    outcome !== "signaled" &&
    outcome !== "exited-nonzero" &&
    outcome !== "aborted" &&
    outcome !== "timeout" &&
    outcome !== "output-limit" &&
    outcome !== "transport-failed" &&
    outcome !== "input-incomplete"
  )
    return fail("testkit.pty.receipt-outcome");
  if (
    !boundedNonnegativeInteger(
      receipt.outputBytes,
      minimum(
        request.process.stdoutLimitBytes,
        request.process.stderrLimitBytes,
      ),
    ) ||
    !/^[a-f0-9]{64}$/u.test(receipt.outputSha256)
  )
    return fail("testkit.pty.receipt-output");
  if (
    receipt.cleanup !== "clean" ||
    !receipt.processJoined ||
    !receipt.terminalOutputJoined ||
    !receipt.terminalTransportClosed ||
    receipt.residualProcessCount !== 0
  )
    return fail("testkit.pty.receipt-cleanup");
  if (
    receipt.signal !== null &&
    receipt.signal !== "SIGINT" &&
    receipt.signal !== "SIGTERM" &&
    receipt.signal !== "SIGKILL"
  )
    return fail("testkit.pty.receipt-signal");
  let finalSnapshot;
  try {
    finalSnapshot = validatePtyTerminalSemanticSnapshot(receipt.finalSnapshot);
  } catch {
    return fail("testkit.pty.receipt-snapshot");
  }
  if (
    (outcome === "output-limit") !==
    (finalSnapshot.semanticState === "output-limit")
  )
    return fail("testkit.pty.receipt-output-state");
  if (
    outcome === "completed" &&
    finalSnapshot.semanticState !== "completed" &&
    (request.completion.kind !== "exact-output" ||
      request.completion.outputBytes !== receipt.outputBytes ||
      request.completion.outputSha256 !== receipt.outputSha256)
  )
    return fail("testkit.pty.receipt-completion-state");
  if (
    terminalActionOutcome &&
    (receipt.actions.length !== request.interaction.actions.length ||
      (requestRequiresEof && !receipt.eofByteWritten) ||
      receipt.inputBytesWritten !== request.process.stdin.byteLength ||
      !receipt.terminalInputJoined)
  )
    return fail("testkit.pty.receipt-terminal-action");
  for (let index = 0; index < receipt.actions.length; index += 1) {
    const action = receipt.actions[index];
    if (
      action?.action === "signal" &&
      action.targetStartIdentity !== receipt.processStartIdentity
    )
      return fail("testkit.pty.receipt-signal-identity");
  }
  if (
    (receipt.outcome === "completed" &&
      (receipt.exitCode !== 0 || receipt.signal !== null)) ||
    (receipt.outcome === "signaled" &&
      (receipt.exitCode !== null || receipt.signal === null)) ||
    (receipt.outcome === "exited-nonzero" &&
      (!boundedInteger(receipt.exitCode, 255) || receipt.signal !== null)) ||
    (receipt.outcome !== "completed" &&
      receipt.outcome !== "signaled" &&
      receipt.outcome !== "exited-nonzero" &&
      receipt.exitCode !== null)
  )
    return fail("testkit.pty.receipt-terminal-status");
};

export const executeSelectedPtyProcessWithCapability = async (
  capability: HeadlessSupervisorCapability,
  request: SelectedPtyExecutionRequest,
  options: HeadlessSupervisorExecutionOptions,
): Promise<SelectedPtyExecutionReceipt> => {
  const backend =
    typeof capability === "object" && capability !== null
      ? readWeakMap(selectedBackendAuthorities, capability)
      : undefined;
  if (backend?.armPty === undefined) return fail("testkit.headless.capability");
  const stableRequest = snapshotPtyRequest(request);
  const cancellation = cancellationAuthority(readOptionsSignal(options));
  try {
    if (cancellation.abortedAtCreation) return fail("testkit.headless.aborted");
    const armed = await boundedInvoke(
      () => backend.armPty!(stableRequest, cancellation.whenAborted),
      stableRequest.process.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    const readExpiryReceipt = terminalSnapshot(armed.expiryReceipt);
    let receipt: SelectedPtyExecutionReceipt;
    try {
      receipt = await boundedInvoke(
        armed.launch,
        stableRequest.process.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
    } catch (error: unknown) {
      if (
        trustedErrorCode(error) === "testkit.headless.shutdown.deadline" ||
        remaining(stableRequest.process.monotonicShutdownDeadlineMs) <= 0
      ) {
        const expiry = readExpiryReceipt();
        if (expiry?.ok === true && expiry.value.cleanup === "clean")
          assertPtyReceiptBinding(expiry.value, stableRequest);
        return fail("testkit.headless.reconciliation.deadline");
      }
      return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
    }
    assertPtyReceiptBinding(receipt, stableRequest);
    return receipt;
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
    const stableRequest = snapshotRequest(scenario, request);
    const signal = readOptionsSignal(options);
    return await execute(backend, scenario, stableRequest, signal);
  } catch (error: unknown) {
    return fail(trustedErrorCode(error) ?? "testkit.headless.kernel.failure");
  }
};
/** Package-private scripted protocol evidence; never containment evidence. */
export const executeScriptedHeadlessSupervisorForTest = async (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  seed: ScriptedSeed = "clean",
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<HeadlessCanonicalTraceEnvelope> => {
  scriptedLaunches = 0;
  scriptedCancellationDeliveries = 0;
  try {
    const stableRequest = snapshotRequest(scenario, request);
    const signal = readOptionsSignal(options);
    return await execute(
      scriptedBackend(scenario, seed),
      scenario,
      stableRequest,
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

/** Package-private generic production-path protocol evidence. */
export const executeScriptedSelectedHeadlessProcessForTest = async (
  request: HeadlessExecutionRequest,
  seed: ScriptedSeed = "clean",
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<HeadlessExecutionTrace> => {
  const capability = safeReflectApply(freeze, Object, [{}]) as object;
  const scripted = scriptedBackend("correct", seed);
  writeWeakMap(selectedBackendAuthorities, capability, {
    arm: scripted.arm,
    kind: "selected-isolation-backend",
  });
  return executeSelectedHeadlessProcessWithCapability(
    capability as HeadlessSupervisorCapability,
    request,
    options,
  );
};

type SelectedContainerTestSeed =
  | "adopted-zombie-already-absent"
  | "adopted-zombie-already-absent-persistence"
  | "adopted-zombie-not-ready"
  | "adopted-zombie-reaped-persistence"
  | "adopted-zombie-reap-failure"
  | "adopted-zombie-receipt-malformed"
  | "adopted-zombie-receipt-substitution"
  | "adopted-zombie-state-substitution"
  | "abort"
  | "clean"
  | "descendant"
  | "fast-exit"
  | "identity-substitution"
  | "nested-adopted-zombie"
  | "observer-failure"
  | "output-limit"
  | "signal-failure"
  | "startup-delay"
  | "stream-join-failure"
  | "terminal-join-failure"
  | "timeout"
  | HostileHeadlessProcessSeed;

const selectedContainerRuntimeForTest = (
  seed: SelectedContainerTestSeed,
  // The closed synthetic matrix keeps all runtime transitions in one fixture.
  // eslint-disable-next-line max-lines-per-function
): SelectedContainerRuntime => {
  const root: ProcessSnapshot = {
    parentPid: 1,
    pid: 41_001,
    startIdentity: "41001:1",
    state: "R",
  };
  const descendant: ProcessSnapshot = {
    parentPid: root.pid,
    pid: 41_002,
    startIdentity: "41002:1",
    state: "R",
  };
  const grandchild: ProcessSnapshot = {
    parentPid: descendant.pid,
    pid: 41_003,
    startIdentity: "41003:1",
    state: "R",
  };
  const processes = new Map<number, ProcessSnapshot>([[root.pid, root]]);
  let child: (ChildProcess & EventEmitter) | undefined;
  let fakeStdout: PassThrough | undefined;
  let fakeStderr: PassThrough | undefined;
  let closed = false;
  let rootReads = 0;
  let descendantReads = 0;
  let reapDeadline: bigint | undefined;
  let infiniteTimer: NodeJS.Timeout | undefined;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closed || child === undefined) return;
    closed = true;
    if (infiniteTimer !== undefined) safeClearInterval(infiniteTimer);
    processes.delete(root.pid);
    const currentDescendant = processes.get(descendant.pid);
    if (currentDescendant !== undefined)
      processes.set(descendant.pid, { ...currentDescendant, parentPid: 1 });
    if (seed !== "stream-join-failure") {
      fakeStdout?.end();
      fakeStderr?.end();
    }
    child.emit("close", code, signal);
  };
  return {
    assertNamespaceIdentity: (expected) => {
      if (expected !== "pid:[synthetic-selected-container]")
        return fail("testkit.headless.observer.identity");
      if (seed === "startup-delay" || seed === "delayed-startup") {
        const stopAt = performance.now() + 20;
        while (performance.now() < stopAt) {
          // Deliberately consume the pre-spawn test deadline.
        }
      }
    },
    listProcesses: () => {
      if (seed === "observer-failure")
        return fail("testkit.headless.observer.read");
      return [...processes.values()];
    },
    readProcess: (pid) => {
      const selected = processes.get(pid);
      if (selected === undefined) return undefined;
      rootReads += pid === root.pid ? 1 : 0;
      return (seed === "identity-substitution" ||
        seed === "observation-race") &&
        pid === root.pid &&
        rootReads > 1
        ? { ...selected, startIdentity: `${pid}:2` }
        : selected;
    },
    reapAdoptedZombie: (pid, startIdentity, rootPid, deadline) => {
      if (reapDeadline === undefined) reapDeadline = deadline;
      else if (deadline !== reapDeadline)
        return fail("testkit.headless.reconciliation.deadline");
      if (seed === "adopted-zombie-reap-failure")
        return fail("testkit.headless.observer.reap");
      const selected = processes.get(pid);
      if (
        selected === undefined ||
        selected.startIdentity !== startIdentity ||
        selected.parentPid !== 1 ||
        pid === rootPid
      )
        return fail("testkit.headless.observer.identity");
      if (selected.state !== "Z")
        return { pid, startIdentity, status: "not-ready" };
      descendantReads += 1;
      if (seed === "nested-adopted-zombie" && descendantReads === 1) {
        const stopAt = performance.now() + 10;
        while (performance.now() < stopAt) {
          // Simulate preemption between two native reap attempts.
        }
      }
      if (
        seed === "adopted-zombie-state-substitution" &&
        descendantReads === 1
      ) {
        processes.set(pid, { ...selected, state: "R" });
        return fail("testkit.headless.observer.identity");
      }
      if (seed === "adopted-zombie-not-ready")
        return { pid, startIdentity, status: "not-ready" };
      if (seed === "adopted-zombie-already-absent-persistence")
        return { pid, startIdentity, status: "already-absent" };
      if (seed === "adopted-zombie-reaped-persistence")
        return { pid, startIdentity, status: "reaped" };
      processes.delete(pid);
      if (seed === "adopted-zombie-already-absent")
        return { pid, startIdentity, status: "already-absent" };
      if (seed === "adopted-zombie-receipt-malformed")
        return Object.assign(
          { pid, startIdentity, status: "reaped" as const },
          { extra: true },
        );
      if (seed === "adopted-zombie-receipt-substitution")
        return { pid, startIdentity: `${pid}:2`, status: "reaped" };
      return { pid, startIdentity, status: "reaped" };
    },
    sendSignal: (pid, signal) => {
      if (seed === "signal-failure")
        return fail("testkit.headless.observer.signal");
      if (seed === "terminal-join-failure" || seed === "delayed-shutdown")
        return;
      if (
        (seed === "timeout" || seed === "ignored-termination") &&
        signal === "SIGTERM"
      )
        return;
      if (seed === "signal-race" && signal === "SIGTERM") {
        processes.delete(pid);
        if (pid === root.pid) finish(null, "SIGTERM");
        return;
      }
      if (pid === descendant.pid || pid === grandchild.pid) {
        const selected = processes.get(pid);
        if (selected === undefined) return;
        processes.set(pid, { ...selected, state: "Z" });
        for (const [candidatePid, candidate] of processes)
          if (candidate.parentPid === pid)
            processes.set(candidatePid, { ...candidate, parentPid: 1 });
        return;
      }
      processes.delete(pid);
      if (pid === root.pid) finish(null, signal);
    },
    spawnProcess: (request) => {
      const emitter = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      fakeStdout = stdout;
      fakeStderr = stderr;
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      Object.assign(emitter, {
        pid: seed === "crash-before-lifecycle" ? undefined : root.pid,
        stderr,
        stdin,
        stdout,
      });
      child = emitter;
      if (seed === "fast-exit" || seed === "crash-before-lifecycle")
        processes.delete(root.pid);
      queueMicrotask(() => {
        if (seed === "crash-before-lifecycle") {
          processes.delete(root.pid);
          stdout.end();
          stderr.end();
          emitter.emit("error", new Error("synthetic-process-error"));
        } else if (seed === "crash-after-lifecycle") finish(71, null);
        else if (seed === "partial-output") {
          stdout.write(Buffer.from("partial"));
          stderr.write(Buffer.from("fragment"));
          finish(70, null);
        } else if (seed === "malformed-output") {
          stdout.write(Buffer.from([0xc3]));
          finish(0, null);
        } else if (seed === "oversized-output") {
          stdout.write(Buffer.alloc(request.stdoutLimitBytes + 1));
        } else if (seed === "infinite-output") {
          infiniteTimer = safeSetInterval(() => {
            stdout.write(Buffer.alloc(64));
          }, 1);
        } else if (
          seed === "restricted-environment" ||
          seed === "missing-hook-record" ||
          seed === "duplicate-hook-record"
        ) {
          const output =
            seed === "restricted-environment"
              ? jsonStringify({
                  environmentKeys: objectKeys(request.environment),
                })
              : jsonStringify({
                  hookDeliveries: seed === "missing-hook-record" ? 0 : 2,
                });
          stdout.write(Buffer.from(output));
          finish(0, null);
        } else if (
          seed === "descendant" ||
          seed === "surviving-descendant" ||
          seed === "adopted-zombie-already-absent" ||
          seed === "adopted-zombie-already-absent-persistence" ||
          seed === "adopted-zombie-not-ready" ||
          seed === "adopted-zombie-reaped-persistence" ||
          seed === "adopted-zombie-reap-failure" ||
          seed === "adopted-zombie-receipt-malformed" ||
          seed === "adopted-zombie-receipt-substitution" ||
          seed === "adopted-zombie-state-substitution" ||
          seed === "nested-adopted-zombie"
        ) {
          processes.set(descendant.pid, descendant);
          if (seed === "nested-adopted-zombie")
            processes.set(grandchild.pid, grandchild);
          finish(0, null);
        } else if (seed === "clean" || seed === "fast-exit") finish(0, null);
        else if (seed === "output-limit")
          stdout.write(Buffer.alloc(request.stdoutLimitBytes + 1));
      });
      return emitter;
    },
  };
};

/** Package-private selected-container lifecycle tests; never containment evidence. */
export const executeSelectedContainerBackendForTest = async (
  request: HeadlessExecutionRequest,
  seed: SelectedContainerTestSeed,
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<HeadlessExecutionTrace> => {
  const capability = safeReflectApply(freeze, Object, [{}]) as object;
  writeWeakMap(
    selectedBackendAuthorities,
    capability,
    selectedContainerBackend(
      {
        maximumShutdownDeadlineMs: request.monotonicShutdownDeadlineMs,
        namespaceIdentity: "pid:[synthetic-selected-container]",
      },
      selectedContainerRuntimeForTest(seed),
    ),
  );
  if (seed === "abort") {
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort();
    });
    options = { signal: controller.signal };
  }
  return executeSelectedHeadlessProcessWithCapability(
    capability as HeadlessSupervisorCapability,
    request,
    options,
  );
};

type SelectedPtyTestSeed =
  | "active-terminal"
  | "action-deadline-crossing"
  | "adopted-zombie"
  | "blocked-input-completion"
  | "challenge-marker-prompt"
  | "clean"
  | "close-failure"
  | "completion-before-readiness"
  | "checkpoint-extra-process"
  | "checkpoint-observer-delay-mismatch"
  | "checkpoint-missing-process"
  | "checkpoint-observer-delay"
  | "checkpoint-owned-descendant"
  | "checkpoint-owned-sidecar"
  | "checkpoint-process-churn"
  | "checkpoint-transient-extra-process"
  | "control-eof-substitution"
  | "control-write-substitution"
  | "descriptor-closure"
  | "descriptor-reuse"
  | "descriptor-substitution"
  | "eof-failure"
  | "fragmented-output"
  | "fixed-readiness-spoof"
  | "geometry-substitution"
  | "identity-substitution"
  | "immediate-output"
  | "immutable-capability"
  | "immutable-device-inode"
  | "immutable-mount-id"
  | "immutable-mount-rw"
  | "immutable-no-new-privileges"
  | "immutable-principal"
  | "immutable-symlink"
  | "late-tail"
  | "kill-escalation"
  | "keyboard-protocol-missing"
  | "keyboard-protocol-out-of-order"
  | "keyboard-protocol-readiness-before"
  | "keyboard-protocol-readiness-before-blocked"
  | "keyboard-protocol-after-readiness"
  | "keyboard-protocol-reset"
  | "keyboard-protocol-ris"
  | "keyboard-protocol-same-burst"
  | "keyboard-protocol-substituted"
  | "credential-prompt"
  | "malformed-control"
  | "malformed-exit"
  | "missing-completion"
  | "missing-ready"
  | "mode-substitution"
  | "nonzero-exit"
  | "observer-failure"
  | "output-limit"
  | "partial-input"
  | "partial-input-output-limit"
  | "partial-input-timeout"
  | "paced-input"
  | "post-input-completion"
  | "readiness-burst"
  | "readiness-revoked-after-input"
  | "residual"
  | "root-missing"
  | "signal-failure"
  | "startup-delay"
  | "transport-failure"
  | "timeout"
  | "terminal-redraw-enter-fragmented"
  | "terminal-prompt-partial"
  | "terminal-no-prompt"
  | "terminal-stale-prebuffer-no-redraw"
  | "terminal-passive-control-no-redraw"
  | "terminal-framed-bel-stitch"
  | "terminal-framed-newline-stitch"
  | "terminal-framed-clear-stitch"
  | "terminal-framed-erase-stitch"
  | "terminal-framed-insert-stitch"
  | "terminal-framed-delete-stitch"
  | "terminal-framed-scroll-stitch"
  | "terminal-framed-combined-begin"
  | "terminal-framed-combined-end"
  | "terminal-post-frame-erase"
  | "terminal-framed-alt-enter-stitch"
  | "terminal-framed-alt-exit-stitch"
  | "terminal-framed-wrap-stitch"
  | "terminal-post-frame-alt-exit"
  | "terminal-post-frame-scroll-region"
  | "terminal-framed-charset-stitch"
  | "terminal-framed-conceal-stitch"
  | "terminal-post-frame-tab-stop"
  | "terminal-post-frame-restore"
  | "terminal-prior-no-wrap"
  | "terminal-prior-scroll-margin"
  | "terminal-prior-alt-switch"
  | "terminal-saved-no-wrap"
  | "terminal-alt-clear-no-home"
  | "terminal-combined-no-wrap"
  | "terminal-combined-alt-switch"
  | "terminal-wide-printable"
  | "terminal-combining-printable"
  | "terminal-live-completion-no-redraw"
  | "terminal-post-wait-pacing"
  | "terminal-query-blocked"
  | "terminal-query-handshake"
  | "terminal-query-partial"
  | "unsupported-control"
  | "unsupported-signal";

const selectedPtyRuntimeForTest = (
  seed: SelectedPtyTestSeed,
  readiness: SelectedPtyExecutionRequest["readiness"] = {
    kind: "semantic-marker",
  },
  // eslint-disable-next-line max-lines-per-function
): PtyRuntime => {
  const root: ProcessSnapshot = {
    parentPid: 1,
    pid: 42_001,
    startIdentity: "42001:1",
    state: "R",
  };
  const descendant: ProcessSnapshot = {
    parentPid: 1,
    pid: 42_002,
    startIdentity: "42002:1",
    state: "R",
  };
  const checkpointChild: ProcessSnapshot = {
    parentPid: root.pid,
    pid: 42_003,
    startIdentity: "42003:1",
    state: "R",
  };
  const checkpointGrandchild: ProcessSnapshot = {
    parentPid: checkpointChild.pid,
    pid: 42_004,
    startIdentity: "42004:1",
    state: "R",
  };
  const checkpointExtra: ProcessSnapshot = {
    parentPid: root.pid,
    pid: 42_005,
    startIdentity: "42005:1",
    state: "R",
  };
  const checkpointOwnedDescendant: ProcessSnapshot = {
    parentPid: checkpointGrandchild.pid,
    pid: 42_006,
    startIdentity: "42006:1",
    state: "R",
  };
  const processes = new Map<number, ProcessSnapshot>([[root.pid, root]]);
  let reads = 0;
  let releasedAfterDelayedMismatch = false;
  let resolveClose: ((value: PtyExit) => void) | undefined;
  let terminal = false;
  let tailReadyAt = 0;
  return {
    assertImmutableCandidateFile: () => {
      if (seed === "immutable-mount-id" || seed === "immutable-mount-rw")
        return fail("testkit.pty.immutable-candidate");
    },
    assertImmutableCandidateRuntime: () => {
      if (
        seed === "immutable-capability" ||
        seed === "immutable-no-new-privileges" ||
        seed === "immutable-principal"
      )
        return fail("testkit.pty.immutable-candidate");
    },
    assertNamespaceIdentity: (expected) => {
      if (expected !== "pid:[synthetic-selected-pty]")
        return fail("testkit.headless.observer.identity");
    },
    freezeProcessSet: (_namespaceIdentity, monotonicDeadlineMs) => {
      if (
        seed === "checkpoint-observer-delay" ||
        seed === "checkpoint-observer-delay-mismatch"
      ) {
        while (
          safeReflectApply(performanceNow, performance, []) <
          monotonicDeadlineMs + 1
        ) {
          // Cross the immutable execution cutoff inside the observer.
        }
      }
      if (seed === "checkpoint-process-churn")
        return fail("testkit.headless.observer.process-set");
      for (const [pid, identity] of processes)
        processes.set(pid, { ...identity, state: "T" });
      return [...processes.values()];
    },
    listProcesses: () => {
      if (seed === "observer-failure")
        return fail("testkit.headless.observer.read");
      return [...processes.values()];
    },
    readProcess: (pid) => {
      if (seed === "root-missing") return undefined;
      if (releasedAfterDelayedMismatch)
        return fail("testkit.headless.observer.identity");
      const value = processes.get(pid);
      if (value === undefined) return undefined;
      reads += pid === root.pid ? 1 : 0;
      return seed === "identity-substitution" && reads > 1
        ? { ...value, startIdentity: "42001:2" }
        : value;
    },
    reapAdoptedZombie: (pid, startIdentity, rootPid) => {
      const selected = processes.get(pid);
      if (
        selected === undefined ||
        selected.startIdentity !== startIdentity ||
        selected.parentPid !== 1 ||
        pid === rootPid
      )
        return fail("testkit.headless.observer.identity");
      if (selected.state !== "Z")
        return { pid, startIdentity, status: "not-ready" };
      processes.delete(pid);
      return { pid, startIdentity, status: "reaped" };
    },
    releaseFrozenProcessSet: (
      _namespaceIdentity,
      expectedProcesses,
      rootPid,
      notifyRoot,
    ) => {
      if (seed === "checkpoint-observer-delay-mismatch")
        releasedAfterDelayedMismatch = true;
      const ordered = [...expectedProcesses].sort((left, right) => {
        if (left.pid === rootPid) return 1;
        if (right.pid === rootPid) return -1;
        return right.pid - left.pid;
      });
      for (const expected of ordered) {
        const current = processes.get(expected.pid);
        if (
          current === undefined ||
          current.startIdentity !== expected.startIdentity ||
          current.state !== "T"
        )
          return fail("testkit.headless.observer.identity");
      }
      for (const expected of ordered)
        processes.set(expected.pid, { ...expected, state: "R" });
      if (seed === "checkpoint-transient-extra-process" && !notifyRoot)
        processes.delete(checkpointExtra.pid);
    },
    sendSignal: (pid, signal) => {
      if (seed === "signal-failure")
        return fail("testkit.headless.observer.signal");
      if (seed === "residual" && pid === descendant.pid) return;
      if (
        seed === "kill-escalation" &&
        pid === root.pid &&
        signal === "SIGTERM"
      )
        return;
      if (seed === "adopted-zombie" && pid === descendant.pid) {
        processes.set(pid, { ...descendant, parentPid: 1, state: "Z" });
        return;
      }
      processes.delete(pid);
      if (pid === root.pid) {
        terminal = true;
        resolveClose?.({
          code: 0,
          signal: signal === "SIGINT" ? 2 : signal === "SIGKILL" ? 9 : 15,
        });
      }
    },
    // eslint-disable-next-line max-lines-per-function, complexity -- closed adversarial fixture matrix
    spawnPty: (request, geometry, interpreter, scriptSha256) => {
      if (
        readiness.kind === "challenge-process-topology" ||
        readiness.kind === "challenge-marker" ||
        readiness.kind === "challenge-styled-text"
      ) {
        if (seed !== "checkpoint-missing-process") {
          processes.set(checkpointChild.pid, checkpointChild);
          processes.set(checkpointGrandchild.pid, checkpointGrandchild);
        }
        if (seed === "checkpoint-owned-sidecar")
          processes.set(descendant.pid, descendant);
        if (seed === "checkpoint-owned-descendant")
          processes.set(
            checkpointOwnedDescendant.pid,
            checkpointOwnedDescendant,
          );
        if (
          seed === "checkpoint-extra-process" ||
          seed === "checkpoint-observer-delay-mismatch" ||
          seed === "checkpoint-transient-extra-process"
        )
          processes.set(checkpointExtra.pid, checkpointExtra);
      }
      if (
        seed === "immutable-mount-id" ||
        seed === "immutable-mount-rw" ||
        seed === "immutable-device-inode" ||
        seed === "immutable-symlink"
      )
        return fail("testkit.pty.immutable-candidate");
      if (
        (seed === "descriptor-substitution" &&
          interpreter.sha256 !== "0".repeat(64)) ||
        seed === "descriptor-closure" ||
        seed === "descriptor-reuse" ||
        scriptSha256.length !== 64
      )
        return fail("testkit.pty.runtime.identity");
      if (seed === "startup-delay") {
        const stopAt = performance.now() + 30;
        while (performance.now() < stopAt) {
          // Deliberately cross the admitted startup deadline before returning.
        }
      }
      let close!: (value: PtyExit) => void;
      const closed = observeAtCreation(
        new SafePromise<PtyExit>((resolve_) => {
          close = resolve_;
          resolveClose = resolve_;
        }),
      );
      const output =
        seed === "output-limit" || seed === "partial-input-output-limit"
          ? safeBufferFrom("x".repeat(request.stdoutLimitBytes + 1))
          : seed === "active-terminal" || seed === "immediate-output"
            ? safeBufferFrom("ready")
            : seed === "missing-completion"
              ? safeBufferFrom("active")
              : seed === "credential-prompt"
                ? safeBufferFrom("Password:")
                : seed === "malformed-control"
                  ? safeBufferFrom("\u001b[")
                  : seed === "unsupported-control"
                    ? safeBufferFrom("\u001b[?9999h")
                    : safeBufferFrom("AGENTSCOPE_PTY_COMPLETE");
      const ready = safeBufferFrom(
        readiness.kind === "challenge-styled-text"
          ? `AGENTSCOPE_PTY_READY:${readiness.challenge}\r\n\u001b[1m›\u001b[22m ${readiness.requiredText}`
          : readiness.kind === "challenge-process-topology" &&
              seed !== "fixed-readiness-spoof"
            ? `AGENTSCOPE_PTY_TOPOLOGY:${readiness.challenge}`
            : readiness.kind === "challenge-marker" &&
                seed !== "fixed-readiness-spoof"
              ? `AGENTSCOPE_PTY_READY:${readiness.challenge}`
              : "AGENTSCOPE_PTY_READY",
      );
      const orderedQueries =
        "\u001b[6n\u001b]10;?\u001b\\\u001b]11;?\u001b\\\u001b[?u\u001b[c";
      const terminalQueries = safeBufferFrom(
        seed === "keyboard-protocol-missing"
          ? orderedQueries
          : seed === "keyboard-protocol-substituted"
            ? `\u001b[>6u${orderedQueries}`
            : seed === "keyboard-protocol-out-of-order"
              ? `${orderedQueries}\u001b[>7u`
              : seed === "keyboard-protocol-reset"
                ? `\u001b[>7u${orderedQueries}\u001b[<u`
                : `\u001b[>7u${orderedQueries}`,
      );
      const terminalResponses = safeBufferFrom(
        `\u001b[2;${seed === "keyboard-protocol-readiness-before" || seed === "keyboard-protocol-readiness-before-blocked" ? 27 : 1}R\u001b]10;rgb:ffff/ffff/ffff\u001b\\\u001b]11;rgb:0000/0000/0000\u001b\\\u001b[?0u\u001b[?1;2c`,
      );
      const terminalQueryHandshake =
        readiness.kind === "challenge-styled-text" ||
        seed === "terminal-redraw-enter-fragmented" ||
        seed === "terminal-prompt-partial" ||
        seed === "terminal-no-prompt" ||
        seed === "terminal-query-handshake" ||
        seed === "terminal-query-partial" ||
        seed === "terminal-query-blocked";
      const terminalProtocolNegativeSeed =
        seed === "keyboard-protocol-missing" ||
        seed === "keyboard-protocol-substituted" ||
        seed === "keyboard-protocol-out-of-order" ||
        seed === "keyboard-protocol-after-readiness" ||
        seed === "keyboard-protocol-reset" ||
        seed === "keyboard-protocol-ris";
      const requiresCausalPromptRedraw =
        readiness.kind === "challenge-styled-text" &&
        !terminalProtocolNegativeSeed;
      const rejectsCausalPromptRedraw =
        seed === "terminal-stale-prebuffer-no-redraw" ||
        seed === "terminal-passive-control-no-redraw" ||
        seed === "terminal-framed-bel-stitch" ||
        seed === "terminal-framed-newline-stitch" ||
        seed === "terminal-framed-clear-stitch" ||
        seed === "terminal-framed-erase-stitch" ||
        seed === "terminal-framed-insert-stitch" ||
        seed === "terminal-framed-delete-stitch" ||
        seed === "terminal-framed-scroll-stitch" ||
        seed === "terminal-framed-combined-begin" ||
        seed === "terminal-framed-combined-end" ||
        seed === "terminal-post-frame-erase" ||
        seed === "terminal-framed-alt-enter-stitch" ||
        seed === "terminal-framed-alt-exit-stitch" ||
        seed === "terminal-framed-wrap-stitch" ||
        seed === "terminal-post-frame-alt-exit" ||
        seed === "terminal-post-frame-scroll-region" ||
        seed === "terminal-framed-charset-stitch" ||
        seed === "terminal-framed-conceal-stitch" ||
        seed === "terminal-post-frame-tab-stop" ||
        seed === "terminal-post-frame-restore" ||
        seed === "terminal-prior-no-wrap" ||
        seed === "terminal-prior-scroll-margin" ||
        seed === "terminal-prior-alt-switch" ||
        seed === "terminal-saved-no-wrap" ||
        seed === "terminal-alt-clear-no-home" ||
        seed === "terminal-combined-no-wrap" ||
        seed === "terminal-combined-alt-switch" ||
        seed === "terminal-wide-printable" ||
        seed === "terminal-combining-printable";
      const framedStitchMutator =
        seed === "terminal-framed-erase-stitch"
          ? "X"
          : seed === "terminal-framed-insert-stitch"
            ? "@"
            : seed === "terminal-framed-delete-stitch"
              ? "P"
              : seed === "terminal-framed-scroll-stitch"
                ? "S"
                : undefined;
      const challengedMarker =
        readiness.kind === "challenge-styled-text"
          ? safeBufferFrom(`AGENTSCOPE_PTY_READY:${readiness.challenge}\r\n`)
          : ready;
      const styledPrompt =
        readiness.kind === "challenge-styled-text"
          ? safeBufferFrom(`\u001b[1m›\u001b[22m ${readiness.requiredText}`)
          : ready;
      const synchronizedStyledPrompt = safeBufferFrom(
        `\u001b[?2026h${styledPrompt.toString()}\u001b[?2026l`,
      );
      const synchronizedPromptRendered = safeBufferFrom(
        `\u001b[?2026h\u001b[2J\u001b[H${styledPrompt.toString()} prompt-rendered\u001b[?2026l`,
      );
      const chunks =
        readiness.kind === "challenge-styled-text"
          ? seed === "keyboard-protocol-readiness-before" ||
            seed === "keyboard-protocol-readiness-before-blocked"
            ? [
                challengedMarker,
                safeBufferFrom(
                  `${synchronizedStyledPrompt.toString()}${terminalQueries.toString()}`,
                ),
                ...(seed === "keyboard-protocol-readiness-before-blocked"
                  ? []
                  : [safeBufferFrom("\u0007")]),
                synchronizedPromptRendered,
                output,
              ]
            : seed === "keyboard-protocol-same-burst"
              ? [
                  challengedMarker,
                  safeBufferFrom(
                    `${terminalQueries.toString()}${synchronizedStyledPrompt.toString()}`,
                  ),
                  safeBufferFrom("\u0007"),
                  synchronizedPromptRendered,
                  output,
                ]
              : seed === "keyboard-protocol-after-readiness"
                ? [
                    challengedMarker,
                    terminalQueries,
                    synchronizedStyledPrompt,
                    terminalQueries,
                    synchronizedPromptRendered,
                    output,
                  ]
                : [
                    challengedMarker,
                    terminalQueries,
                    seed === "keyboard-protocol-ris"
                      ? safeBufferFrom(
                          `${synchronizedStyledPrompt.toString()}\u001bc${synchronizedStyledPrompt.toString()}`,
                        )
                      : synchronizedStyledPrompt,
                    seed === "terminal-stale-prebuffer-no-redraw"
                      ? safeBufferFrom("AGENTSCOPE_PTY_COMPLETE")
                      : seed === "terminal-passive-control-no-redraw"
                        ? safeBufferFrom("\u0007")
                        : seed === "terminal-framed-bel-stitch"
                          ? safeBufferFrom(
                              `\u001b[?2026h${styledPrompt.toString()}\u0007${readiness.requiredText}\u001b[?2026l`,
                            )
                          : seed === "terminal-framed-newline-stitch"
                            ? safeBufferFrom(
                                `\u001b[?2026h${styledPrompt.toString()}\r\n${readiness.requiredText}\u001b[?2026l`,
                              )
                            : seed === "terminal-framed-clear-stitch"
                              ? safeBufferFrom(
                                  `\u001b[?2026h\u001b[5;1H${styledPrompt.toString()}\u001b[2K${readiness.requiredText}\u001b[?2026l`,
                                )
                              : framedStitchMutator !== undefined
                                ? safeBufferFrom(
                                    `\u001b[?2026h\u001b[5;1H${styledPrompt.toString()}\u001b[1${framedStitchMutator}${readiness.requiredText}\u001b[?2026l`,
                                  )
                                : seed === "terminal-framed-combined-begin"
                                  ? safeBufferFrom(
                                      `\u001b[?2026;25h${styledPrompt.toString()}${readiness.requiredText}\u001b[?2026l`,
                                    )
                                  : seed === "terminal-framed-combined-end"
                                    ? safeBufferFrom(
                                        `\u001b[?2026h${styledPrompt.toString()}\u001b[?2026;25l${readiness.requiredText}\u001b[?2026l`,
                                      )
                                    : seed === "terminal-post-frame-erase"
                                      ? safeBufferFrom(
                                          `\u001b[?2026h\u001b[5;1H${styledPrompt.toString()}${readiness.requiredText}\u001b[?2026l\u001b[5;1H\u001b[1X`,
                                        )
                                      : seed ===
                                          "terminal-framed-alt-enter-stitch"
                                        ? safeBufferFrom(
                                            `\u001b[?2026h${styledPrompt.toString()}\u001b[?1049h${readiness.requiredText}\u001b[?2026l`,
                                          )
                                        : seed ===
                                            "terminal-framed-alt-exit-stitch"
                                          ? safeBufferFrom(
                                              `\u001b[?1049h\u001b[?2026h${styledPrompt.toString()}\u001b[?1049l${readiness.requiredText}\u001b[?2026l`,
                                            )
                                          : seed ===
                                              "terminal-framed-wrap-stitch"
                                            ? safeBufferFrom(
                                                `\u001b[?2026h${styledPrompt.toString()}\u001b[?7l${readiness.requiredText}\u001b[?2026l`,
                                              )
                                            : seed ===
                                                "terminal-post-frame-alt-exit"
                                              ? safeBufferFrom(
                                                  `\u001b[?1049h\u001b[?2026h${styledPrompt.toString()}${readiness.requiredText}\u001b[?2026l\u001b[?1049l`,
                                                )
                                              : seed ===
                                                  "terminal-post-frame-scroll-region"
                                                ? safeBufferFrom(
                                                    `\u001b[?2026h${styledPrompt.toString()}${readiness.requiredText}\u001b[?2026l\u001b[1;8rX`,
                                                  )
                                                : seed ===
                                                    "terminal-framed-charset-stitch"
                                                  ? safeBufferFrom(
                                                      `\u001b[?2026h${styledPrompt.toString()}\u001b(0${readiness.requiredText}\u001b[?2026l`,
                                                    )
                                                  : seed ===
                                                      "terminal-framed-conceal-stitch"
                                                    ? safeBufferFrom(
                                                        `\u001b[?2026h${styledPrompt.toString()}\u001b[8m${readiness.requiredText}\u001b[?2026l`,
                                                      )
                                                    : seed ===
                                                        "terminal-post-frame-tab-stop"
                                                      ? safeBufferFrom(
                                                          `\u001b[?2026h${styledPrompt.toString()}${readiness.requiredText}\u001b[?2026l\u001bH`,
                                                        )
                                                      : seed ===
                                                          "terminal-post-frame-restore"
                                                        ? safeBufferFrom(
                                                            `\u001b7\u001b[?2026h${styledPrompt.toString()}${readiness.requiredText}\u001b[?2026l\u001b8`,
                                                          )
                                                        : seed ===
                                                            "terminal-prior-no-wrap"
                                                          ? safeBufferFrom(
                                                              `\u001b[?7l\u001b[?2026h\u001b[100G${styledPrompt.toString()}\u001b[?2026l`,
                                                            )
                                                          : seed ===
                                                              "terminal-prior-scroll-margin"
                                                            ? safeBufferFrom(
                                                                `\u001b[2;8r\u001b[?2026h${styledPrompt.toString()}\u001b[?2026l`,
                                                              )
                                                            : seed ===
                                                                "terminal-prior-alt-switch"
                                                              ? safeBufferFrom(
                                                                  `\u001b[?1049h\u001b[?2026h${styledPrompt.toString()}\u001b[?2026l`,
                                                                )
                                                              : seed ===
                                                                  "terminal-saved-no-wrap"
                                                                ? safeBufferFrom(
                                                                    `\u001b[?7l\u001b7\u001b[?7h\u001b8\u001b[?2026h\u001b[100G${styledPrompt.toString()}\u001b[?2026l`,
                                                                  )
                                                                : seed ===
                                                                    "terminal-alt-clear-no-home"
                                                                  ? safeBufferFrom(
                                                                      `\u001b[91G\u001b[?1049h\u001b[H\u001b[?1049l\u001b[?2026h\u001b[2J${styledPrompt.toString()}\u001b[?2026l`,
                                                                    )
                                                                  : seed ===
                                                                      "terminal-combined-no-wrap"
                                                                    ? safeBufferFrom(
                                                                        `\u001b[?2026;7l\u001b[?2026l\u001b[?2026h\u001b[100G${styledPrompt.toString()}\u001b[?2026l`,
                                                                      )
                                                                    : seed ===
                                                                        "terminal-combined-alt-switch"
                                                                      ? safeBufferFrom(
                                                                          `\u001b[?2026;1049h\u001b[?2026l\u001b[?2026h${styledPrompt.toString()}\u001b[?2026l`,
                                                                        )
                                                                      : seed ===
                                                                          "terminal-wide-printable"
                                                                        ? safeBufferFrom(
                                                                            `\u001b[?2026h\u001b[77G界${styledPrompt.toString()}\u001b[?2026l`,
                                                                          )
                                                                        : seed ===
                                                                            "terminal-combining-printable"
                                                                          ? safeBufferFrom(
                                                                              `\u001b[?2026h\u001b[79Gx\u0301${styledPrompt.toString()}\u001b[?2026l`,
                                                                            )
                                                                          : seed ===
                                                                              "terminal-live-completion-no-redraw"
                                                                            ? safeBufferFrom(
                                                                                "AGENTSCOPE_PTY_COMPLETE",
                                                                              )
                                                                            : synchronizedPromptRendered,
                    output,
                  ]
          : seed === "challenge-marker-prompt"
            ? [ready, safeBufferFrom("prompt-accepted"), output]
            : terminalQueryHandshake
              ? [
                  challengedMarker,
                  terminalQueries,
                  styledPrompt,
                  safeBufferFrom("prompt-rendered"),
                  output,
                ]
              : seed === "completion-before-readiness"
                ? [output, ready]
                : seed === "fragmented-output"
                  ? [
                      ready.subarray(0, 2),
                      ready.subarray(2),
                      output.subarray(0, 2),
                      output.subarray(2),
                    ]
                  : seed === "readiness-burst"
                    ? [
                        safeBufferFrom(
                          `${ready.toString()}${"x".repeat(3_000)}`,
                        ),
                        output,
                      ]
                    : seed === "output-limit" ||
                        seed === "partial-input-output-limit"
                      ? [output.subarray(0, 4_096), output.subarray(4_096)]
                      : seed === "active-terminal" ||
                          seed === "immediate-output" ||
                          seed === "missing-ready" ||
                          seed === "credential-prompt" ||
                          seed === "malformed-control" ||
                          seed === "unsupported-control"
                        ? [output]
                        : [ready, output];
      let chunkIndex = 0;
      let chunkOffset = 0;
      let inputCalls = 0;
      let immediateActionApplied = false;
      let priorInputTransportReads = -1;
      let transportReads = 0;
      let currentGeometry = geometry;
      let terminalQueryAnswered = false;
      let terminalResponseOffset = 0;
      let terminalResponseWriteCalls = 0;
      let submissionPromptAccepted = 0;
      let promptAcknowledgedByOutput = false;
      let submissionEnterAccepted = 0;
      let submissionEnterWriteCalls = 0;
      let readinessRevokedAfterInput = false;
      let promptInputObserved = false;
      let liveCompletionWouldBlockObserved = false;
      const observeSubmissionInputWrite = (bytes: Uint8Array, call: number) => {
        if (!requiresCausalPromptRedraw) return undefined;
        if (call >= 2 && submissionPromptAccepted < 67) {
          const bytesWritten =
            seed === "terminal-prompt-partial" && call === 2
              ? Math.max(1, Math.floor(bytes.length / 2))
              : bytes.length;
          submissionPromptAccepted += bytesWritten;
          return {
            status:
              bytesWritten === bytes.length
                ? ("complete" as const)
                : ("partial" as const),
            bytesWritten,
          };
        }
        const exactEnter = new SafeUint8Array([0x1b, 0x5b, 0x31, 0x33, 0x75]);
        let enterMatches =
          bytes.length === exactEnter.length - submissionEnterAccepted;
        for (let offset = 0; enterMatches && offset < bytes.length; offset += 1)
          enterMatches =
            bytes[offset] === exactEnter[submissionEnterAccepted + offset];
        if (!enterMatches) return undefined;
        if (!promptAcknowledgedByOutput)
          throw new Error("testkit.pty.test-enter-before-prompt-redraw");
        submissionEnterWriteCalls += 1;
        if (
          seed === "terminal-redraw-enter-fragmented" &&
          submissionEnterWriteCalls === 1
        )
          return { status: "would-block" as const, bytesWritten: 0 };
        const bytesWritten =
          seed === "terminal-redraw-enter-fragmented" &&
          submissionEnterWriteCalls === 2
            ? Math.max(1, Math.floor(bytes.length / 2))
            : bytes.length;
        submissionEnterAccepted += bytesWritten;
        return {
          status:
            bytesWritten === bytes.length
              ? ("complete" as const)
              : ("partial" as const),
          bytesWritten,
        };
      };
      const readReadinessRevocationAfterPrompt = ():
        PtyReadObservation | undefined => {
        if (
          seed === "readiness-revoked-after-input" &&
          promptInputObserved &&
          !readinessRevokedAfterInput
        ) {
          readinessRevokedAfterInput = true;
          processes.clear();
          terminal = true;
          close({ code: 0, signal: 0 });
          return {
            status: "data" as const,
            bytes: safeBufferFrom("\u001b[2JAGENTSCOPE_PTY_COMPLETE"),
          };
        }
        return readinessRevokedAfterInput && terminal
          ? { status: "eio" as const }
          : undefined;
      };
      const assertNoReadDuringPartialSubmission = (): void => {
        if (
          (submissionPromptAccepted > 0 && submissionPromptAccepted < 67) ||
          (submissionEnterAccepted > 0 && submissionEnterAccepted < 5)
        )
          throw new Error("testkit.pty.test-read-during-partial-input");
      };
      queueMicrotask(() => {
        if (seed === "residual" || seed === "adopted-zombie")
          processes.set(descendant.pid, descendant);
        if (
          seed !== "timeout" &&
          seed !== "identity-substitution" &&
          seed !== "output-limit" &&
          seed !== "partial-input-output-limit" &&
          seed !== "partial-input-timeout" &&
          seed !== "readiness-burst" &&
          seed !== "kill-escalation" &&
          seed !== "signal-failure" &&
          seed !== "challenge-marker-prompt" &&
          seed !== "terminal-redraw-enter-fragmented" &&
          seed !== "terminal-prompt-partial" &&
          seed !== "terminal-post-wait-pacing" &&
          seed !== "terminal-query-handshake" &&
          seed !== "terminal-query-partial" &&
          seed !== "terminal-query-blocked" &&
          seed !== "keyboard-protocol-readiness-before-blocked"
        )
          safeSetTimeout(
            () => {
              if (
                readiness.kind === "challenge-process-topology" ||
                readiness.kind === "challenge-marker" ||
                readiness.kind === "challenge-styled-text"
              )
                processes.clear();
              else processes.delete(root.pid);
              if (seed === "adopted-zombie")
                processes.set(descendant.pid, {
                  ...descendant,
                  parentPid: 1,
                });
              terminal = true;
              if (seed === "late-tail") tailReadyAt = performance.now() + 30;
              close(
                seed === "malformed-exit"
                  ? { code: -1, signal: 0 }
                  : seed === "unsupported-signal"
                    ? { code: 0, signal: 1 }
                    : {
                        code: seed === "nonzero-exit" ? 7 : 0,
                        signal: 0,
                      },
              );
            },
            readiness.kind === "challenge-process-topology" ||
              readiness.kind === "challenge-marker" ||
              readiness.kind === "challenge-styled-text"
              ? 50
              : seed === "partial-input"
                ? 25
                : 5,
          );
      });
      return {
        closed,
        pid: root.pid,
        close: () => {
          if (seed === "close-failure") return fail("testkit.pty.transport");
          if (processes.has(root.pid)) {
            processes.delete(root.pid);
            terminal = true;
            close({ code: 0, signal: 15 });
          }
        },
        eof: () => {
          if (seed === "eof-failure") return fail("testkit.pty.transport");
          if (seed === "immediate-output") immediateActionApplied = true;
          return {
            status: "eof-byte-written" as const,
            canonical: true as const,
            eofByte: seed === "control-eof-substitution" ? 5 : 4,
            bytesWritten: 1 as const,
          };
        },
        inspect: () => ({
          isTTY: true,
          canonical: seed !== "mode-substitution",
          columns: currentGeometry.columns,
          rows:
            seed === "geometry-substitution"
              ? currentGeometry.rows + 1
              : currentGeometry.rows,
          eofByte: 4,
        }),
        // eslint-disable-next-line complexity,max-lines-per-function -- adversarial fixture states are explicit and closed
        read: (maximumBytes) => {
          assertNoReadDuringPartialSubmission();
          transportReads += 1;
          if (seed === "immediate-output" && !immediateActionApplied)
            throw new Error("testkit.pty.test-read-before-immediate-action");
          if (seed === "action-deadline-crossing" && transportReads === 1) {
            const stopAt = request.monotonicExecutionDeadlineMs + 1;
            while (performance.now() < stopAt) {
              // Cross the one execution deadline while observing readiness.
            }
          }
          if (seed === "transport-failure")
            return fail("testkit.pty.transport");
          if (
            (seed === "terminal-post-wait-pacing" ||
              seed === "challenge-marker-prompt") &&
            inputCalls >= 4
          ) {
            processes.clear();
            terminal = true;
            close({ code: 0, signal: 0 });
            return { status: "eio" as const };
          }
          if (
            terminalQueryHandshake &&
            chunkIndex >= 2 &&
            !terminalQueryAnswered
          )
            return { status: "would-block" as const };
          if (
            seed === "terminal-no-prompt" &&
            chunkIndex === 3 &&
            submissionPromptAccepted === 0
          ) {
            processes.clear();
            terminal = true;
            close({ code: 0, signal: 0 });
            return { status: "eio" as const };
          }
          if (
            requiresCausalPromptRedraw &&
            chunkIndex ===
              (seed === "keyboard-protocol-readiness-before-blocked" ? 2 : 3) &&
            submissionPromptAccepted < 67 &&
            seed !== "terminal-stale-prebuffer-no-redraw"
          )
            return { status: "would-block" as const };
          if (
            seed === "challenge-marker-prompt" &&
            ((chunkIndex === 1 && inputCalls < 2) ||
              (chunkIndex === 2 && inputCalls < 3))
          )
            return { status: "would-block" as const };
          if (
            seed === "post-input-completion" &&
            chunkIndex === 1 &&
            inputCalls === 0
          )
            return { status: "would-block" as const };
          const readinessRevocation = readReadinessRevocationAfterPrompt();
          if (readinessRevocation !== undefined) return readinessRevocation;
          if (
            seed === "late-tail" &&
            chunkIndex > 0 &&
            (!terminal || performance.now() < tailReadyAt)
          )
            return { status: "would-block" as const };
          const chunk = chunks[chunkIndex];
          if (chunk !== undefined) {
            const bytes = chunk.subarray(
              chunkOffset,
              Math.min(chunk.length, chunkOffset + maximumBytes),
            );
            chunkOffset += bytes.length;
            if (chunkOffset === chunk.length) {
              chunkIndex += 1;
              chunkOffset = 0;
              if (
                terminalProtocolNegativeSeed &&
                chunkIndex === chunks.length
              ) {
                processes.clear();
                terminal = true;
                close({ code: 0, signal: 0 });
              }
            }
            if (
              submissionPromptAccepted === 67 &&
              chunkIndex >
                (seed === "keyboard-protocol-readiness-before-blocked"
                  ? 2
                  : 3) &&
              !rejectsCausalPromptRedraw &&
              seed !== "terminal-live-completion-no-redraw"
            )
              promptAcknowledgedByOutput = true;
            return { status: "data" as const, bytes };
          }
          if (submissionPromptAccepted === 67 && rejectsCausalPromptRedraw) {
            processes.clear();
            terminal = true;
            close({ code: 0, signal: 0 });
            return { status: "eio" as const };
          }
          if (
            submissionPromptAccepted === 67 &&
            seed === "terminal-live-completion-no-redraw"
          ) {
            if (!liveCompletionWouldBlockObserved) {
              liveCompletionWouldBlockObserved = true;
              return { status: "would-block" as const };
            }
            processes.clear();
            terminal = true;
            close({ code: 0, signal: 0 });
            return { status: "eio" as const };
          }
          if (terminalProtocolNegativeSeed && !terminal) {
            processes.clear();
            terminal = true;
            close({ code: 0, signal: 0 });
          }
          return terminal
            ? { status: "eio" as const }
            : { status: "would-block" as const };
        },
        resize: (columns, rows) => {
          currentGeometry = { columns, rows };
        },
        // eslint-disable-next-line complexity -- adversarial fixture states are explicit and closed
        write: (bytes) => {
          if (
            terminalQueryHandshake &&
            !terminalQueryAnswered &&
            safeBufferFrom(bytes).equals(
              terminalResponses.subarray(terminalResponseOffset),
            )
          ) {
            terminalResponseWriteCalls += 1;
            if (
              (seed === "terminal-query-blocked" ||
                seed === "keyboard-protocol-readiness-before-blocked") &&
              terminalResponseWriteCalls === 1
            )
              return { status: "would-block" as const, bytesWritten: 0 };
            if (
              seed === "terminal-query-partial" &&
              terminalResponseWriteCalls === 1
            ) {
              const bytesWritten = Math.max(1, Math.floor(bytes.length / 2));
              terminalResponseOffset += bytesWritten;
              return { status: "partial" as const, bytesWritten };
            }
            terminalResponseOffset += bytes.length;
            terminalQueryAnswered = true;
            return {
              status: "complete" as const,
              bytesWritten: bytes.length,
            };
          }
          if (seed === "terminal-no-prompt" && inputCalls >= 1)
            throw new Error("testkit.pty.test-prompt-after-terminal-close");
          inputCalls += 1;
          if (inputCalls === 2) promptInputObserved = true;
          const submissionResult = observeSubmissionInputWrite(
            bytes,
            inputCalls,
          );
          if (submissionResult !== undefined) return submissionResult;
          if (
            seed === "paced-input" &&
            inputCalls > 1 &&
            transportReads === priorInputTransportReads
          )
            throw new Error("testkit.pty.test-input-not-acknowledged");
          priorInputTransportReads = transportReads;
          if (seed === "blocked-input-completion")
            return { status: "would-block" as const, bytesWritten: 0 };
          if (seed === "control-write-substitution" && inputCalls === 1)
            return { status: "would-block" as const, bytesWritten: 0 };
          if (seed === "readiness-burst" && inputCalls === 2) {
            processes.delete(root.pid);
            terminal = true;
            close({ code: 0, signal: 0 });
          }
          if (terminalQueryHandshake && bytes.length === 1 && bytes[0] === 4) {
            processes.clear();
            terminal = true;
            close({ code: 0, signal: 0 });
          }
          if (seed === "partial-input-timeout" && inputCalls === 1) {
            const stopAt = request.monotonicExecutionDeadlineMs + 1;
            while (performance.now() < stopAt) {
              // Deliberately expire the one execution deadline after one write.
            }
          }
          const partial =
            (seed === "partial-input" ||
              seed === "partial-input-output-limit" ||
              seed === "partial-input-timeout") &&
            inputCalls === 1;
          return {
            status: partial ? ("partial" as const) : ("complete" as const),
            bytesWritten: partial
              ? Math.max(1, Math.floor(bytes.length / 2))
              : bytes.length,
          };
        },
      };
    },
  };
};

/** Package-private PTY lifecycle evidence; never a capability mint. */
export const executeSelectedPtyTransportForTest = async (
  request: SelectedPtyExecutionRequest,
  seed: SelectedPtyTestSeed,
  options: HeadlessSupervisorExecutionOptions = {},
): Promise<SelectedPtyExecutionReceipt> => {
  const stable = snapshotPtyRequest(request);
  const capability = safeReflectApply(freeze, Object, [{}]) as object;
  const composition = {
    maximumShutdownDeadlineMs: stable.process.monotonicShutdownDeadlineMs,
    namespaceIdentity: "pid:[synthetic-selected-pty]",
  };
  const runtime = selectedPtyRuntimeForTest(seed, stable.readiness);
  const genericRuntime: SelectedContainerRuntime = {
    assertNamespaceIdentity: runtime.assertNamespaceIdentity,
    listProcesses: runtime.listProcesses,
    readProcess: runtime.readProcess,
    reapAdoptedZombie: runtime.reapAdoptedZombie,
    sendSignal: runtime.sendSignal,
    spawnProcess: () => fail("testkit.headless.kernel.spawn"),
  };
  writeWeakMap(selectedBackendAuthorities, capability, {
    arm: selectedContainerBackend(composition, genericRuntime).arm,
    armPty: (candidate, whenAborted) =>
      armSelectedPty(composition, runtime, candidate, whenAborted),
    kind: "selected-isolation-backend",
  });
  return executeSelectedPtyProcessWithCapability(
    capability as HeadlessSupervisorCapability,
    stable,
    options,
  );
};
