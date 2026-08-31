import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
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
  | Readonly<{
      action: "eof";
      monotonicAtMs: number;
    }>
  | Readonly<{
      action: "interrupt-byte";
      byte: 3;
      monotonicAtMs: number;
    }>
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

export type PtySemanticContractCaseName =
  | "pty:interactive-ready"
  | "pty:interactive-completed"
  | "pty:credential-prompt"
  | "pty:malformed-control"
  | "pty:output-limit"
  | "pty:timeout-escalation";

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
const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const componentVersion = "component-fixture-v1" as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const fail = (code: string): never => {
  throw new PtySemanticContractError(code);
};
const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};
const nonNegativeInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= maximum;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const exactGeometry = (value: unknown): PtyTerminalGeometry => {
  if (
    !plainObject(value) ||
    !exactKeys(value, ["columns", "rows"]) ||
    !nonNegativeInteger(value.columns, 512) ||
    !nonNegativeInteger(value.rows, 512) ||
    value.columns === 0 ||
    value.rows === 0 ||
    value.columns * value.rows > 65_536
  )
    return fail("testkit.pty.trace.geometry");
  return value as PtyTerminalGeometry;
};
const exactLifecycle = (value: unknown): PtyLifecycleObservation => {
  if (
    !plainObject(value) ||
    !exactKeys(value, [
      "cleanup",
      "observationVersion",
      "processJoined",
      "residualProcessCount",
      "terminalInputJoined",
      "terminalOutputJoined",
      "terminalTransportClosed",
    ]) ||
    value.observationVersion !== 1 ||
    !["clean", "residual", "uncertain"].includes(value.cleanup as string) ||
    typeof value.processJoined !== "boolean" ||
    typeof value.terminalInputJoined !== "boolean" ||
    typeof value.terminalOutputJoined !== "boolean" ||
    typeof value.terminalTransportClosed !== "boolean" ||
    !nonNegativeInteger(value.residualProcessCount, 65_536)
  )
    return fail("testkit.pty.trace.lifecycle");
  return value as PtyLifecycleObservation;
};

const exactAction = (value: unknown): PtyTransportAction => {
  if (!plainObject(value) || !finite(value.monotonicAtMs))
    return fail("testkit.pty.trace.action");
  if (value.action === "resize") {
    if (!exactKeys(value, ["action", "geometry", "monotonicAtMs"]))
      return fail("testkit.pty.trace.action");
    exactGeometry(value.geometry);
  } else if (value.action === "input") {
    if (
      !exactKeys(value, [
        "action",
        "byteLength",
        "inputSha256",
        "monotonicAtMs",
      ]) ||
      !nonNegativeInteger(value.byteLength, 1_048_576) ||
      !sha256Pattern.test(value.inputSha256 as string)
    )
      return fail("testkit.pty.trace.action");
  } else if (value.action === "eof") {
    if (!exactKeys(value, ["action", "monotonicAtMs"]))
      return fail("testkit.pty.trace.action");
  } else if (value.action === "interrupt-byte") {
    if (
      !exactKeys(value, ["action", "byte", "monotonicAtMs"]) ||
      value.byte !== 3
    )
      return fail("testkit.pty.trace.action");
  } else if (value.action === "signal") {
    if (
      !exactKeys(value, [
        "action",
        "monotonicAtMs",
        "signal",
        "targetStartIdentity",
      ]) ||
      !["SIGINT", "SIGTERM", "SIGKILL"].includes(value.signal as string) ||
      !identifierPattern.test(value.targetStartIdentity as string)
    )
      return fail("testkit.pty.trace.action");
  } else return fail("testkit.pty.trace.action");
  return value as PtyTransportAction;
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

const traceRecord = (
  value: unknown,
  request: PtySemanticContractRequest,
): Record<string, unknown> => {
  if (
    !plainObject(value) ||
    !exactKeys(value, [
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
    ]) ||
    value.traceVersion !== 1 ||
    value.caseName !== request.caseName ||
    value.runId !== request.runId ||
    value.requestFingerprint !== request.requestFingerprint ||
    value.exactHarnessVersion !== componentVersion ||
    value.executionMode !== "interactive" ||
    value.componentEvidenceOnly !== true ||
    value.containmentAuthority !== "not-claimed" ||
    value.retainedRawTerminalBytes !== false ||
    !finite(value.returnedAtMs) ||
    value.returnedAtMs > request.monotonicShutdownDeadlineMs ||
    !Array.isArray(value.actions) ||
    value.actions.length > 128
  )
    return fail("testkit.pty.trace");
  return value;
};

const validateActions = (
  value: readonly unknown[],
  request: PtySemanticContractRequest,
): readonly PtyTransportAction[] => {
  const actions = value.map(exactAction);
  let previous = -Infinity;
  for (const action of actions) {
    if (
      action.monotonicAtMs < previous ||
      action.monotonicAtMs > request.monotonicShutdownDeadlineMs
    )
      return fail("testkit.pty.trace.action-order");
    previous = action.monotonicAtMs;
  }
  return actions;
};

const validateCleanLifecycle = (value: unknown): PtyLifecycleObservation => {
  const lifecycle = exactLifecycle(value);
  if (
    lifecycle.cleanup !== "clean" ||
    !lifecycle.processJoined ||
    !lifecycle.terminalInputJoined ||
    !lifecycle.terminalOutputJoined ||
    !lifecycle.terminalTransportClosed ||
    lifecycle.residualProcessCount !== 0
  )
    return fail("testkit.pty.trace.cleanup");
  return lifecycle;
};

const validateTrace = (
  value: unknown,
  request: PtySemanticContractRequest,
): PtySemanticTrace => {
  const trace = traceRecord(value, request);
  const initialGeometry = exactGeometry(trace.initialGeometry);
  if (
    initialGeometry.columns !== request.initialGeometry.columns ||
    initialGeometry.rows !== request.initialGeometry.rows
  )
    return fail("testkit.pty.trace.binding");
  const actions = validateActions(trace.actions as readonly unknown[], request);
  const snapshot = validatePtyTerminalSemanticSnapshot(trace.finalSnapshot);
  validateCleanLifecycle(trace.lifecycle);
  const expected = expectedOutcome(request.caseName);
  if (
    trace.outcome !== expected.outcome ||
    trace.diagnosticCode !== expected.diagnosticCode ||
    snapshot.semanticState !== expected.semanticState
  )
    return fail("testkit.pty.trace.oracle");
  if (request.caseName === "pty:timeout-escalation") {
    const signals = actions.filter(
      (action): action is Extract<PtyTransportAction, { action: "signal" }> =>
        action.action === "signal",
    );
    if (
      signals.length !== 2 ||
      signals[0]?.signal !== "SIGTERM" ||
      signals[1]?.signal !== "SIGKILL" ||
      signals[1].monotonicAtMs - signals[0].monotonicAtMs !==
        request.terminationGraceMs
    )
      return fail("testkit.pty.trace.escalation");
  }
  return trace as PtySemanticTrace;
};

const encodeTrace = (
  value: unknown,
  request: PtySemanticContractRequest,
): PtySemanticTraceEnvelope => {
  const trace = validateTrace(value, request);
  const encoded = encoder.encode(JSON.stringify(trace));
  if (encoded.byteLength > ptySemanticTraceEnvelopeLimitBytes)
    return fail("testkit.pty.trace.envelope-limit");
  return encoded;
};

const verifyEnvelope = (
  value: unknown,
  request: PtySemanticContractRequest,
): PtySemanticTrace => {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  )
    return fail("testkit.pty.trace.envelope");
  const bytes = value as Uint8Array;
  if (bytes.byteLength > ptySemanticTraceEnvelopeLimitBytes)
    return fail("testkit.pty.trace.envelope-limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return fail("testkit.pty.trace.envelope");
  }
  return validateTrace(parsed, request);
};

const createRequest = (
  caseName: PtySemanticContractCaseName,
): PtySemanticContractRequest => {
  const now = performance.now();
  const runId = randomUUID();
  return Object.freeze({
    requestVersion: 1 as const,
    caseName,
    runId,
    requestFingerprint: createHash("sha256")
      .update(`${caseName}:${runId}`)
      .digest("hex"),
    initialGeometry: Object.freeze({ columns: 80, rows: 24 }),
    monotonicStartupDeadlineMs: now + 1_000,
    monotonicExecutionDeadlineMs: now + 2_000,
    monotonicShutdownDeadlineMs: now + 3_000,
    terminationGraceMs: 250,
  });
};

export const createPtySemanticContractSuite =
  (): readonly PtySemanticContractCase[] =>
    (
      [
        "pty:interactive-ready",
        "pty:interactive-completed",
        "pty:credential-prompt",
        "pty:malformed-control",
        "pty:output-limit",
        "pty:timeout-escalation",
      ] as const
    ).map((name) =>
      Object.freeze({
        name,
        instantiate: (): PtySemanticContractRun => {
          const request = createRequest(name);
          return Object.freeze({
            request,
            encode: (trace: unknown) => encodeTrace(trace, request),
            verify: (envelope: unknown) => verifyEnvelope(envelope, request),
          });
        },
      }),
    );

export const validatePtyModeApplicability = (
  value: unknown,
): PtyModeApplicability => {
  if (!plainObject(value)) return fail("testkit.pty.mode-applicability");
  if (value.status === "not-applicable") {
    if (
      !exactKeys(value, ["reason", "status"]) ||
      value.reason !== "no-documented-interactive-mode"
    )
      return fail("testkit.pty.mode-applicability");
    return value as PtyModeApplicability;
  }
  if (
    value.status !== "available" ||
    !exactKeys(value, ["documentedMode", "exactHarnessVersion", "status"]) ||
    !identifierPattern.test(value.documentedMode as string) ||
    !identifierPattern.test(value.exactHarnessVersion as string)
  )
    return fail("testkit.pty.mode-applicability");
  return value as PtyModeApplicability;
};
