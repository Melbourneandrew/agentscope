import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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
import { Socket } from "node:net";
import { Duplex, PassThrough, Writable } from "node:stream";

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
  pid: number;
  startIdentity: string;
}>;
type ContainerComposition = Readonly<{
  maximumShutdownDeadlineMs: number;
  namespaceIdentity: string;
}>;
type SelectedContainerRuntime = Readonly<{
  assertNamespaceIdentity: (expected: string) => void;
  listProcesses: (namespaceIdentity: string) => readonly ProcessSnapshot[];
  readProcess: (pid: number) => ProcessSnapshot | undefined;
  sendSignal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  spawnProcess: (request: HeadlessExecutionRequest) => ChildProcess;
}>;
type ProcessAuthorityRuntime = Pick<
  SelectedContainerRuntime,
  "assertNamespaceIdentity" | "listProcesses" | "readProcess" | "sendSignal"
>;

const readProcessSnapshot = (pid: number): ProcessSnapshot | undefined => {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 1) return undefined;
    const fields = value
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const start = fields[19];
    if (start === undefined || !/^\d+$/u.test(start)) return undefined;
    return { pid, startIdentity: `${pid}:${start}` };
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

const productionContainerRuntime: SelectedContainerRuntime = {
  assertNamespaceIdentity,
  listProcesses: listContainerProcesses,
  readProcess: readProcessSnapshot,
  sendSignal: (pid, signal) => process.kill(pid, signal),
  spawnProcess: (request) =>
    spawn(request.executable, [...request.arguments], {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }),
};

type PtyExit = Readonly<{ code: number | null; signal: number }>;
type PtyProcess = Readonly<{
  fd: number;
  pid: number;
  stream: Socket;
  closed: Promise<PtyExit>;
}>;
type PtyRuntime = Readonly<{
  assertNamespaceIdentity: (expected: string) => void;
  listProcesses: (namespaceIdentity: string) => readonly ProcessSnapshot[];
  readProcess: (pid: number) => ProcessSnapshot | undefined;
  sendSignal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  spawnPty: (
    request: HeadlessExecutionRequest,
    geometry: Readonly<{ columns: number; rows: number }>,
    witness: string,
  ) => PtyProcess;
}>;
type NativePtyBinding = Readonly<{
  // Mirrors the fixed upstream N-API entry point; callers cannot vary it.
  // eslint-disable-next-line max-params
  fork: (
    executable: string,
    arguments_: readonly string[],
    environment: readonly string[],
    cwd: string,
    columns: number,
    rows: number,
    uid: number,
    gid: number,
    utf8: boolean,
    helperPath: string,
    onExit: (code: number, signal: number) => void,
  ) => Readonly<{ fd: number; pid: number }>;
  resize: (
    fd: number,
    columns: number,
    rows: number,
    xPixel: number,
    yPixel: number,
  ) => void;
}>;
const requireAuthority = createRequire(import.meta.url);
const ptyRuntimeDigest =
  "38966cc64050466dd2b2489cc4e3a94a7c0040361d9ab79115241aeff8eb27de";
const busyboxDigest =
  "01a989eb4d1d04b0d146c790ac536abd88f374ec74a2e110c58910b840d42045";
const hashExactRegularFile = (path: string, expected: string): void => {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    const bytes_ = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      createHash("sha256").update(bytes_).digest("hex") !== expected
    )
      return fail("testkit.pty.runtime.identity");
  } finally {
    closeSync(descriptor);
  }
};
let nativePtyBinding: NativePtyBinding | undefined;
const loadNativePtyBinding = (): NativePtyBinding => {
  if (nativePtyBinding !== undefined) return nativePtyBinding;
  const path = resolve(
    import.meta.dirname,
    "../pty-runtime/node127-linux-x64-musl/pty.node",
  );
  hashExactRegularFile(path, ptyRuntimeDigest);
  hashExactRegularFile("/bin/busybox", busyboxDigest);
  const candidate = requireAuthority(path) as unknown;
  if (
    !plainRecord(candidate) ||
    typeof ownData(candidate, "fork") !== "function" ||
    typeof ownData(candidate, "resize") !== "function"
  )
    return fail("testkit.pty.runtime.identity");
  nativePtyBinding = candidate as NativePtyBinding;
  return nativePtyBinding;
};
const productionPtyRuntime: PtyRuntime = {
  assertNamespaceIdentity,
  listProcesses: listContainerProcesses,
  readProcess: readProcessSnapshot,
  sendSignal: (pid, signal) => process.kill(pid, signal),
  spawnPty: (request, geometry, witness) => {
    const binding = loadNativePtyBinding();
    let resolveClose!: (exit: PtyExit) => void;
    const closed = observeAtCreation(
      new SafePromise<PtyExit>((resolve_) => {
        resolveClose = resolve_;
      }),
    );
    const environment = safeReflectApply(objectKeys, Object, [
      request.environment,
    ]).map((key) => `${key}=${request.environment[key]}`);
    environment.push(`AGENTSCOPE_PTY_WITNESS=${witness}`);
    const bootstrap =
      'if [ ! -t 0 ] || [ ! -t 1 ] || [ ! -t 2 ]; then exit 126; fi; size="$(/bin/busybox stty size)" || exit 125; printf "\\036%s:%s\\037" "$AGENTSCOPE_PTY_WITNESS" "$size"; unset AGENTSCOPE_PTY_WITNESS; exec "$@"';
    const result = binding.fork(
      "/bin/busybox",
      [
        "sh",
        "-c",
        bootstrap,
        "agentscope-pty",
        request.executable,
        ...request.arguments,
      ],
      environment,
      request.cwd,
      geometry.columns,
      geometry.rows,
      -1,
      -1,
      true,
      "",
      (code, signal) => {
        resolveClose({ code, signal });
      },
    );
    if (
      !numberIsSafeInteger(result.fd) ||
      result.fd < 0 ||
      !numberIsSafeInteger(result.pid) ||
      result.pid < 2
    )
      return fail("testkit.headless.kernel.spawn");
    return {
      fd: result.fd,
      pid: result.pid,
      stream: new Socket({
        allowHalfOpen: true,
        fd: result.fd,
        readable: true,
        writable: true,
      }),
      closed,
    };
  },
};

const snapshotPtyRequest = (
  candidate: SelectedPtyExecutionRequest,
): SelectedPtyExecutionRequest => {
  if (!plainRecord(candidate)) return fail("testkit.pty.request");
  const keys = safeReflectApply(objectKeys, Object, [candidate]).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "initialGeometry" ||
    keys[1] !== "process"
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
  return safeReflectApply(freeze, Object, [
    {
      process: process_,
      initialGeometry: safeReflectApply(freeze, Object, [{ columns, rows }]),
    },
  ]) as SelectedPtyExecutionRequest;
};

const ptySignal = (signal: number): "SIGTERM" | "SIGKILL" | null =>
  signal === 15 ? "SIGTERM" : signal === 9 ? "SIGKILL" : null;

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
    runtime.assertNamespaceIdentity(composition.namespaceIdentity);
    if (
      safeReflectApply(performanceNow, performance, []) >=
      processRequest.monotonicStartupDeadlineMs
    )
      return fail("testkit.headless.startup.deadline");
    const witness = randomUUID();
    const expectedWitness = safeBufferFrom(
      `\u001e${witness}:${request.initialGeometry.rows} ${request.initialGeometry.columns}\u001f`,
    );
    const child = runtime.spawnPty(
      processRequest,
      request.initialGeometry,
      witness,
    );
    let transportError = false;
    let resolveTransportClose!: () => void;
    const transportClose = observeAtCreation(
      new SafePromise<void>((resolve_) => {
        resolveTransportClose = resolve_;
      }),
    );
    child.stream.once("close", resolveTransportClose);
    child.stream.once("error", () => {
      transportError = true;
      resolveTransportClose();
    });
    const root = runtime.readProcess(child.pid);
    if (root === undefined) {
      child.stream.destroy();
      await boundedInvoke(
        () =>
          SafePromise.all([child.closed, transportClose]).then(() => undefined),
        processRequest.monotonicShutdownDeadlineMs,
        "testkit.headless.reconciliation.deadline",
      );
      return fail("testkit.headless.observer.root");
    }
    const observed = new Map<string, ProcessSnapshot>([
      [root.startIdentity, root],
    ]);
    const signals: HeadlessObservedSignal[] = [];
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    const outputLimitBytes = minimum(
      processRequest.stdoutLimitBytes,
      processRequest.stderrLimitBytes,
    );
    let witnessBytes = safeBufferFrom([]);
    let witnessAccepted = false;
    let outputLimited = false;
    let inputJoined = false;
    let aborted = false;
    const terminal = new BoundedTerminalEmulator(request.initialGeometry, {
      ...defaultPtyTerminalEmulatorLimits,
      maximumOutputBytes: outputLimitBytes,
    });
    child.stream.on("data", (candidate: unknown) => {
      const incoming = Buffer.isBuffer(candidate)
        ? candidate
        : safeBufferFrom(candidate as Uint8Array);
      let remainingBytes = incoming;
      if (!witnessAccepted) {
        const required = expectedWitness.length - witnessBytes.length;
        witnessBytes = safeBufferConcat([
          witnessBytes,
          incoming.subarray(0, maximum(0, minimum(required, incoming.length))),
        ]);
        remainingBytes = incoming.subarray(minimum(required, incoming.length));
        if (
          !expectedWitness.subarray(0, witnessBytes.length).equals(witnessBytes)
        ) {
          transportError = true;
          return;
        }
        if (witnessBytes.length === expectedWitness.length) {
          witnessAccepted = true;
          const stdin = safeBufferConcat([
            safeBufferFrom(processRequest.stdin),
            safeBufferFrom([4]),
          ]);
          child.stream.write(stdin, () => {
            inputJoined = true;
          });
        }
      }
      if (!witnessAccepted || remainingBytes.length === 0) return;
      const available = maximum(0, outputLimitBytes - outputBytes);
      const captured = remainingBytes.subarray(
        0,
        minimum(available, remainingBytes.length),
      );
      if (captured.length > 0) {
        outputBytes += captured.length;
        chunks.push(safeBufferFrom(captured));
      }
      if (remainingBytes.length > available) outputLimited = true;
      try {
        if (captured.length > 0) terminal.write(new SafeUint8Array(captured));
      } catch {
        outputLimited = true;
      }
    });
    void safeReflectApply(promiseThen, whenAborted, [
      () => {
        aborted = true;
      },
    ]);
    let exit: PtyExit | undefined;
    let trigger: "closed" | "failure" | "timeout" | "aborted" | undefined;
    while (trigger === undefined) {
      for (const process_ of runtime.listProcesses(
        composition.namespaceIdentity,
      ))
        observed.set(process_.startIdentity, process_);
      const closed = await Promise.race([
        terminalOf(child.closed),
        delay(containerPollMilliseconds).then(() => undefined),
      ]);
      if (closed !== undefined) {
        if (!closed.ok) return fail("testkit.headless.kernel.spawn");
        exit = closed.value;
        trigger = "closed";
      } else if (transportError || outputLimited) trigger = "failure";
      else if (aborted) trigger = "aborted";
      else if (
        safeReflectApply(performanceNow, performance, []) >=
        processRequest.monotonicExecutionDeadlineMs
      )
        trigger = "timeout";
    }
    const termTargets = runtime
      .listProcesses(composition.namespaceIdentity)
      .filter((identity) => runtime.readProcess(identity.pid) !== undefined);
    if (
      trigger !== "closed" ||
      termTargets.some(({ pid }) => pid !== child.pid)
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
      processRequest.monotonicShutdownDeadlineMs,
      safeReflectApply(performanceNow, performance, []) +
        processRequest.terminationGraceMs,
    );
    while (
      safeReflectApply(performanceNow, performance, []) < graceDeadline &&
      runtime.listProcesses(composition.namespaceIdentity).length > 0
    )
      await delay(containerPollMilliseconds);
    for (const identity of runtime.listProcesses(composition.namespaceIdentity))
      signalExactProcess(
        identity,
        "SIGKILL",
        signals,
        composition.namespaceIdentity,
        runtime,
      );
    while (
      safeReflectApply(performanceNow, performance, []) <
        processRequest.monotonicShutdownDeadlineMs &&
      runtime.listProcesses(composition.namespaceIdentity).length > 0
    )
      await delay(containerPollMilliseconds);
    const residual = runtime.listProcesses(composition.namespaceIdentity);
    if (exit === undefined)
      exit = await boundedInvoke(
        () => child.closed,
        processRequest.monotonicShutdownDeadlineMs,
        "testkit.headless.reconciliation.deadline",
      );
    child.stream.destroy();
    await boundedInvoke(
      () => transportClose,
      processRequest.monotonicShutdownDeadlineMs,
      "testkit.headless.reconciliation.deadline",
    );
    if (!witnessAccepted) return fail("testkit.pty.geometry");
    if (transportError) return fail("testkit.pty.transport");
    const clean = residual.length === 0 && inputJoined;
    const output = safeBufferConcat(chunks, outputBytes);
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
          observedGeometry: request.initialGeometry,
          outputBytes,
          outputSha256: createHash("sha256").update(output).digest("hex"),
          finalSnapshot: terminal.end(),
          exitCode: outputLimited || trigger === "timeout" ? null : exit.code,
          signal:
            outputLimited || trigger === "timeout"
              ? signals.some(({ signal }) => signal === "SIGKILL")
                ? "SIGKILL"
                : "SIGTERM"
              : ptySignal(exit.signal),
          cleanup: clean
            ? "clean"
            : residual.length > 0
              ? "residual"
              : "uncertain",
          residualProcessCount: residual.length,
          processJoined: residual.length === 0,
          terminalInputJoined: inputJoined,
          terminalOutputJoined: true,
          terminalTransportClosed: true,
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
  runtime: SelectedContainerRuntime = productionContainerRuntime,
  // The backend closes one lifecycle across launch, streams, signals and join.
  // eslint-disable-next-line max-lines-per-function
): SelectedIsolationBackendAuthority => ({
  kind: "selected-isolation-backend",
  armPty: (request, whenAborted) =>
    armSelectedPty(composition, productionPtyRuntime, request, whenAborted),
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
      runtime.assertNamespaceIdentity(composition.namespaceIdentity);
      if (
        safeReflectApply(performanceNow, performance, []) >=
        request.monotonicStartupDeadlineMs
      )
        return fail("testkit.headless.startup.deadline");
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
      const termTargets = [...observed.values()].filter(
        (identity) => runtime.readProcess(identity.pid) !== undefined,
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
      )
        await delay(containerPollMilliseconds);
      for (const identity of runtime.listProcesses(
        composition.namespaceIdentity,
      )) {
        observed.set(identity.startIdentity, identity);
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
      )
        await delay(containerPollMilliseconds);
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
            ...identity,
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
): HeadlessSupervisorCapability => {
  if (
    selectedContainerCompositionConsumed ||
    process.platform !== "linux" ||
    process.pid !== 1 ||
    !finiteNumber(maximumShutdownDeadlineMs) ||
    maximumShutdownDeadlineMs <=
      safeReflectApply(performanceNow, performance, []) ||
    readlinkSync("/proc/self/ns/pid") !== readlinkSync("/proc/1/ns/pid")
  )
    return fail("testkit.headless.capability");
  selectedContainerCompositionConsumed = true;
  const capability = safeReflectApply(freeze, Object, [{}]) as object;
  writeWeakMap(
    selectedBackendAuthorities,
    capability,
    selectedContainerBackend({
      maximumShutdownDeadlineMs,
      namespaceIdentity: readlinkSync("/proc/self/ns/pid"),
    }),
  );
  return capability as HeadlessSupervisorCapability;
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
): void => {
  if (
    receipt.runId !== request.process.runId ||
    receipt.requestFingerprint !== request.process.requestFingerprint ||
    receipt.initialGeometry.columns !== request.initialGeometry.columns ||
    receipt.initialGeometry.rows !== request.initialGeometry.rows ||
    receipt.observedGeometry.columns !== request.initialGeometry.columns ||
    receipt.observedGeometry.rows !== request.initialGeometry.rows ||
    receipt.isTTY !== true ||
    receipt.cleanup !== "clean" ||
    !receipt.processJoined ||
    !receipt.terminalInputJoined ||
    !receipt.terminalOutputJoined ||
    !receipt.terminalTransportClosed ||
    receipt.residualProcessCount !== 0
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
  | "abort"
  | "clean"
  | "descendant"
  | "fast-exit"
  | "identity-substitution"
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
  const root: ProcessSnapshot = { pid: 41_001, startIdentity: "41001:1" };
  const descendant: ProcessSnapshot = {
    pid: 41_002,
    startIdentity: "41002:1",
  };
  const processes = new Map<number, ProcessSnapshot>([[root.pid, root]]);
  let child: (ChildProcess & EventEmitter) | undefined;
  let fakeStdout: PassThrough | undefined;
  let fakeStderr: PassThrough | undefined;
  let closed = false;
  let rootReads = 0;
  let infiniteTimer: NodeJS.Timeout | undefined;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closed || child === undefined) return;
    closed = true;
    if (infiniteTimer !== undefined) safeClearInterval(infiniteTimer);
    processes.delete(root.pid);
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
        } else if (seed === "descendant" || seed === "surviving-descendant") {
          processes.set(descendant.pid, descendant);
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
  | "clean"
  | "geometry-substitution"
  | "identity-substitution"
  | "missing-witness"
  | "output-limit"
  | "residual"
  | "root-missing"
  | "timeout";

const selectedPtyRuntimeForTest = (seed: SelectedPtyTestSeed): PtyRuntime => {
  const root: ProcessSnapshot = { pid: 42_001, startIdentity: "42001:1" };
  const descendant: ProcessSnapshot = {
    pid: 42_002,
    startIdentity: "42002:1",
  };
  const processes = new Map<number, ProcessSnapshot>([[root.pid, root]]);
  let reads = 0;
  let resolveClose: ((value: PtyExit) => void) | undefined;
  return {
    assertNamespaceIdentity: (expected) => {
      if (expected !== "pid:[synthetic-selected-pty]")
        return fail("testkit.headless.observer.identity");
    },
    listProcesses: () => [...processes.values()],
    readProcess: (pid) => {
      if (seed === "root-missing") return undefined;
      const value = processes.get(pid);
      if (value === undefined) return undefined;
      reads += pid === root.pid ? 1 : 0;
      return seed === "identity-substitution" && reads > 1
        ? { ...value, startIdentity: "42001:2" }
        : value;
    },
    sendSignal: (pid, signal) => {
      if (seed === "residual" && pid === descendant.pid) return;
      processes.delete(pid);
      if (pid === root.pid)
        resolveClose?.({ code: null, signal: signal === "SIGKILL" ? 9 : 15 });
    },
    spawnPty: (request, geometry, witness) => {
      let close!: (value: PtyExit) => void;
      const closed = observeAtCreation(
        new SafePromise<PtyExit>((resolve_) => {
          close = resolve_;
          resolveClose = resolve_;
        }),
      );
      const stream = new Duplex({
        read() {
          // Synthetic output is pushed below; writes are consumed as stdin.
        },
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      queueMicrotask(() => {
        const rows =
          seed === "geometry-substitution" ? geometry.rows + 1 : geometry.rows;
        const prefix =
          seed === "missing-witness"
            ? "not-a-tty"
            : `\u001e${witness}:${rows} ${geometry.columns}\u001f`;
        stream.push(
          safeBufferFrom(
            `${prefix}${seed === "output-limit" ? "x".repeat(request.stdoutLimitBytes + 1) : "ready"}`,
          ),
        );
        if (seed === "residual") processes.set(descendant.pid, descendant);
        if (seed !== "timeout" && seed !== "identity-substitution")
          safeSetTimeout(() => {
            processes.delete(root.pid);
            stream.push(null);
            close({ code: 0, signal: 0 });
          }, 5);
      });
      return {
        closed,
        fd: 72,
        pid: root.pid,
        stream: stream as unknown as Socket,
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
  writeWeakMap(selectedBackendAuthorities, capability, {
    arm: selectedContainerBackend(composition).arm,
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
