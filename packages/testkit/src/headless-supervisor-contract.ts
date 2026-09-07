import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isProxy } from "node:util/types";

const SafeArray = Array;
const safeArrayIsArray = Array.isArray;
const safeArrayPrototype = Array.prototype;
const SafeUint8Array = Uint8Array;
const safeUint8ArrayPrototype = Uint8Array.prototype;
const safeTypedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const safeArrayBufferPrototype = ArrayBuffer.prototype;
const safeObjectPrototype = Object.prototype;
const safeObjectCreate = Object.create;
const safeObjectDefineProperty = Object.defineProperty;
const safeObjectFreeze = Object.freeze;
const safeObjectSetPrototypeOf = Object.setPrototypeOf;
const safeGetPrototypeOf = Object.getPrototypeOf;
const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const safeGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const safeObjectHasOwn = Object.hasOwn;
const safeObjectKeys = Object.keys;
const safeReflectApply = Reflect.apply;
const safeReflectOwnKeys = Reflect.ownKeys;
const safeIsProxy = isProxy;
const safeJsonParse = JSON.parse;
const safeJsonStringify = JSON.stringify;
const safeNumberIsFinite = Number.isFinite;
const safeNumberIsSafeInteger = Number.isSafeInteger;
const safeExecPath = process.execPath;
const safeTypedArraySetDescriptor = Object.getOwnPropertyDescriptor(
  safeTypedArrayPrototype,
  "set",
)!;
const safeTypedArrayBufferDescriptor = Object.getOwnPropertyDescriptor(
  safeTypedArrayPrototype,
  "buffer",
)!;
const safeTypedArrayByteLengthDescriptor = Object.getOwnPropertyDescriptor(
  safeTypedArrayPrototype,
  "byteLength",
)!;
const safeTypedArrayByteOffsetDescriptor = Object.getOwnPropertyDescriptor(
  safeTypedArrayPrototype,
  "byteOffset",
)!;
const safeArrayBufferResizableDescriptor = Object.getOwnPropertyDescriptor(
  safeArrayBufferPrototype,
  "resizable",
);
const safeTextEncoderEncodeDescriptor = Object.getOwnPropertyDescriptor(
  TextEncoder.prototype,
  "encode",
)!;
const safeTextDecoderDecodeDescriptor = Object.getOwnPropertyDescriptor(
  TextDecoder.prototype,
  "decode",
)!;
const safePerformanceNowDescriptor = Object.getOwnPropertyDescriptor(
  safeGetPrototypeOf(performance) as object,
  "now",
)!;
const hashPrototype = safeGetPrototypeOf(createHash("sha256")) as object;
const safeHashUpdateDescriptor = Object.getOwnPropertyDescriptor(
  hashPrototype,
  "update",
)!;
const safeHashDigestDescriptor = Object.getOwnPropertyDescriptor(
  hashPrototype,
  "digest",
)!;
const callDescriptorGetter = (
  descriptor: PropertyDescriptor,
  receiver: object,
): unknown => {
  // The captured getter is deliberately invoked with its receiver by Reflect.apply.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  return safeReflectApply(descriptor.get!, receiver, []);
};
const callDescriptorMethod = (
  descriptor: PropertyDescriptor,
  receiver: object,
  arguments_: readonly unknown[],
): unknown =>
  safeReflectApply(
    descriptor.value as (...values: unknown[]) => unknown,
    receiver,
    arguments_,
  );
const safeFreeze = <T extends object>(value: T): Readonly<T> =>
  safeReflectApply(safeObjectFreeze, Object, [value]) as Readonly<T>;
const wireArray = <T>(length: number): T[] => {
  const value = new SafeArray<T>(length);
  safeReflectApply(safeObjectSetPrototypeOf, Object, [value, null]);
  return value;
};
const wireRecord = (
  entries: readonly (readonly [string, unknown])[],
): StrictRecord => {
  const value = safeObjectCreate(null) as StrictRecord;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    value[entry[0]] = entry[1];
  }
  return value;
};

export class HeadlessSupervisorContractAssertionError extends Error {
  public readonly code!: string;

  public constructor(code: string) {
    super(code);
    safeReflectApply(safeObjectDefineProperty, Object, [
      this,
      "code",
      {
        configurable: false,
        enumerable: true,
        value: code,
        writable: false,
      },
    ]);
  }
}

export type HeadlessObserverScenario =
  "correct" | "stdout-limit" | "stderr-limit" | "timeout" | "descendant";

export type HeadlessExecutionRequest = Readonly<{
  runId: string;
  requestFingerprint: string;
  executable: string;
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  stdin: Uint8Array;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  monotonicStartupDeadlineMs: number;
  monotonicExecutionDeadlineMs: number;
  monotonicShutdownDeadlineMs: number;
  terminationGraceMs: number;
}>;

export type HeadlessExecutionOutcome =
  "exited" | "output-limit" | "timed-out" | "cleanup-failed";

export type HeadlessExecutionDiagnosticCode =
  | "testkit.headless.output-limit"
  | "testkit.headless.timeout"
  | "testkit.headless.cleanup";

export type HeadlessExecutionResult = Readonly<{
  resultVersion: 1;
  outcome: HeadlessExecutionOutcome;
  exitCode: number | null;
  signal: "SIGTERM" | "SIGKILL" | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  termRequested: boolean;
  killRequested: boolean;
  cleanup: "clean" | "residual" | "uncertain";
  residualProcessCount: number;
  diagnosticCode: HeadlessExecutionDiagnosticCode | null;
}>;

export type HeadlessProcessIdentity = Readonly<{
  pid: number;
  startIdentity: string;
  role: "root" | "descendant";
}>;

export type HeadlessObservedSignal = Readonly<{
  signal: "SIGTERM" | "SIGKILL";
  targetStartIdentity: string;
  monotonicAtMs: number;
}>;

export type HeadlessProcessSetObservation = Readonly<{
  observationVersion: 1;
  runId: string;
  requestFingerprint: string;
  processes: readonly HeadlessProcessIdentity[];
  signals: readonly HeadlessObservedSignal[];
  spawnedAtMs: number;
  readyAtMs: number;
  settledAtMs: number;
  processJoined: boolean;
  stdinJoined: boolean;
  stdoutJoined: boolean;
  stderrJoined: boolean;
  cleanup: "clean" | "residual" | "uncertain";
  residualStartIdentities: readonly string[];
}>;

export type HeadlessExecutionTrace = Readonly<{
  traceVersion: 1;
  runId: string;
  requestFingerprint: string;
  returnedAtMs: number;
  result: HeadlessExecutionResult;
  observation: HeadlessProcessSetObservation;
}>;

export type HeadlessCanonicalTraceEnvelope = Uint8Array;

export type HeadlessSupervisorContractRun = Readonly<{
  request: HeadlessExecutionRequest;
  encode: (trace: unknown) => HeadlessCanonicalTraceEnvelope;
  verify: (encodedTrace: unknown) => HeadlessExecutionTrace;
}>;

export type HeadlessSupervisorContractCase = Readonly<{
  name: string;
  fixtureSource: string;
  instantiate: (
    input: Readonly<{
      root: string;
      fixturePath: string;
    }>,
  ) => HeadlessSupervisorContractRun;
}>;

export type HostileHeadlessProcessSeed =
  | "crash-before-lifecycle"
  | "crash-after-lifecycle"
  | "partial-output"
  | "malformed-output"
  | "oversized-output"
  | "infinite-output"
  | "ignored-termination"
  | "delayed-startup"
  | "delayed-shutdown"
  | "surviving-descendant"
  | "restricted-environment"
  | "missing-hook-record"
  | "duplicate-hook-record"
  | "signal-race"
  | "observation-race";

export type HostileHeadlessProcessCase = Readonly<{
  name: string;
  seed: HostileHeadlessProcessSeed;
  terminal:
    | Readonly<{
        kind: "trace";
        outcome: HeadlessExecutionOutcome;
        exitCode: number | null;
        diagnosticCode: HeadlessExecutionDiagnosticCode | null;
      }>
    | Readonly<{ kind: "error"; code: string }>;
  evidenceAuthority: "component-only";
}>;

type StrictRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const encodeText = (value: string): Uint8Array =>
  callDescriptorMethod(safeTextEncoderEncodeDescriptor, encoder, [
    value,
  ]) as Uint8Array;
const decodeText = (value: Uint8Array): string =>
  callDescriptorMethod(safeTextDecoderDecodeDescriptor, decoder, [
    value,
  ]) as string;
const outputLimitBytes = 1_024;
// Two 1 KiB streams require at most 8 KiB as comma-delimited decimal bytes;
// the remaining fixed two-process/two-signal schema is bounded below 8 KiB.
export const headlessTraceEnvelopeLimitBytes = 16_384;
const terminationGraceMs = 1_000;
// Test-stimulus readiness only; this is not a product or containment deadline.
const descendantDiscoveryWindowMs = 1_500;
const resultKeys = [
  "cleanup",
  "diagnosticCode",
  "exitCode",
  "killRequested",
  "outcome",
  "residualProcessCount",
  "resultVersion",
  "signal",
  "stderr",
  "stderrTruncated",
  "stdout",
  "stdoutTruncated",
  "termRequested",
] as const;
const observationKeys = [
  "cleanup",
  "observationVersion",
  "processJoined",
  "processes",
  "readyAtMs",
  "requestFingerprint",
  "residualStartIdentities",
  "runId",
  "settledAtMs",
  "signals",
  "spawnedAtMs",
  "stderrJoined",
  "stdinJoined",
  "stdoutJoined",
] as const;
const traceKeys = [
  "observation",
  "requestFingerprint",
  "result",
  "returnedAtMs",
  "runId",
  "traceVersion",
] as const;

const fixtures: Readonly<Record<HeadlessObserverScenario, string>> = safeFreeze(
  {
    correct: String.raw`
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const environment = { AGENTSCOPE_ORACLE_VISIBLE: process.env.AGENTSCOPE_ORACLE_VISIBLE };
const unexpectedEnvironmentCount = Object.keys(process.env).filter((key) => key !== "AGENTSCOPE_ORACLE_VISIBLE" && !(process.platform === "darwin" && key === "__CF_USER_TEXT_ENCODING")).length;
process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd(), environment, input, unexpectedEnvironmentCount }));
process.stderr.write("fixture-stderr");
`,
    "stdout-limit":
      'process.stdout.write("O".repeat(4096)); setInterval(() => {}, 1000);',
    "stderr-limit":
      'process.stderr.write("E".repeat(4096)); setInterval(() => {}, 1000);',
    timeout: String.raw`
process.on("SIGTERM", () => {});
process.stderr.write("PRIVATE_TIMEOUT_CANARY");
setTimeout(() => process.exit(71), 9000).unref();
setInterval(() => {}, 1000);
`,
    descendant: String.raw`
import { spawn } from "node:child_process";
const source = 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 9000).unref(); setInterval(() => {}, 1000);';
const child = spawn(process.execPath, ["-e", source], { detached: true, env: {}, stdio: "ignore" });
child.unref();
// Family-owned discovery window only: containment still authenticates the child.
setTimeout(() => {}, ${descendantDiscoveryWindowMs});
`,
  },
);

const fail = (code: string): never => {
  throw new HeadlessSupervisorContractAssertionError(code);
};

const assert = (condition: boolean, code: string): void => {
  if (!condition) fail(code);
};

const strictRecord = (value: unknown, code: string): StrictRecord => {
  if (
    typeof value !== "object" ||
    value === null ||
    safeIsProxy(value) ||
    (safeGetPrototypeOf(value) !== safeObjectPrototype &&
      safeGetPrototypeOf(value) !== null)
  )
    return fail(code);
  let keys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    keys = safeReflectOwnKeys(value);
    descriptors = safeGetOwnPropertyDescriptors(value);
  } catch {
    return fail(code);
  }
  const record = safeObjectCreate(null) as StrictRecord;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") return fail(code);
    const descriptor: PropertyDescriptor | undefined = descriptors[key];
    if (descriptor === undefined) return fail(code);
    assert(
      descriptor.get === undefined &&
        descriptor.set === undefined &&
        safeObjectHasOwn(descriptor, "value"),
      code,
    );
    record[key] = descriptor.value as unknown;
  }
  return record;
};

const exactKeys = (
  value: StrictRecord,
  expected: readonly string[],
  code: string,
): void => {
  const actual = safeObjectKeys(value);
  assert(actual.length === expected.length, code);
  for (let index = 0; index < expected.length; index += 1)
    assert(safeObjectHasOwn(value, expected[index]!), code);
};

const projectRecord = (
  value: unknown,
  required: readonly string[],
  code: string,
): StrictRecord => {
  if (
    typeof value !== "object" ||
    value === null ||
    safeIsProxy(value) ||
    (safeGetPrototypeOf(value) !== safeObjectPrototype &&
      safeGetPrototypeOf(value) !== null)
  )
    return fail(code);
  const record = safeObjectCreate(null) as StrictRecord;
  for (let index = 0; index < required.length; index += 1) {
    const key = required[index]!;
    const descriptor = safeGetOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return fail(code);
    assert(
      descriptor.get === undefined &&
        descriptor.set === undefined &&
        safeObjectHasOwn(descriptor, "value"),
      code,
    );
    record[key] = descriptor.value as unknown;
  }
  return record;
};

const readRecord = (
  value: unknown,
  required: readonly string[],
  code: string,
  source: "dto" | "wire",
): StrictRecord => {
  if (source === "dto") return projectRecord(value, required, code);
  const record = strictRecord(value, code);
  exactKeys(record, required, code);
  return record;
};

const strictArray = (
  value: unknown,
  expectedLength: number,
  code: string,
): readonly unknown[] => {
  if (
    safeIsProxy(value) ||
    !safeArrayIsArray(value) ||
    safeGetPrototypeOf(value) !== safeArrayPrototype ||
    value.length !== expectedLength
  )
    return fail(code);
  const descriptors = safeGetOwnPropertyDescriptors(value);
  const keys = safeReflectOwnKeys(value);
  assert(keys.length === expectedLength + 1, code);
  const result = new SafeArray<unknown>(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor: PropertyDescriptor | undefined =
      descriptors[String(index)];
    if (descriptor === undefined) return fail(code);
    assert(
      descriptor.get === undefined &&
        descriptor.set === undefined &&
        safeObjectHasOwn(descriptor, "value"),
      code,
    );
    result[index] = descriptor.value as unknown;
  }
  const lengthDescriptor = (
    descriptors as Record<string, PropertyDescriptor | undefined>
  )["length"];
  if (lengthDescriptor === undefined) return fail(code);
  assert(
    lengthDescriptor.get === undefined &&
      lengthDescriptor.set === undefined &&
      lengthDescriptor.value === expectedLength,
    code,
  );
  return result;
};

const projectArray = (
  value: unknown,
  expectedLength: number,
  code: string,
): readonly unknown[] => {
  if (
    safeIsProxy(value) ||
    !safeArrayIsArray(value) ||
    safeGetPrototypeOf(value) !== safeArrayPrototype ||
    value.length !== expectedLength
  )
    return fail(code);
  const result = new SafeArray<unknown>(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = safeGetOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) return fail(code);
    assert(
      descriptor.get === undefined &&
        descriptor.set === undefined &&
        safeObjectHasOwn(descriptor, "value"),
      code,
    );
    result[index] = descriptor.value as unknown;
  }
  return result;
};

const readArray = (
  value: unknown,
  expectedLength: number,
  code: string,
  source: "dto" | "wire",
): readonly unknown[] =>
  source === "dto"
    ? projectArray(value, expectedLength, code)
    : strictArray(value, expectedLength, code);

const readEnvelopeBytes = (
  value: unknown,
  limit: number,
  boundCode: string,
  shapeCode: string,
): Uint8Array => {
  if (
    typeof value !== "object" ||
    value === null ||
    safeIsProxy(value) ||
    safeGetPrototypeOf(value) !== safeUint8ArrayPrototype
  )
    return fail(shapeCode);
  const bytes = value as Uint8Array;
  let backing: ArrayBufferLike;
  let byteLength: number;
  let byteOffset: number;
  try {
    backing = callDescriptorGetter(
      safeTypedArrayBufferDescriptor,
      bytes,
    ) as ArrayBufferLike;
    byteLength = callDescriptorGetter(
      safeTypedArrayByteLengthDescriptor,
      bytes,
    ) as number;
    byteOffset = callDescriptorGetter(
      safeTypedArrayByteOffsetDescriptor,
      bytes,
    ) as number;
  } catch {
    return fail(shapeCode);
  }
  assert(
    safeGetPrototypeOf(backing) === safeArrayBufferPrototype &&
      (safeArrayBufferResizableDescriptor?.get === undefined ||
        callDescriptorGetter(safeArrayBufferResizableDescriptor, backing) ===
          false),
    shapeCode,
  );
  assert(byteLength <= limit, boundCode);
  try {
    const copy = new SafeUint8Array(byteLength);
    safeReflectApply(
      safeTypedArraySetDescriptor.value as (
        ...arguments_: unknown[]
      ) => unknown,
      copy,
      [bytes],
    );
    assert(
      callDescriptorGetter(safeTypedArrayBufferDescriptor, bytes) === backing &&
        callDescriptorGetter(safeTypedArrayByteLengthDescriptor, bytes) ===
          byteLength &&
        callDescriptorGetter(safeTypedArrayByteOffsetDescriptor, bytes) ===
          byteOffset,
      shapeCode,
    );
    return copy;
  } catch {
    return fail(shapeCode);
  }
};

const readWireBytes = (
  value: unknown,
  limit: number,
  boundCode: string,
): Uint8Array => {
  if (
    safeIsProxy(value) ||
    !safeArrayIsArray(value) ||
    safeGetPrototypeOf(value) !== safeArrayPrototype
  )
    return fail("testkit.headless.result.output");
  assert(value.length <= limit, boundCode);
  const values = strictArray(
    value,
    value.length,
    "testkit.headless.result.output",
  );
  const bytes = new SafeUint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const byte = values[index];
    assert(
      safeNumberIsSafeInteger(byte) &&
        (byte as number) >= 0 &&
        (byte as number) <= 255,
      "testkit.headless.result.output",
    );
    bytes[index] = byte as number;
  }
  assert(values.length <= limit, boundCode);
  return bytes;
};

const trustedByteLength = (value: Uint8Array): number =>
  callDescriptorGetter(safeTypedArrayByteLengthDescriptor, value) as number;

const byteValues = (value: Uint8Array): readonly number[] => {
  const values = wireArray<number>(trustedByteLength(value));
  for (let index = 0; index < values.length; index += 1)
    values[index] = value[index]!;
  return values;
};

const canonicalTraceJson = (trace: HeadlessExecutionTrace): string => {
  const processes = wireArray<StrictRecord>(trace.observation.processes.length);
  for (let index = 0; index < processes.length; index += 1) {
    const process = trace.observation.processes[index]!;
    processes[index] = wireRecord([
      ["pid", process.pid],
      ["startIdentity", process.startIdentity],
      ["role", process.role],
    ]);
  }
  const signals = wireArray<StrictRecord>(trace.observation.signals.length);
  for (let index = 0; index < signals.length; index += 1) {
    const signal = trace.observation.signals[index]!;
    signals[index] = wireRecord([
      ["signal", signal.signal],
      ["targetStartIdentity", signal.targetStartIdentity],
      ["monotonicAtMs", signal.monotonicAtMs],
    ]);
  }
  const residuals = wireArray<string>(
    trace.observation.residualStartIdentities.length,
  );
  for (let index = 0; index < residuals.length; index += 1)
    residuals[index] = trace.observation.residualStartIdentities[index]!;
  const result = wireRecord([
    ["resultVersion", trace.result.resultVersion],
    ["outcome", trace.result.outcome],
    ["exitCode", trace.result.exitCode],
    ["signal", trace.result.signal],
    ["stdout", byteValues(trace.result.stdout)],
    ["stderr", byteValues(trace.result.stderr)],
    ["stdoutTruncated", trace.result.stdoutTruncated],
    ["stderrTruncated", trace.result.stderrTruncated],
    ["termRequested", trace.result.termRequested],
    ["killRequested", trace.result.killRequested],
    ["cleanup", trace.result.cleanup],
    ["residualProcessCount", trace.result.residualProcessCount],
    ["diagnosticCode", trace.result.diagnosticCode],
  ]);
  const observation = wireRecord([
    ["observationVersion", trace.observation.observationVersion],
    ["runId", trace.observation.runId],
    ["requestFingerprint", trace.observation.requestFingerprint],
    ["processes", processes],
    ["signals", signals],
    ["spawnedAtMs", trace.observation.spawnedAtMs],
    ["readyAtMs", trace.observation.readyAtMs],
    ["settledAtMs", trace.observation.settledAtMs],
    ["processJoined", trace.observation.processJoined],
    ["stdinJoined", trace.observation.stdinJoined],
    ["stdoutJoined", trace.observation.stdoutJoined],
    ["stderrJoined", trace.observation.stderrJoined],
    ["cleanup", trace.observation.cleanup],
    ["residualStartIdentities", residuals],
  ]);
  const serialized = safeJsonStringify(
    wireRecord([
      ["traceVersion", trace.traceVersion],
      ["runId", trace.runId],
      ["requestFingerprint", trace.requestFingerprint],
      ["returnedAtMs", trace.returnedAtMs],
      ["result", result],
      ["observation", observation],
    ]),
  );
  assert(serialized !== undefined, "testkit.headless.envelope.canonical");
  return serialized;
};

/**
 * Projects the required fields of a closed protocol DTO into the family-owned
 * canonical envelope. Surplus DTO fields are ignored without access; exact
 * shape authority belongs to verify(). This serializer does not mint
 * observation authority or prove that the DTO came from an executing backend.
 */
export const encodeCanonicalHeadlessExecutionTrace = (
  trace: unknown,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): HeadlessCanonicalTraceEnvelope => {
  const validated = readTrace(trace, scenario, request, "dto");
  const encoded = encodeText(canonicalTraceJson(validated));
  assert(
    trustedByteLength(encoded) <= headlessTraceEnvelopeLimitBytes,
    "testkit.headless.envelope.bound",
  );
  return encoded;
};

const finiteTime = (value: unknown, code: string): number => {
  assert(
    typeof value === "number" && safeNumberIsFinite(value) && value >= 0,
    code,
  );
  return value as number;
};

const readResultOutputs = (
  record: StrictRecord,
  request: HeadlessExecutionRequest,
  source: "dto" | "wire",
): Readonly<{ stderr: Uint8Array; stdout: Uint8Array }> => {
  const stdout =
    source === "wire"
      ? readWireBytes(
          record.stdout,
          request.stdoutLimitBytes,
          "testkit.headless.stdout.bound",
        )
      : readEnvelopeBytes(
          record.stdout,
          request.stdoutLimitBytes,
          "testkit.headless.stdout.bound",
          "testkit.headless.result.output",
        );
  const stderr =
    source === "wire"
      ? readWireBytes(
          record.stderr,
          request.stderrLimitBytes,
          "testkit.headless.stderr.bound",
        )
      : readEnvelopeBytes(
          record.stderr,
          request.stderrLimitBytes,
          "testkit.headless.stderr.bound",
          "testkit.headless.result.output",
        );
  return { stderr, stdout };
};

const readResult = (
  value: unknown,
  request: HeadlessExecutionRequest,
  source: "dto" | "wire",
): HeadlessExecutionResult => {
  const record = readRecord(
    value,
    resultKeys,
    "testkit.headless.result.shape",
    source,
  );
  assert(record.resultVersion === 1, "testkit.headless.result.version");
  assert(
    record.outcome === "exited" ||
      record.outcome === "output-limit" ||
      record.outcome === "timed-out" ||
      record.outcome === "cleanup-failed",
    "testkit.headless.result.outcome",
  );
  assert(
    record.exitCode === null ||
      (safeNumberIsSafeInteger(record.exitCode) &&
        (record.exitCode as number) >= 0 &&
        (record.exitCode as number) <= 255),
    "testkit.headless.result.exit",
  );
  assert(
    record.signal === null ||
      record.signal === "SIGTERM" ||
      record.signal === "SIGKILL",
    "testkit.headless.result.signal",
  );
  const { stderr, stdout } = readResultOutputs(record, request, source);
  assert(
    typeof record.stdoutTruncated === "boolean" &&
      typeof record.stderrTruncated === "boolean" &&
      typeof record.termRequested === "boolean" &&
      typeof record.killRequested === "boolean",
    "testkit.headless.result.lifecycle",
  );
  assert(
    record.cleanup === "clean" ||
      record.cleanup === "residual" ||
      record.cleanup === "uncertain",
    "testkit.headless.result.cleanup",
  );
  assert(
    safeNumberIsSafeInteger(record.residualProcessCount) &&
      (record.residualProcessCount as number) >= 0,
    "testkit.headless.result.cleanup",
  );
  assert(
    record.diagnosticCode === null ||
      record.diagnosticCode === "testkit.headless.output-limit" ||
      record.diagnosticCode === "testkit.headless.timeout" ||
      record.diagnosticCode === "testkit.headless.cleanup",
    "testkit.headless.result.diagnostic",
  );
  assert(
    !(record.exitCode !== null && record.signal !== null) &&
      !(record.killRequested === true && record.termRequested !== true),
    "testkit.headless.result.lifecycle",
  );
  assert(
    record.cleanup === "uncertain" ||
      (record.cleanup === "clean" && record.residualProcessCount === 0) ||
      (record.cleanup === "residual" &&
        (record.residualProcessCount as number) > 0),
    "testkit.headless.result.cleanup",
  );
  const diagnostic = {
    exited: null,
    "output-limit": "testkit.headless.output-limit",
    "timed-out": "testkit.headless.timeout",
    "cleanup-failed": "testkit.headless.cleanup",
  }[record.outcome as HeadlessExecutionOutcome];
  assert(
    record.diagnosticCode === diagnostic,
    "testkit.headless.result.diagnostic",
  );
  return safeFreeze({
    resultVersion: 1,
    outcome: record.outcome as HeadlessExecutionOutcome,
    exitCode: record.exitCode as number | null,
    signal: record.signal as "SIGTERM" | "SIGKILL" | null,
    stdout,
    stderr,
    stdoutTruncated: record.stdoutTruncated as boolean,
    stderrTruncated: record.stderrTruncated as boolean,
    termRequested: record.termRequested as boolean,
    killRequested: record.killRequested as boolean,
    cleanup: record.cleanup as "clean" | "residual" | "uncertain",
    residualProcessCount: record.residualProcessCount as number,
    diagnosticCode:
      record.diagnosticCode as HeadlessExecutionDiagnosticCode | null,
  });
};

const readProcesses = (
  value: unknown,
  expectedRoles: readonly ("root" | "descendant")[],
  source: "dto" | "wire",
): readonly HeadlessProcessIdentity[] => {
  const candidates = readArray(
    value,
    expectedRoles.length,
    "testkit.headless.observer.processes",
    source,
  );
  const processes = new SafeArray<HeadlessProcessIdentity>(candidates.length);
  for (let index = 0; index < candidates.length; index += 1) {
    const process = readRecord(
      candidates[index],
      ["pid", "role", "startIdentity"],
      "testkit.headless.observer.process",
      source,
    );
    assert(
      safeNumberIsSafeInteger(process.pid) &&
        (process.pid as number) > 1 &&
        typeof process.startIdentity === "string" &&
        process.startIdentity.length > 0 &&
        process.startIdentity.length <= 256 &&
        (process.role === "root" || process.role === "descendant"),
      "testkit.headless.observer.process",
    );
    processes[index] = safeFreeze({ ...process }) as HeadlessProcessIdentity;
  }
  for (let index = 0; index < processes.length; index += 1) {
    assert(
      processes[index]!.role === expectedRoles[index],
      "testkit.headless.observer.process-set",
    );
    for (let prior = 0; prior < index; prior += 1)
      assert(
        processes[index]!.startIdentity !== processes[prior]!.startIdentity &&
          processes[index]!.pid !== processes[prior]!.pid,
        "testkit.headless.observer.process",
      );
  }
  return processes;
};

const expectedSignalKeys = (
  scenario: HeadlessObserverScenario,
  processes: readonly HeadlessProcessIdentity[],
): readonly string[] => {
  let root: string | undefined;
  let descendant: string | undefined;
  for (let index = 0; index < processes.length; index += 1) {
    const process = processes[index]!;
    if (process.role === "root") root = process.startIdentity;
    else descendant = process.startIdentity;
  }
  assert(root !== undefined, "testkit.headless.observer.process-set");
  if (scenario === "correct") return [];
  if (scenario === "stdout-limit" || scenario === "stderr-limit")
    return [`SIGTERM:${root}`];
  if (scenario === "timeout") return [`SIGTERM:${root}`, `SIGKILL:${root}`];
  assert(descendant !== undefined, "testkit.headless.observer.process-set");
  return [`SIGTERM:${descendant!}`, `SIGKILL:${descendant!}`];
};

const readSignals = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  processes: readonly HeadlessProcessIdentity[],
  source: "dto" | "wire",
): readonly HeadlessObservedSignal[] => {
  const identities = new SafeArray<string>(processes.length);
  for (let index = 0; index < processes.length; index += 1)
    identities[index] = processes[index]!.startIdentity;
  const expectedKeys = expectedSignalKeys(scenario, processes);
  const candidates = readArray(
    value,
    expectedKeys.length,
    "testkit.headless.observer.signals",
    source,
  );
  const signals = new SafeArray<HeadlessObservedSignal>(candidates.length);
  const signalKeys = new SafeArray<string>(candidates.length);
  for (let index = 0; index < candidates.length; index += 1) {
    const signal = readRecord(
      candidates[index],
      ["monotonicAtMs", "signal", "targetStartIdentity"],
      "testkit.headless.observer.signal",
      source,
    );
    assert(
      (signal.signal === "SIGTERM" || signal.signal === "SIGKILL") &&
        typeof signal.targetStartIdentity === "string" &&
        (identities[0] === signal.targetStartIdentity ||
          identities[1] === signal.targetStartIdentity),
      "testkit.headless.observer.signal",
    );
    signals[index] = safeFreeze({
      signal: signal.signal,
      targetStartIdentity: signal.targetStartIdentity,
      monotonicAtMs: finiteTime(
        signal.monotonicAtMs,
        "testkit.headless.observer.signal",
      ),
    }) as HeadlessObservedSignal;
    if (index > 0)
      assert(
        signals[index - 1]!.monotonicAtMs <= signals[index]!.monotonicAtMs,
        "testkit.headless.observer.signal-order",
      );
    signalKeys[index] =
      `${signals[index]!.signal}:${signals[index]!.targetStartIdentity}`;
  }
  for (let index = 0; index < signalKeys.length; index += 1)
    assert(
      signalKeys[index] === expectedKeys[index],
      "testkit.headless.observer.signal-sequence",
    );
  return signals;
};

const readResiduals = (
  value: unknown,
  processes: readonly HeadlessProcessIdentity[],
  source: "dto" | "wire",
): readonly string[] => {
  const candidates = readArray(
    value,
    0,
    "testkit.headless.observer.residual",
    source,
  );
  const residuals = new SafeArray<string>(candidates.length);
  for (let index = 0; index < candidates.length; index += 1) {
    const identity = candidates[index];
    let known = false;
    for (
      let processIndex = 0;
      processIndex < processes.length;
      processIndex += 1
    )
      if (processes[processIndex]!.startIdentity === identity) known = true;
    assert(
      typeof identity === "string" && known,
      "testkit.headless.observer.residual",
    );
    residuals[index] = identity as string;
    for (let prior = 0; prior < index; prior += 1)
      assert(
        residuals[prior] !== identity,
        "testkit.headless.observer.residual",
      );
  }
  return residuals;
};

const readObservation = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  source: "dto" | "wire",
): HeadlessProcessSetObservation => {
  const record = readRecord(
    value,
    observationKeys,
    "testkit.headless.observer.shape",
    source,
  );
  assert(record.observationVersion === 1, "testkit.headless.observer.version");
  assert(
    record.runId === request.runId &&
      record.requestFingerprint === request.requestFingerprint,
    "testkit.headless.observer.binding",
  );
  const roles =
    scenario === "descendant"
      ? (["root", "descendant"] as const)
      : (["root"] as const);
  const processes = readProcesses(record.processes, roles, source);
  const signals = readSignals(record.signals, scenario, processes, source);
  const residuals = readResiduals(
    record.residualStartIdentities,
    processes,
    source,
  );
  assert(
    record.cleanup === "clean" ||
      record.cleanup === "residual" ||
      record.cleanup === "uncertain",
    "testkit.headless.observer.cleanup",
  );
  assert(
    (record.cleanup === "clean" && residuals.length === 0) ||
      (record.cleanup === "residual" && residuals.length > 0) ||
      record.cleanup === "uncertain",
    "testkit.headless.observer.cleanup",
  );
  const handleKeys = [
    "processJoined",
    "stdinJoined",
    "stdoutJoined",
    "stderrJoined",
  ] as const;
  for (let index = 0; index < handleKeys.length; index += 1) {
    const key = handleKeys[index]!;
    assert(
      typeof record[key] === "boolean",
      "testkit.headless.observer.handles",
    );
  }
  return safeFreeze({
    observationVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    processes: safeFreeze(processes),
    signals: safeFreeze(signals),
    spawnedAtMs: finiteTime(
      record.spawnedAtMs,
      "testkit.headless.observer.timing",
    ),
    readyAtMs: finiteTime(record.readyAtMs, "testkit.headless.observer.timing"),
    settledAtMs: finiteTime(
      record.settledAtMs,
      "testkit.headless.observer.timing",
    ),
    processJoined: record.processJoined as boolean,
    stdinJoined: record.stdinJoined as boolean,
    stdoutJoined: record.stdoutJoined as boolean,
    stderrJoined: record.stderrJoined as boolean,
    cleanup: record.cleanup as "clean" | "residual" | "uncertain",
    residualStartIdentities: safeFreeze(residuals),
  });
};

const assertTerminalProtocol = (
  trace: HeadlessExecutionTrace,
  request: HeadlessExecutionRequest,
): void => {
  const { observation, result, returnedAtMs } = trace;
  assert(
    observation.spawnedAtMs <= observation.readyAtMs &&
      observation.readyAtMs <= request.monotonicStartupDeadlineMs,
    "testkit.headless.observer.startup",
  );
  assert(
    observation.readyAtMs <= observation.settledAtMs &&
      observation.settledAtMs <= returnedAtMs &&
      returnedAtMs <= request.monotonicShutdownDeadlineMs,
    "testkit.headless.observer.settlement",
  );
  let termObserved = false;
  let killObserved = false;
  for (let index = 0; index < observation.signals.length; index += 1) {
    const signal = observation.signals[index]!;
    assert(
      signal.monotonicAtMs >= observation.readyAtMs &&
        signal.monotonicAtMs <= observation.settledAtMs,
      "testkit.headless.observer.signal-window",
    );
    if (signal.signal === "SIGTERM") termObserved = true;
    else killObserved = true;
  }
  assert(
    result.termRequested === termObserved &&
      result.killRequested === killObserved,
    "testkit.headless.observer.signal-correlation",
  );
  assert(
    observation.processJoined &&
      observation.stdinJoined &&
      observation.stdoutJoined &&
      observation.stderrJoined,
    "testkit.headless.observer.handles",
  );
  assert(
    observation.cleanup === "clean" &&
      observation.residualStartIdentities.length === 0 &&
      result.cleanup === "clean" &&
      result.residualProcessCount === 0,
    "testkit.headless.cleanup.complete",
  );
  assert(
    trustedByteLength(result.stdout) <= request.stdoutLimitBytes,
    "testkit.headless.stdout.bound",
  );
  assert(
    trustedByteLength(result.stderr) <= request.stderrLimitBytes,
    "testkit.headless.stderr.bound",
  );
};

const assertCorrect = (
  result: HeadlessExecutionResult,
  request: HeadlessExecutionRequest,
): void => {
  assert(
    result.outcome === "exited" &&
      result.exitCode === 0 &&
      result.signal === null &&
      result.diagnosticCode === null &&
      !result.stdoutTruncated &&
      !result.stderrTruncated,
    "testkit.headless.completion",
  );
  let invocation: StrictRecord;
  try {
    invocation = strictRecord(
      safeJsonParse(decodeText(result.stdout)) as unknown,
      "testkit.headless.invocation.record",
    );
  } catch {
    return fail("testkit.headless.invocation.record");
  }
  exactKeys(
    invocation,
    ["arguments", "cwd", "environment", "input", "unexpectedEnvironmentCount"],
    "testkit.headless.invocation.record",
  );
  const arguments_ = strictArray(
    invocation.arguments,
    2,
    "testkit.headless.invocation.arguments",
  );
  assert(
    arguments_[0] === "argument one" && arguments_[1] === "--literal=$VALUE",
    "testkit.headless.invocation.arguments",
  );
  assert(invocation.cwd === request.cwd, "testkit.headless.invocation.cwd");
  const environment = strictRecord(
    invocation.environment,
    "testkit.headless.invocation.environment",
  );
  exactKeys(
    environment,
    ["AGENTSCOPE_ORACLE_VISIBLE"],
    "testkit.headless.invocation.environment",
  );
  assert(
    environment.AGENTSCOPE_ORACLE_VISIBLE ===
      request.environment.AGENTSCOPE_ORACLE_VISIBLE &&
      invocation.unexpectedEnvironmentCount === 0,
    "testkit.headless.invocation.environment",
  );
  assert(
    invocation.input === "oracle-stdin",
    "testkit.headless.invocation.stdin",
  );
  assert(
    decodeText(result.stderr) === "fixture-stderr",
    "testkit.headless.invocation.stderr",
  );
};

const assertOutputLimit = (
  result: HeadlessExecutionResult,
  request: HeadlessExecutionRequest,
  stream: "stdout" | "stderr",
): void => {
  assert(
    result.outcome === "output-limit" &&
      result.exitCode === null &&
      result.signal === "SIGTERM" &&
      result.diagnosticCode === "testkit.headless.output-limit",
    `testkit.headless.${stream}.limit`,
  );
  assert(
    stream === "stdout"
      ? result.stdoutTruncated &&
          trustedByteLength(result.stdout) === request.stdoutLimitBytes
      : result.stderrTruncated &&
          trustedByteLength(result.stderr) === request.stderrLimitBytes,
    `testkit.headless.${stream}.limit`,
  );
};

const assertTimeout = (
  trace: HeadlessExecutionTrace,
  request: HeadlessExecutionRequest,
): void => {
  const { observation, result } = trace;
  assert(
    result.outcome === "timed-out" &&
      result.exitCode === null &&
      result.signal === "SIGKILL" &&
      result.diagnosticCode === "testkit.headless.timeout",
    "testkit.headless.timeout.classification",
  );
  let root: HeadlessProcessIdentity | undefined;
  for (let index = 0; index < observation.processes.length; index += 1)
    if (observation.processes[index]!.role === "root")
      root = observation.processes[index];
  assert(root !== undefined, "testkit.headless.observer.process-set");
  const term = observation.signals[0];
  const kill = observation.signals[1];
  assert(
    term!.targetStartIdentity === root!.startIdentity &&
      term!.monotonicAtMs >= request.monotonicExecutionDeadlineMs &&
      term!.monotonicAtMs >= observation.readyAtMs,
    "testkit.headless.timeout.early-term",
  );
  assert(
    kill!.targetStartIdentity === root!.startIdentity &&
      kill!.monotonicAtMs >= term!.monotonicAtMs + request.terminationGraceMs,
    "testkit.headless.timeout.short-grace",
  );
};

const readTrace = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  source: "dto" | "wire",
): HeadlessExecutionTrace => {
  const record = readRecord(
    value,
    traceKeys,
    "testkit.headless.trace.shape",
    source,
  );
  assert(record.traceVersion === 1, "testkit.headless.trace.version");
  assert(
    record.runId === request.runId &&
      record.requestFingerprint === request.requestFingerprint,
    "testkit.headless.trace.binding",
  );
  const trace = safeFreeze({
    traceVersion: 1 as const,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    returnedAtMs: finiteTime(
      record.returnedAtMs,
      "testkit.headless.trace.timing",
    ),
    result: readResult(record.result, request, source),
    observation: readObservation(record.observation, scenario, request, source),
  });
  assertTerminalProtocol(trace, request);
  if (scenario === "correct") assertCorrect(trace.result, request);
  else if (scenario === "stdout-limit" || scenario === "stderr-limit")
    assertOutputLimit(
      trace.result,
      request,
      scenario === "stdout-limit" ? "stdout" : "stderr",
    );
  else if (scenario === "timeout") assertTimeout(trace, request);
  else
    assert(
      trace.result.outcome === "exited" && trace.result.exitCode === 0,
      "testkit.headless.descendant.classification",
    );
  return trace;
};

const verifyEncodedTrace = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): HeadlessExecutionTrace => {
  const bytes = readEnvelopeBytes(
    value,
    headlessTraceEnvelopeLimitBytes,
    "testkit.headless.envelope.bound",
    "testkit.headless.envelope.shape",
  );
  let source: string;
  let parsed: unknown;
  try {
    source = decodeText(bytes);
    parsed = safeJsonParse(source) as unknown;
  } catch {
    return fail("testkit.headless.envelope.encoding");
  }
  const trace = readTrace(parsed, scenario, request, "wire");
  assert(
    canonicalTraceJson(trace) === source,
    "testkit.headless.envelope.canonical",
  );
  return trace;
};

const fingerprint = (value: Readonly<Record<string, unknown>>): string => {
  const serialized = safeJsonStringify(value);
  assert(serialized !== undefined, "testkit.headless.request.fingerprint");
  const hash = createHash("sha256");
  callDescriptorMethod(safeHashUpdateDescriptor, hash, [serialized]);
  return callDescriptorMethod(safeHashDigestDescriptor, hash, [
    "hex",
  ]) as string;
};

const instantiate = (
  scenario: HeadlessObserverScenario,
  input: Readonly<{ root: string; fixturePath: string }>,
): HeadlessSupervisorContractRun => {
  const now = callDescriptorMethod(
    safePerformanceNowDescriptor,
    performance,
    [],
  ) as number;
  const common = safeFreeze({
    runId: randomUUID(),
    executable: safeExecPath,
    arguments: safeFreeze(
      scenario === "correct"
        ? [input.fixturePath, "argument one", "--literal=$VALUE"]
        : [input.fixturePath],
    ),
    cwd: input.root,
    environment: safeFreeze({ AGENTSCOPE_ORACLE_VISIBLE: "visible-canary" }),
    stdin: encodeText("oracle-stdin"),
    stdoutLimitBytes: outputLimitBytes,
    stderrLimitBytes: outputLimitBytes,
    monotonicStartupDeadlineMs: now + 2_000,
    monotonicExecutionDeadlineMs: now + 5_000,
    monotonicShutdownDeadlineMs: now + 7_000,
    terminationGraceMs,
  });
  const stdin = wireArray<number>(trustedByteLength(common.stdin));
  for (let index = 0; index < stdin.length; index += 1)
    stdin[index] = common.stdin[index]!;
  const arguments_ = wireArray<string>(common.arguments.length);
  for (let index = 0; index < arguments_.length; index += 1)
    arguments_[index] = common.arguments[index]!;
  const requestFingerprint = fingerprint(
    wireRecord([
      ["runId", common.runId],
      ["executable", common.executable],
      ["arguments", arguments_],
      ["cwd", common.cwd],
      [
        "environment",
        wireRecord([
          [
            "AGENTSCOPE_ORACLE_VISIBLE",
            common.environment.AGENTSCOPE_ORACLE_VISIBLE,
          ],
        ]),
      ],
      ["stdin", stdin],
      ["stdoutLimitBytes", common.stdoutLimitBytes],
      ["stderrLimitBytes", common.stderrLimitBytes],
      ["monotonicStartupDeadlineMs", common.monotonicStartupDeadlineMs],
      ["monotonicExecutionDeadlineMs", common.monotonicExecutionDeadlineMs],
      ["monotonicShutdownDeadlineMs", common.monotonicShutdownDeadlineMs],
      ["terminationGraceMs", common.terminationGraceMs],
    ]),
  );
  const request = safeFreeze({ ...common, requestFingerprint });
  return safeFreeze({
    request,
    encode: (trace: unknown) =>
      encodeCanonicalHeadlessExecutionTrace(trace, scenario, request),
    verify: (encodedTrace: unknown) =>
      verifyEncodedTrace(encodedTrace, scenario, request),
  });
};

/**
 * Returns the synchronous, family-owned protocol cases. These cases verify only
 * bounded canonical trace envelopes. They do not execute a process, mint
 * backend authority, or establish execution, cancellation, cleanup, or join
 * evidence.
 */
export const createBoundedHeadlessSupervisorContractSuite =
  (): readonly HeadlessSupervisorContractCase[] => {
    const definitions = [
      ["headless:correct-invocation", "correct"],
      ["headless:stdout-limit", "stdout-limit"],
      ["headless:stderr-limit", "stderr-limit"],
      ["headless:timeout-escalation", "timeout"],
      ["headless:descendant-cleanup", "descendant"],
    ] as const;
    const cases = new SafeArray<HeadlessSupervisorContractCase>(
      definitions.length,
    );
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index]!;
      const name = definition[0];
      const scenario = definition[1];
      cases[index] = safeFreeze({
        name,
        fixtureSource: fixtures[scenario],
        instantiate: (input: Readonly<{ root: string; fixturePath: string }>) =>
          instantiate(scenario, input),
      });
    }
    return safeFreeze(cases);
  };

/**
 * Returns the closed hostile non-PTY process matrix. The matrix owns process
 * stimuli and their component-level terminal oracle. In particular, the hook
 * record seeds prove that process output cannot mint harness acceptance:
 * higher-level real-harness correlation remains outside this contract.
 */
export const createHostileHeadlessProcessMatrix =
  (): readonly HostileHeadlessProcessCase[] => {
    const trace = (
      outcome: HeadlessExecutionOutcome,
      exitCode: number | null,
      diagnosticCode: HeadlessExecutionDiagnosticCode | null,
    ) =>
      safeFreeze({
        kind: "trace" as const,
        outcome,
        exitCode,
        diagnosticCode,
      });
    const error = (code: string) =>
      safeFreeze({ kind: "error" as const, code });
    const definitions: readonly (readonly [
      string,
      HostileHeadlessProcessSeed,
      HostileHeadlessProcessCase["terminal"],
    ])[] = [
      [
        "headless:crash-before-lifecycle",
        "crash-before-lifecycle",
        error("testkit.headless.kernel.spawn"),
      ],
      [
        "headless:crash-after-lifecycle",
        "crash-after-lifecycle",
        trace("exited", 71, null),
      ],
      ["headless:partial-output", "partial-output", trace("exited", 70, null)],
      [
        "headless:malformed-output",
        "malformed-output",
        trace("exited", 0, null),
      ],
      [
        "headless:oversized-output",
        "oversized-output",
        trace("output-limit", null, "testkit.headless.output-limit"),
      ],
      [
        "headless:infinite-output",
        "infinite-output",
        trace("output-limit", null, "testkit.headless.output-limit"),
      ],
      [
        "headless:ignored-termination",
        "ignored-termination",
        trace("timed-out", null, "testkit.headless.timeout"),
      ],
      [
        "headless:delayed-startup",
        "delayed-startup",
        error("testkit.headless.startup.deadline"),
      ],
      [
        "headless:delayed-shutdown",
        "delayed-shutdown",
        error("testkit.headless.reconciliation.deadline"),
      ],
      [
        "headless:surviving-descendant",
        "surviving-descendant",
        trace("exited", 0, null),
      ],
      [
        "headless:restricted-environment",
        "restricted-environment",
        trace("exited", 0, null),
      ],
      [
        "headless:missing-hook-record",
        "missing-hook-record",
        trace("exited", 0, null),
      ],
      [
        "headless:duplicate-hook-record",
        "duplicate-hook-record",
        trace("exited", 0, null),
      ],
      [
        "headless:signal-race",
        "signal-race",
        trace("timed-out", null, "testkit.headless.timeout"),
      ],
      [
        "headless:observation-race",
        "observation-race",
        error("testkit.headless.observer.identity"),
      ],
    ];
    const cases = new SafeArray<HostileHeadlessProcessCase>(definitions.length);
    for (let index = 0; index < definitions.length; index += 1) {
      const definition = definitions[index]!;
      const name = definition[0];
      const seed = definition[1];
      const terminal = definition[2];
      cases[index] = safeFreeze({
        name,
        seed,
        terminal,
        evidenceAuthority: "component-only",
      });
    }
    return safeFreeze(cases);
  };
