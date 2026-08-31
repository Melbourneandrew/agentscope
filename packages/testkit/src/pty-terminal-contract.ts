import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isProxy } from "node:util/types";

import {
  BoundedTerminalEmulator,
  defaultPtyTerminalEmulatorLimits,
  type PtyTerminalGeometry,
  type PtyTerminalSemanticSnapshot,
  validatePtyTerminalSemanticSnapshot,
} from "./bounded-terminal-emulator.js";

export type PtyModeApplicability =
  | Readonly<{
      status: "available";
      documentedMode: string;
      exactHarnessVersion: string;
    }>
  | Readonly<{
      status: "not-applicable";
      reason: "no-documented-interactive-mode";
    }>;
export type PtyTransportAction =
  | Readonly<{
      action: "resize";
      geometry: PtyTerminalGeometry;
      monotonicAtMs: number;
    }>
  | Readonly<{
      action: "input";
      byteLength: number;
      inputSha256: string;
      monotonicAtMs: number;
    }>
  | Readonly<{ action: "eof"; monotonicAtMs: number }>
  | Readonly<{ action: "interrupt-byte"; byte: 3; monotonicAtMs: number }>
  | Readonly<{
      action: "signal";
      monotonicAtMs: number;
      signal: "SIGINT" | "SIGTERM" | "SIGKILL";
      targetStartIdentity: string;
    }>;
export type PtyLifecycleObservation = Readonly<{
  observationVersion: 1;
  cleanup: "clean" | "residual" | "uncertain";
  processJoined: boolean;
  residualProcessCount: number;
  terminalInputJoined: boolean;
  terminalOutputJoined: boolean;
  terminalTransportClosed: boolean;
}>;
export type PtySemanticOutcome =
  "ready" | "completed" | "rejected" | "timed-out" | "cleanup-failed";
export type PtySemanticDiagnosticCode =
  | "testkit.pty.credential-prompt"
  | "testkit.pty.malformed-control"
  | "testkit.pty.output-limit"
  | "testkit.pty.timeout"
  | "testkit.pty.cleanup";
export type PtySemanticContractCaseName =
  | "pty:interactive-ready"
  | "pty:interactive-completed"
  | "pty:credential-prompt"
  | "pty:malformed-control"
  | "pty:output-limit"
  | "pty:timeout-escalation";
export type PtySemanticTrace = Readonly<{
  traceVersion: 1;
  caseName: PtySemanticContractCaseName;
  runId: string;
  requestFingerprint: string;
  exactHarnessVersion: "component-fixture-v1";
  executionMode: "interactive";
  componentEvidenceOnly: true;
  containmentAuthority: "not-claimed";
  retainedRawTerminalBytes: false;
  initialGeometry: PtyTerminalGeometry;
  finalSnapshot: PtyTerminalSemanticSnapshot;
  actions: readonly PtyTransportAction[];
  lifecycle: PtyLifecycleObservation;
  outcome: PtySemanticOutcome;
  diagnosticCode: PtySemanticDiagnosticCode | null;
  returnedAtMs: number;
}>;
export type PtySemanticTraceEnvelope = Uint8Array;
export type PtySemanticContractRequest = Readonly<{
  requestVersion: 1;
  caseName: PtySemanticContractCaseName;
  runId: string;
  requestFingerprint: string;
  initialGeometry: PtyTerminalGeometry;
  monotonicStartupDeadlineMs: number;
  monotonicExecutionDeadlineMs: number;
  monotonicShutdownDeadlineMs: number;
  terminationGraceMs: number;
}>;
export type PtySemanticContractRun = Readonly<{
  request: PtySemanticContractRequest;
  encode: (trace: unknown) => PtySemanticTraceEnvelope;
  verify: (envelope: unknown) => PtySemanticTrace;
}>;
export type PtySemanticContractCase = Readonly<{
  name: PtySemanticContractCaseName;
  instantiate: () => PtySemanticContractRun;
}>;

export class PtySemanticContractError extends Error {
  declare public readonly code: string;
  public constructor(code: string) {
    super(code);
    Object.defineProperty(this, "code", {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    });
  }
}

export const ptySemanticTraceEnvelopeLimitBytes = 32_768;
const componentVersion = "component-fixture-v1" as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const stringifyPrimitive = JSON.stringify.bind(JSON);
const arrayIsArray = Array.isArray;
const objectKeys = Object.keys;
const ownPropertyDescriptor = Object.getOwnPropertyDescriptor;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const fail = (code: string): never => {
  throw new PtySemanticContractError(code);
};
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const containsString = (
  values: readonly string[],
  candidate: string,
): boolean => {
  for (let index = 0; index < values.length; index += 1)
    if (values[index] === candidate) return true;
  return false;
};

const strictRecord = (
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> => {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      arrayIsArray(value) ||
      isProxy(value)
    )
      return fail(code);
    const prototype = Reflect.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.length !== keys.length ||
      (() => {
        for (let index = 0; index < ownKeys.length; index += 1) {
          const key = ownKeys[index];
          if (typeof key !== "string" || !containsString(keys, key))
            return true;
        }
        return false;
      })()
    )
      return fail(code);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor)
      )
        return fail(code);
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return fail(code);
  }
};
const ownStringKeys = (value: unknown, code: string): readonly string[] => {
  try {
    if (typeof value !== "object" || value === null || isProxy(value))
      return fail(code);
    const keys = Reflect.ownKeys(value);
    for (let index = 0; index < keys.length; index += 1)
      if (typeof keys[index] !== "string") return fail(code);
    return keys as string[];
  } catch {
    return fail(code);
  }
};
const strictArray = (value: unknown, code: string): readonly unknown[] => {
  try {
    if (
      !arrayIsArray(value) ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    )
      return fail(code);
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value as unknown;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 128 ||
      keys.length !== length + 1
    )
      return fail(code);
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor)
      )
        return fail(code);
      result[index] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return fail(code);
  }
};
const exactGeometry = (value: unknown): PtyTerminalGeometry => {
  const r = strictRecord(
    value,
    ["columns", "rows"],
    "testkit.pty.trace.geometry",
  );
  if (
    !integer(r.columns, 512) ||
    !integer(r.rows, 512) ||
    r.columns === 0 ||
    r.rows === 0 ||
    r.columns * r.rows > 65_536
  )
    return fail("testkit.pty.trace.geometry");
  return Object.freeze({ columns: r.columns, rows: r.rows });
};
const exactLifecycle = (value: unknown): PtyLifecycleObservation => {
  const r = strictRecord(
    value,
    [
      "cleanup",
      "observationVersion",
      "processJoined",
      "residualProcessCount",
      "terminalInputJoined",
      "terminalOutputJoined",
      "terminalTransportClosed",
    ],
    "testkit.pty.trace.lifecycle",
  );
  if (
    r.observationVersion !== 1 ||
    (r.cleanup !== "clean" &&
      r.cleanup !== "residual" &&
      r.cleanup !== "uncertain") ||
    typeof r.processJoined !== "boolean" ||
    typeof r.terminalInputJoined !== "boolean" ||
    typeof r.terminalOutputJoined !== "boolean" ||
    typeof r.terminalTransportClosed !== "boolean" ||
    !integer(r.residualProcessCount, 65_536)
  )
    return fail("testkit.pty.trace.lifecycle");
  return Object.freeze({
    observationVersion: 1,
    cleanup: r.cleanup,
    processJoined: r.processJoined,
    residualProcessCount: r.residualProcessCount,
    terminalInputJoined: r.terminalInputJoined,
    terminalOutputJoined: r.terminalOutputJoined,
    terminalTransportClosed: r.terminalTransportClosed,
  });
};
const exactAction = (value: unknown): PtyTransportAction => {
  const first = strictRecord(
    value,
    ownStringKeys(value, "testkit.pty.trace.action"),
    "testkit.pty.trace.action",
  );
  if (!finite(first.monotonicAtMs)) return fail("testkit.pty.trace.action");
  if (first.action === "resize") {
    const r = strictRecord(
      value,
      ["action", "geometry", "monotonicAtMs"],
      "testkit.pty.trace.action",
    );
    return Object.freeze({
      action: "resize",
      geometry: exactGeometry(r.geometry),
      monotonicAtMs: r.monotonicAtMs as number,
    });
  }
  if (first.action === "input") {
    const r = strictRecord(
      value,
      ["action", "byteLength", "inputSha256", "monotonicAtMs"],
      "testkit.pty.trace.action",
    );
    if (
      !integer(r.byteLength, 1_048_576) ||
      typeof r.inputSha256 !== "string" ||
      !sha256Pattern.test(r.inputSha256)
    )
      return fail("testkit.pty.trace.action");
    return Object.freeze({
      action: "input",
      byteLength: r.byteLength,
      inputSha256: r.inputSha256,
      monotonicAtMs: r.monotonicAtMs as number,
    });
  }
  if (first.action === "eof") {
    const r = strictRecord(
      value,
      ["action", "monotonicAtMs"],
      "testkit.pty.trace.action",
    );
    return Object.freeze({
      action: "eof",
      monotonicAtMs: r.monotonicAtMs as number,
    });
  }
  if (first.action === "interrupt-byte") {
    const r = strictRecord(
      value,
      ["action", "byte", "monotonicAtMs"],
      "testkit.pty.trace.action",
    );
    if (r.byte !== 3) return fail("testkit.pty.trace.action");
    return Object.freeze({
      action: "interrupt-byte",
      byte: 3,
      monotonicAtMs: r.monotonicAtMs as number,
    });
  }
  if (first.action === "signal") {
    const r = strictRecord(
      value,
      ["action", "monotonicAtMs", "signal", "targetStartIdentity"],
      "testkit.pty.trace.action",
    );
    if (
      (r.signal !== "SIGINT" &&
        r.signal !== "SIGTERM" &&
        r.signal !== "SIGKILL") ||
      typeof r.targetStartIdentity !== "string" ||
      !identifierPattern.test(r.targetStartIdentity)
    )
      return fail("testkit.pty.trace.action");
    return Object.freeze({
      action: "signal",
      monotonicAtMs: r.monotonicAtMs as number,
      signal: r.signal,
      targetStartIdentity: r.targetStartIdentity,
    });
  }
  return fail("testkit.pty.trace.action");
};

const expectedOutcome = (
  name: PtySemanticContractCaseName,
): Readonly<{
  diagnosticCode: PtySemanticDiagnosticCode | null;
  outcome: PtySemanticOutcome;
  semanticState: PtyTerminalSemanticSnapshot["semanticState"];
}> => {
  if (name === "pty:interactive-ready")
    return { diagnosticCode: null, outcome: "ready", semanticState: "ready" };
  if (name === "pty:interactive-completed")
    return {
      diagnosticCode: null,
      outcome: "completed",
      semanticState: "completed",
    };
  if (name === "pty:credential-prompt")
    return {
      diagnosticCode: "testkit.pty.credential-prompt",
      outcome: "rejected",
      semanticState: "credential-prompt",
    };
  if (name === "pty:malformed-control")
    return {
      diagnosticCode: "testkit.pty.malformed-control",
      outcome: "rejected",
      semanticState: "malformed-control",
    };
  if (name === "pty:output-limit")
    return {
      diagnosticCode: "testkit.pty.output-limit",
      outcome: "rejected",
      semanticState: "output-limit",
    };
  return {
    diagnosticCode: "testkit.pty.timeout",
    outcome: "timed-out",
    semanticState: "active",
  };
};
const expectedSnapshot = (
  name: PtySemanticContractCaseName,
): PtyTerminalSemanticSnapshot => {
  const limits =
    name === "pty:output-limit"
      ? { ...defaultPtyTerminalEmulatorLimits, maximumOutputBytes: 4 }
      : defaultPtyTerminalEmulatorLimits;
  const terminal = new BoundedTerminalEmulator(
    { columns: 80, rows: 24 },
    limits,
  );
  terminal.resize({ columns: 100, rows: 30 });
  const text =
    name === "pty:interactive-ready"
      ? "\u001b[?1049hAGENTSCOPE_PTY_READY"
      : name === "pty:interactive-completed"
        ? "AGENTSCOPE_PTY_COMPLETE"
        : name === "pty:credential-prompt"
          ? "Password: "
          : name === "pty:malformed-control"
            ? "\u001b["
            : name === "pty:output-limit"
              ? "1234"
              : "waiting";
  terminal.write(encoder.encode(text));
  if (name === "pty:output-limit")
    try {
      terminal.write(encoder.encode("5"));
    } catch {
      /* fixed categorical oracle */
    }
  return terminal.end();
};
const expectedActions = (
  request: PtySemanticContractRequest,
): readonly PtyTransportAction[] => {
  const at = request.monotonicStartupDeadlineMs - 100;
  const common = [
    Object.freeze({
      action: "resize",
      geometry: Object.freeze({ columns: 100, rows: 30 }),
      monotonicAtMs: at,
    }),
    Object.freeze({
      action: "input",
      byteLength: 7,
      inputSha256: digest("fixture"),
      monotonicAtMs: at + 1,
    }),
    Object.freeze({ action: "eof", monotonicAtMs: at + 2 }),
  ] as const;
  if (request.caseName === "pty:timeout-escalation")
    return Object.freeze([
      common[0],
      common[1],
      common[2],
      Object.freeze({
        action: "interrupt-byte",
        byte: 3,
        monotonicAtMs: request.monotonicExecutionDeadlineMs - 500,
      }),
      Object.freeze({
        action: "signal",
        monotonicAtMs: request.monotonicExecutionDeadlineMs - 400,
        signal: "SIGINT",
        targetStartIdentity: "fixture-root",
      }),
      Object.freeze({
        action: "signal",
        monotonicAtMs: request.monotonicExecutionDeadlineMs,
        signal: "SIGTERM",
        targetStartIdentity: "fixture-root",
      }),
      Object.freeze({
        action: "signal",
        monotonicAtMs:
          request.monotonicExecutionDeadlineMs + request.terminationGraceMs,
        signal: "SIGKILL",
        targetStartIdentity: "fixture-root",
      }),
    ]);
  return Object.freeze([common[0], common[1], common[2]]);
};
const canonicalJson = (value: unknown): string => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    const result = stringifyPrimitive(value);
    if (typeof result !== "string") return fail("testkit.pty.trace.canonical");
    return result;
  }
  if (arrayIsArray(value)) {
    let result = "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) result += ",";
      result += canonicalJson(value[index]);
    }
    return `${result}]`;
  }
  if (typeof value === "object" && value !== null) {
    let result = "{";
    let index = 0;
    const keys = objectKeys(value);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      const key = keys[keyIndex]!;
      const descriptor = ownPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !("value" in descriptor)
      )
        return fail("testkit.pty.trace.canonical");
      if (index > 0) result += ",";
      result += `${canonicalJson(key)}:${canonicalJson(descriptor.value)}`;
      index += 1;
    }
    return `${result}}`;
  }
  return fail("testkit.pty.trace.canonical");
};
const canonicalEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const validateTrace = (
  value: unknown,
  request: PtySemanticContractRequest,
  oracle: PtyTerminalSemanticSnapshot,
): PtySemanticTrace => {
  const r = strictRecord(
    value,
    [
      "actions",
      "caseName",
      "componentEvidenceOnly",
      "containmentAuthority",
      "diagnosticCode",
      "exactHarnessVersion",
      "executionMode",
      "finalSnapshot",
      "initialGeometry",
      "lifecycle",
      "outcome",
      "requestFingerprint",
      "retainedRawTerminalBytes",
      "returnedAtMs",
      "runId",
      "traceVersion",
    ],
    "testkit.pty.trace",
  );
  if (
    r.traceVersion !== 1 ||
    r.caseName !== request.caseName ||
    r.runId !== request.runId ||
    r.requestFingerprint !== request.requestFingerprint ||
    r.exactHarnessVersion !== componentVersion ||
    r.executionMode !== "interactive" ||
    r.componentEvidenceOnly !== true ||
    r.containmentAuthority !== "not-claimed" ||
    r.retainedRawTerminalBytes !== false ||
    !finite(r.returnedAtMs) ||
    r.returnedAtMs > request.monotonicShutdownDeadlineMs
  )
    return fail("testkit.pty.trace");
  const initialGeometry = exactGeometry(r.initialGeometry);
  if (!canonicalEqual(initialGeometry, request.initialGeometry))
    return fail("testkit.pty.trace.binding");
  const rawActions = strictArray(r.actions, "testkit.pty.trace");
  const reconstructedActions: PtyTransportAction[] = [];
  for (let index = 0; index < rawActions.length; index += 1)
    reconstructedActions[index] = exactAction(rawActions[index]);
  const actions = Object.freeze(reconstructedActions);
  let lateAction = false;
  for (let index = 0; index < actions.length; index += 1)
    if (actions[index]!.monotonicAtMs > r.returnedAtMs) lateAction = true;
  if (!canonicalEqual(actions, expectedActions(request)) || lateAction)
    return fail("testkit.pty.trace.action-oracle");
  const snapshot = validatePtyTerminalSemanticSnapshot(r.finalSnapshot);
  if (!canonicalEqual(snapshot, oracle))
    return fail("testkit.pty.trace.oracle");
  const lifecycle = exactLifecycle(r.lifecycle);
  if (
    lifecycle.cleanup !== "clean" ||
    !lifecycle.processJoined ||
    !lifecycle.terminalInputJoined ||
    !lifecycle.terminalOutputJoined ||
    !lifecycle.terminalTransportClosed ||
    lifecycle.residualProcessCount !== 0
  )
    return fail("testkit.pty.trace.cleanup");
  const expected = expectedOutcome(request.caseName);
  const returnedAtMs = r.returnedAtMs;
  const expectedReturnedAt =
    request.caseName === "pty:timeout-escalation"
      ? request.monotonicExecutionDeadlineMs + request.terminationGraceMs
      : request.monotonicExecutionDeadlineMs - 1;
  if (
    r.outcome !== expected.outcome ||
    r.diagnosticCode !== expected.diagnosticCode ||
    snapshot.semanticState !== expected.semanticState ||
    returnedAtMs !== expectedReturnedAt
  )
    return fail("testkit.pty.trace.oracle");
  return Object.freeze({
    traceVersion: 1,
    caseName: request.caseName,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    exactHarnessVersion: componentVersion,
    executionMode: "interactive",
    componentEvidenceOnly: true,
    containmentAuthority: "not-claimed",
    retainedRawTerminalBytes: false,
    initialGeometry,
    finalSnapshot: snapshot,
    actions,
    lifecycle,
    outcome: expected.outcome,
    diagnosticCode: expected.diagnosticCode,
    returnedAtMs,
  });
};
const encodeTrace = (
  value: unknown,
  request: PtySemanticContractRequest,
  snapshot: PtyTerminalSemanticSnapshot,
): PtySemanticTraceEnvelope => {
  const encoded = encoder.encode(
    canonicalJson(validateTrace(value, request, snapshot)),
  );
  if (encoded.byteLength > ptySemanticTraceEnvelopeLimitBytes)
    return fail("testkit.pty.trace.envelope-limit");
  return encoded;
};
const verifyEnvelope = (
  value: unknown,
  request: PtySemanticContractRequest,
  snapshot: PtyTerminalSemanticSnapshot,
): PtySemanticTrace => {
  let bytes: Uint8Array;
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      isProxy(value) ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype ||
      Object.getPrototypeOf((value as Uint8Array).buffer) !==
        ArrayBuffer.prototype
    )
      return fail("testkit.pty.trace.envelope");
    bytes = new Uint8Array(value as Uint8Array);
  } catch {
    return fail("testkit.pty.trace.envelope");
  }
  if (bytes.byteLength > ptySemanticTraceEnvelopeLimitBytes)
    return fail("testkit.pty.trace.envelope-limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return fail("testkit.pty.trace.envelope");
  }
  const trace = validateTrace(parsed, request, snapshot);
  const canonical = encoder.encode(canonicalJson(trace));
  let mismatch = canonical.byteLength !== bytes.byteLength;
  for (let index = 0; !mismatch && index < canonical.byteLength; index += 1)
    if (canonical[index] !== bytes[index]) mismatch = true;
  if (mismatch) return fail("testkit.pty.trace.envelope-canonical");
  return trace;
};
const createRequest = (
  caseName: PtySemanticContractCaseName,
): PtySemanticContractRequest => {
  const now = performance.now();
  const runId = randomUUID();
  return Object.freeze({
    requestVersion: 1,
    caseName,
    runId,
    requestFingerprint: digest(`${caseName}:${runId}`),
    initialGeometry: Object.freeze({ columns: 80, rows: 24 }),
    monotonicStartupDeadlineMs: now + 1_000,
    monotonicExecutionDeadlineMs: now + 2_000,
    monotonicShutdownDeadlineMs: now + 3_000,
    terminationGraceMs: 250,
  });
};

export const createPtySemanticContractSuite =
  (): readonly PtySemanticContractCase[] => {
    const names = [
      "pty:interactive-ready",
      "pty:interactive-completed",
      "pty:credential-prompt",
      "pty:malformed-control",
      "pty:output-limit",
      "pty:timeout-escalation",
    ] as const;
    const suite: PtySemanticContractCase[] = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      suite[index] = Object.freeze({
        name,
        instantiate: (): PtySemanticContractRun => {
          const request = createRequest(name);
          const snapshot = expectedSnapshot(name);
          return Object.freeze({
            request,
            encode: (trace: unknown) => encodeTrace(trace, request, snapshot),
            verify: (envelope: unknown) =>
              verifyEnvelope(envelope, request, snapshot),
          });
        },
      });
    }
    return Object.freeze(suite);
  };

export const validatePtyModeApplicability = (
  value: unknown,
): PtyModeApplicability => {
  const first = strictRecord(
    value,
    ownStringKeys(value, "testkit.pty.mode-applicability"),
    "testkit.pty.mode-applicability",
  );
  if (first.status === "not-applicable") {
    const exact = strictRecord(
      value,
      ["reason", "status"],
      "testkit.pty.mode-applicability",
    );
    if (exact.reason !== "no-documented-interactive-mode")
      return fail("testkit.pty.mode-applicability");
    return Object.freeze({
      status: "not-applicable",
      reason: "no-documented-interactive-mode",
    });
  }
  const exact = strictRecord(
    value,
    ["documentedMode", "exactHarnessVersion", "status"],
    "testkit.pty.mode-applicability",
  );
  if (
    exact.status !== "available" ||
    typeof exact.documentedMode !== "string" ||
    typeof exact.exactHarnessVersion !== "string" ||
    !identifierPattern.test(exact.documentedMode) ||
    !identifierPattern.test(exact.exactHarnessVersion)
  )
    return fail("testkit.pty.mode-applicability");
  return Object.freeze({
    status: "available",
    documentedMode: exact.documentedMode,
    exactHarnessVersion: exact.exactHarnessVersion,
  });
};
