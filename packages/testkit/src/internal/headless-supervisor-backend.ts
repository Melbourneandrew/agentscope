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
  validatePtyTerminalSemanticSnapshot,
} from "../bounded-terminal-emulator.js";
import type {
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
    argumentsSnapshot[index] = value;
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
  sendSignal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
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
    facts.groups.some((group) => group !== 1000)
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
  if (lines.length < 1 || lines.some((line) => line.length < 1))
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
        pending.push(path);
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
    if (snapshot !== undefined) snapshots.push(snapshot);
  }
  return snapshots.sort((left, right) => left.pid - right.pid);
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
      state.chunks.push(safeBufferFrom(selected));
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
  ledger.push({
    monotonicAtMs: safeReflectApply(performanceNow, performance, []),
    signal,
    targetStartIdentity: identity.startIdentity,
  });
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
  listProcesses: (namespaceIdentity: string) => readonly ProcessSnapshot[];
  readProcess: (pid: number) => ProcessSnapshot | undefined;
  reapAdoptedZombie: (
    pid: number,
    startIdentity: string,
    rootPid: number,
    monotonicDeadlineNs: bigint,
  ) => AdoptedZombieReapReceipt;
  sendSignal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
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
const ptyRuntimeDigest =
  "e9890723d24f4fd4480faf2dbc83cf6809f66e6a5cdf9ba19eade1ca9c7e94ab";
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
  const path = resolve(
    import.meta.dirname,
    "../pty-runtime/node127-linux-x64-musl/pty.node",
  );
  const descriptor = openAuthenticatedRegularFile(
    path,
    ptyRuntimeDigest,
    1024 * 1024,
    authority.assertFile,
  );
  let candidate: unknown;
  try {
    authority.assertRuntime();
    assertAuthenticatedRegularFileDescriptor(
      descriptor,
      path,
      ptyRuntimeDigest,
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
  // eslint-disable-next-line complexity
): SelectedPtyExecutionRequest => {
  if (!plainRecord(candidate)) return fail("testkit.pty.request");
  const keys = safeReflectApply(objectKeys, Object, [candidate]).sort();
  if (
    keys.length !== 5 ||
    keys[0] !== "completion" ||
    keys[1] !== "initialGeometry" ||
    keys[2] !== "interpreter" ||
    keys[3] !== "process" ||
    keys[4] !== "scriptSha256"
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
  const completion = ownData(candidate, "completion");
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
  return safeReflectApply(freeze, Object, [
    {
      process: process_,
      completion: safeReflectApply(freeze, Object, [{ ...completion }]),
      initialGeometry: safeReflectApply(freeze, Object, [{ columns, rows }]),
      interpreter: safeReflectApply(freeze, Object, [
        { path: interpreterPath, sha256: interpreterSha256 },
      ]),
      scriptSha256,
    },
  ]) as SelectedPtyExecutionRequest;
};

const ptySignal = (signal: number): "SIGTERM" | "SIGKILL" | null =>
  signal === 15 ? "SIGTERM" : signal === 9 ? "SIGKILL" : null;

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
): PtyTerminalObservation => {
  if (
    !plainRecord(value) ||
    safeReflectApply(objectKeys, Object, [value]).sort().join("\0") !==
      "canonical\0columns\0eofByte\0isTTY\0rows" ||
    ownData(value, "isTTY") !== true ||
    ownData(value, "canonical") !== true ||
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
        );
      }
    } catch (error) {
      primaryFailure = trustedErrorCode(error) ?? "testkit.pty.transport";
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
    let eofAttempted = false;
    let eofByteWritten = false;
    let outputTerminal = false;
    let transportClosed: boolean;
    let aborted = false;
    const terminal = new BoundedTerminalEmulator(request.initialGeometry, {
      ...defaultPtyTerminalEmulatorLimits,
      maximumOutputBytes: outputLimitBytes,
    });
    const input = safeBufferFrom(processRequest.stdin);
    const pumpTransport = (allowInput: boolean): void => {
      try {
        if (
          allowInput &&
          primaryFailure === undefined &&
          !eofByteWritten &&
          inputOffset < input.length
        ) {
          const pending = input.subarray(inputOffset);
          const written = exactPtyWrite(child.write(pending), pending.length);
          inputOffset += written.bytesWritten;
        }
        if (
          allowInput &&
          primaryFailure === undefined &&
          !eofAttempted &&
          inputOffset === input.length
        ) {
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
        }
        for (let index = 0; index < 64 && !outputTerminal; index += 1) {
          const observation = exactPtyRead(child.read(4_096));
          if (observation.status === "would-block") break;
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
            outputBytes += captured.length;
            chunks.push(captured);
            terminal.write(new SafeUint8Array(captured));
          }
          if (observation.bytes.length > captured.length) {
            outputLimited = true;
            try {
              terminal.write(
                new SafeUint8Array(
                  observation.bytes.subarray(
                    captured.length,
                    captured.length + 1,
                  ),
                ),
              );
            } catch {
              // The canonical emulator records the output-limit state first.
            }
            break;
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
      if (trigger === undefined) pumpTransport(true);
      if (transportError || outputLimited) trigger = "failure";
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
      termTargets.some(({ pid }) => pid !== child.pid)
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
    if (exit.signal !== 0 && exit.signal !== 9 && exit.signal !== 15)
      return fail("testkit.pty.transport");
    const inputJoined = inputOffset === input.length && eofByteWritten;
    const clean = residual.length === 0 && outputTerminal && transportClosed;
    const output = safeBufferConcat(chunks, outputBytes);
    const outputSha256 = createHash("sha256").update(output).digest("hex");
    const finalSnapshot = terminal.end();
    const exactOutputCompleted =
      request.completion.kind === "exact-output" &&
      request.completion.outputBytes === outputBytes &&
      request.completion.outputSha256 === outputSha256;
    if (
      !outputLimited &&
      (finalSnapshot.semanticState === "credential-prompt" ||
        finalSnapshot.semanticState === "malformed-control" ||
        ((trigger === "closed" || trigger === undefined) &&
          finalSnapshot.semanticState !== "completed" &&
          !exactOutputCompleted))
    )
      return fail("testkit.pty.transport");
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
          requestFingerprint: processRequest.requestFingerprint,
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
        termTargets.some(({ pid }) => pid !== childPid)
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
          termRequested: signals.some(({ signal }) => signal === "SIGTERM"),
          killRequested: signals.some(({ signal }) => signal === "SIGKILL"),
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

const assertPtyReceiptBinding = (
  receipt: SelectedPtyExecutionReceipt,
  request: SelectedPtyExecutionRequest,
  // eslint-disable-next-line complexity
): void => {
  const outcome = receipt.outcome;
  if (
    receipt.receiptVersion !== 1 ||
    receipt.runId !== request.process.runId ||
    receipt.requestFingerprint !== request.process.requestFingerprint ||
    receipt.initialGeometry.columns !== request.initialGeometry.columns ||
    receipt.initialGeometry.rows !== request.initialGeometry.rows ||
    receipt.observedGeometry.columns !== request.initialGeometry.columns ||
    receipt.observedGeometry.rows !== request.initialGeometry.rows ||
    receipt.isTTY !== true ||
    receipt.observedCanonicalMode !== true ||
    !boundedNonnegativeInteger(receipt.eofByte, 255) ||
    typeof receipt.eofByteWritten !== "boolean" ||
    !boundedNonnegativeInteger(
      receipt.inputBytesWritten,
      request.process.stdin.byteLength,
    ) ||
    (outcome !== "completed" &&
      outcome !== "exited-nonzero" &&
      outcome !== "aborted" &&
      outcome !== "timeout" &&
      outcome !== "output-limit" &&
      outcome !== "transport-failed" &&
      outcome !== "input-incomplete") ||
    !boundedNonnegativeInteger(
      receipt.outputBytes,
      minimum(
        request.process.stdoutLimitBytes,
        request.process.stderrLimitBytes,
      ),
    ) ||
    !/^[a-f0-9]{64}$/u.test(receipt.outputSha256) ||
    receipt.cleanup !== "clean" ||
    !receipt.processJoined ||
    !receipt.terminalOutputJoined ||
    !receipt.terminalTransportClosed ||
    (receipt.signal !== null &&
      receipt.signal !== "SIGTERM" &&
      receipt.signal !== "SIGKILL") ||
    receipt.residualProcessCount !== 0
  )
    return fail("testkit.pty.receipt");
  let finalSnapshot;
  try {
    finalSnapshot = validatePtyTerminalSemanticSnapshot(receipt.finalSnapshot);
  } catch {
    return fail("testkit.pty.receipt");
  }
  if (
    (outcome === "output-limit") !==
    (finalSnapshot.semanticState === "output-limit")
  )
    return fail("testkit.pty.receipt");
  if (
    outcome === "completed" &&
    finalSnapshot.semanticState !== "completed" &&
    (request.completion.kind !== "exact-output" ||
      request.completion.outputBytes !== receipt.outputBytes ||
      request.completion.outputSha256 !== receipt.outputSha256)
  )
    return fail("testkit.pty.receipt");
  if (
    (receipt.outcome === "completed" || receipt.outcome === "exited-nonzero") &&
    (!receipt.eofByteWritten ||
      receipt.inputBytesWritten !== request.process.stdin.byteLength ||
      !receipt.terminalInputJoined)
  )
    return fail("testkit.pty.receipt");
  if (
    (receipt.outcome === "completed" &&
      (receipt.exitCode !== 0 || receipt.signal !== null)) ||
    (receipt.outcome === "exited-nonzero" &&
      (!boundedInteger(receipt.exitCode, 255) || receipt.signal !== null)) ||
    (receipt.outcome !== "completed" &&
      receipt.outcome !== "exited-nonzero" &&
      receipt.exitCode !== null)
  )
    return fail("testkit.pty.receipt");
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
  | "adopted-zombie-reap-failure"
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
      processes.delete(pid);
      if (seed === "adopted-zombie-already-absent")
        return { pid, startIdentity, status: "already-absent" };
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
          seed === "adopted-zombie-reap-failure" ||
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
  | "adopted-zombie"
  | "clean"
  | "close-failure"
  | "descriptor-closure"
  | "descriptor-reuse"
  | "descriptor-substitution"
  | "eof-failure"
  | "fragmented-output"
  | "geometry-substitution"
  | "identity-substitution"
  | "immutable-capability"
  | "immutable-device-inode"
  | "immutable-mount-id"
  | "immutable-mount-rw"
  | "immutable-no-new-privileges"
  | "immutable-principal"
  | "immutable-symlink"
  | "late-tail"
  | "kill-escalation"
  | "credential-prompt"
  | "malformed-control"
  | "malformed-exit"
  | "mode-substitution"
  | "nonzero-exit"
  | "observer-failure"
  | "output-limit"
  | "partial-input"
  | "partial-input-output-limit"
  | "partial-input-timeout"
  | "residual"
  | "root-missing"
  | "signal-failure"
  | "startup-delay"
  | "transport-failure"
  | "timeout"
  | "unsupported-signal";

// eslint-disable-next-line max-lines-per-function
const selectedPtyRuntimeForTest = (seed: SelectedPtyTestSeed): PtyRuntime => {
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
  const processes = new Map<number, ProcessSnapshot>([[root.pid, root]]);
  let reads = 0;
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
    listProcesses: () => {
      if (seed === "observer-failure")
        return fail("testkit.headless.observer.read");
      return [...processes.values()];
    },
    readProcess: (pid) => {
      if (seed === "root-missing") return undefined;
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
        resolveClose?.({ code: 0, signal: signal === "SIGKILL" ? 9 : 15 });
      }
    },
    // eslint-disable-next-line max-lines-per-function
    spawnPty: (request, geometry, interpreter, scriptSha256) => {
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
          : seed === "active-terminal"
            ? safeBufferFrom("ready")
            : seed === "credential-prompt"
              ? safeBufferFrom("Password:")
              : seed === "malformed-control"
                ? safeBufferFrom("\u001b[")
                : safeBufferFrom("AGENTSCOPE_PTY_COMPLETE");
      const chunks =
        seed === "fragmented-output"
          ? [output.subarray(0, 2), output.subarray(2)]
          : seed === "output-limit" || seed === "partial-input-output-limit"
            ? [output.subarray(0, 4_096), output.subarray(4_096)]
            : [output];
      let chunkIndex = 0;
      let inputCalls = 0;
      queueMicrotask(() => {
        if (seed === "residual" || seed === "adopted-zombie")
          processes.set(descendant.pid, descendant);
        if (
          seed !== "timeout" &&
          seed !== "identity-substitution" &&
          seed !== "output-limit" &&
          seed !== "partial-input-output-limit" &&
          seed !== "partial-input-timeout" &&
          seed !== "kill-escalation" &&
          seed !== "signal-failure"
        )
          safeSetTimeout(
            () => {
              processes.delete(root.pid);
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
                    ? { code: 0, signal: 2 }
                    : {
                        code: seed === "nonzero-exit" ? 7 : 0,
                        signal: 0,
                      },
              );
            },
            seed === "partial-input" ? 25 : 5,
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
          return {
            status: "eof-byte-written" as const,
            canonical: true as const,
            eofByte: 4,
            bytesWritten: 1 as const,
          };
        },
        inspect: () => ({
          isTTY: true,
          canonical: seed !== "mode-substitution",
          columns: geometry.columns,
          rows:
            seed === "geometry-substitution"
              ? geometry.rows + 1
              : geometry.rows,
          eofByte: 4,
        }),
        read: () => {
          if (seed === "transport-failure")
            return fail("testkit.pty.transport");
          if (
            seed === "late-tail" &&
            (!terminal || performance.now() < tailReadyAt)
          )
            return { status: "would-block" as const };
          const chunk = chunks[chunkIndex];
          if (chunk !== undefined) {
            chunkIndex += 1;
            return { status: "data" as const, bytes: chunk };
          }
          return terminal
            ? { status: "eio" as const }
            : { status: "would-block" as const };
        },
        resize: () => undefined,
        write: (bytes) => {
          inputCalls += 1;
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
  const runtime = selectedPtyRuntimeForTest(seed);
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
