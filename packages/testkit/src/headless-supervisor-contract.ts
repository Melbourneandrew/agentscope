import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export class HeadlessSupervisorContractAssertionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "HeadlessSupervisorContractAssertionError";
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

export type HeadlessSupervisorContractRun = Readonly<{
  request: HeadlessExecutionRequest;
  verify: (trace: unknown) => HeadlessExecutionTrace;
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

type StrictRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const outputLimitBytes = 1_024;
const terminationGraceMs = 1_000;
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

const fixtures: Readonly<Record<HeadlessObserverScenario, string>> =
  Object.freeze({
    correct: String.raw`
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const environment = Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd(), environment, input }));
process.stderr.write("fixture-stderr");
`,
    "stdout-limit":
      'process.stdout.write("O".repeat(4096)); setInterval(() => {}, 1000);',
    "stderr-limit":
      'process.stderr.write("E".repeat(4096)); setInterval(() => {}, 1000);',
    timeout: String.raw`
process.stderr.write("PRIVATE_TIMEOUT_CANARY");
setTimeout(() => process.exit(71), 9000).unref();
setInterval(() => {}, 1000);
`,
    descendant: String.raw`
import { spawn } from "node:child_process";
const source = 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 9000).unref(); setInterval(() => {}, 1000);';
const child = spawn(process.execPath, ["-e", source], { detached: true, env: {}, stdio: "ignore" });
child.unref();
`,
  });

const fail = (code: string): never => {
  throw new HeadlessSupervisorContractAssertionError(code);
};

const assert = (condition: boolean, code: string): void => {
  if (!condition) fail(code);
};

const strictRecord = (value: unknown, code: string): StrictRecord => {
  if (typeof value !== "object" || value === null) return fail(code);
  let keys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(code);
  }
  assert(
    keys.every((key) => typeof key === "string"),
    code,
  );
  assert(
    Object.values(descriptors).every(
      (descriptor) =>
        descriptor.get === undefined &&
        descriptor.set === undefined &&
        Object.hasOwn(descriptor, "value"),
    ),
    code,
  );
  return Object.fromEntries(
    keys.map((key) => [key as string, descriptors[key as string]!.value]),
  );
};

const exactKeys = (
  value: StrictRecord,
  expected: readonly string[],
  code: string,
): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]),
    code,
  );
};

const strictArray = (value: unknown, code: string): readonly unknown[] => {
  if (!Array.isArray(value)) return fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = [...value.keys()].map(String);
  expected.push("length");
  const actual = Object.keys(descriptors).sort();
  assert(
    Reflect.ownKeys(value).every((key) => typeof key === "string") &&
      actual.length === expected.length &&
      actual.every((key, index) => key === expected.sort()[index]) &&
      Object.values(descriptors).every(
        (descriptor) =>
          descriptor.get === undefined && descriptor.set === undefined,
      ),
    code,
  );
  return value.slice();
};

const finiteTime = (value: unknown, code: string): number => {
  assert(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    code,
  );
  return value as number;
};

const readResult = (value: unknown): HeadlessExecutionResult => {
  const record = strictRecord(value, "testkit.headless.result.shape");
  exactKeys(record, resultKeys, "testkit.headless.result.shape");
  assert(record.resultVersion === 1, "testkit.headless.result.version");
  assert(
    ["exited", "output-limit", "timed-out", "cleanup-failed"].includes(
      record.outcome as string,
    ),
    "testkit.headless.result.outcome",
  );
  assert(
    record.exitCode === null ||
      (Number.isSafeInteger(record.exitCode) &&
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
  assert(
    record.stdout instanceof Uint8Array && record.stderr instanceof Uint8Array,
    "testkit.headless.result.output",
  );
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
    Number.isSafeInteger(record.residualProcessCount) &&
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
  return Object.freeze({
    resultVersion: 1,
    outcome: record.outcome as HeadlessExecutionOutcome,
    exitCode: record.exitCode as number | null,
    signal: record.signal as "SIGTERM" | "SIGKILL" | null,
    stdout: Uint8Array.from(record.stdout as Uint8Array),
    stderr: Uint8Array.from(record.stderr as Uint8Array),
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
): readonly HeadlessProcessIdentity[] => {
  const processes = strictArray(
    value,
    "testkit.headless.observer.processes",
  ).map((candidate) => {
    const process = strictRecord(
      candidate,
      "testkit.headless.observer.process",
    );
    exactKeys(
      process,
      ["pid", "role", "startIdentity"],
      "testkit.headless.observer.process",
    );
    assert(
      Number.isSafeInteger(process.pid) &&
        (process.pid as number) > 1 &&
        typeof process.startIdentity === "string" &&
        process.startIdentity.length > 0 &&
        process.startIdentity.length <= 256 &&
        (process.role === "root" || process.role === "descendant"),
      "testkit.headless.observer.process",
    );
    return Object.freeze({ ...process }) as HeadlessProcessIdentity;
  });
  const identities = processes.map(({ startIdentity }) => startIdentity);
  const pids = processes.map(({ pid }) => pid);
  assert(
    new Set(identities).size === identities.length &&
      new Set(pids).size === pids.length,
    "testkit.headless.observer.process",
  );
  assert(
    JSON.stringify(processes.map(({ role }) => role).sort()) ===
      JSON.stringify([...expectedRoles].sort()),
    "testkit.headless.observer.process-set",
  );
  return processes;
};

const expectedSignalKeys = (
  scenario: HeadlessObserverScenario,
  processes: readonly HeadlessProcessIdentity[],
): readonly string[] => {
  const root = processes.find(({ role }) => role === "root")!.startIdentity;
  const descendant = processes.find(
    ({ role }) => role === "descendant",
  )?.startIdentity;
  if (scenario === "correct") return [];
  if (scenario === "stdout-limit" || scenario === "stderr-limit")
    return [`SIGTERM:${root}`];
  if (scenario === "timeout") return [`SIGTERM:${root}`, `SIGKILL:${root}`];
  return [`SIGTERM:${descendant!}`, `SIGKILL:${descendant!}`];
};

const readSignals = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  processes: readonly HeadlessProcessIdentity[],
): readonly HeadlessObservedSignal[] => {
  const identities = processes.map(({ startIdentity }) => startIdentity);
  const signals = strictArray(value, "testkit.headless.observer.signals").map(
    (candidate) => {
      const signal = strictRecord(
        candidate,
        "testkit.headless.observer.signal",
      );
      exactKeys(
        signal,
        ["monotonicAtMs", "signal", "targetStartIdentity"],
        "testkit.headless.observer.signal",
      );
      assert(
        (signal.signal === "SIGTERM" || signal.signal === "SIGKILL") &&
          typeof signal.targetStartIdentity === "string" &&
          identities.includes(signal.targetStartIdentity),
        "testkit.headless.observer.signal",
      );
      return Object.freeze({
        signal: signal.signal,
        targetStartIdentity: signal.targetStartIdentity,
        monotonicAtMs: finiteTime(
          signal.monotonicAtMs,
          "testkit.headless.observer.signal",
        ),
      }) as HeadlessObservedSignal;
    },
  );
  const keys = signals.map(
    ({ signal, targetStartIdentity }) => `${signal}:${targetStartIdentity}`,
  );
  assert(
    new Set(keys).size === keys.length,
    "testkit.headless.observer.signal",
  );
  assert(
    signals.every(
      (signal, index) =>
        index === 0 ||
        signals[index - 1]!.monotonicAtMs <= signal.monotonicAtMs,
    ),
    "testkit.headless.observer.signal-order",
  );
  assert(
    JSON.stringify(keys) ===
      JSON.stringify(expectedSignalKeys(scenario, processes)),
    "testkit.headless.observer.signal-sequence",
  );
  return signals;
};

const readResiduals = (
  value: unknown,
  processes: readonly HeadlessProcessIdentity[],
): readonly string[] => {
  const identities = processes.map(({ startIdentity }) => startIdentity);
  const residuals = strictArray(
    value,
    "testkit.headless.observer.residual",
  ).map((identity) => {
    assert(
      typeof identity === "string" && identities.includes(identity),
      "testkit.headless.observer.residual",
    );
    return identity as string;
  });
  assert(
    new Set(residuals).size === residuals.length,
    "testkit.headless.observer.residual",
  );
  return residuals;
};

const readObservation = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): HeadlessProcessSetObservation => {
  const record = strictRecord(value, "testkit.headless.observer.shape");
  exactKeys(record, observationKeys, "testkit.headless.observer.shape");
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
  const processes = readProcesses(record.processes, roles);
  const signals = readSignals(record.signals, scenario, processes);
  const residuals = readResiduals(record.residualStartIdentities, processes);
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
  for (const key of [
    "processJoined",
    "stdinJoined",
    "stdoutJoined",
    "stderrJoined",
  ] as const)
    assert(
      typeof record[key] === "boolean",
      "testkit.headless.observer.handles",
    );
  return Object.freeze({
    observationVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    processes: Object.freeze(processes),
    signals: Object.freeze(signals),
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
    residualStartIdentities: Object.freeze(residuals),
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
  assert(
    observation.signals.every(
      ({ monotonicAtMs }) =>
        monotonicAtMs >= observation.readyAtMs &&
        monotonicAtMs <= observation.settledAtMs,
    ),
    "testkit.headless.observer.signal-window",
  );
  const termObserved = observation.signals.some(
    ({ signal }) => signal === "SIGTERM",
  );
  const killObserved = observation.signals.some(
    ({ signal }) => signal === "SIGKILL",
  );
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
    result.stdout.byteLength <= request.stdoutLimitBytes,
    "testkit.headless.stdout.bound",
  );
  assert(
    result.stderr.byteLength <= request.stderrLimitBytes,
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
      JSON.parse(decoder.decode(result.stdout)) as unknown,
      "testkit.headless.invocation.record",
    );
  } catch (error) {
    if (error instanceof HeadlessSupervisorContractAssertionError) throw error;
    return fail("testkit.headless.invocation.record");
  }
  exactKeys(
    invocation,
    ["arguments", "cwd", "environment", "input"],
    "testkit.headless.invocation.record",
  );
  assert(
    JSON.stringify(invocation.arguments) ===
      JSON.stringify(["argument one", "--literal=$VALUE"]),
    "testkit.headless.invocation.arguments",
  );
  assert(invocation.cwd === request.cwd, "testkit.headless.invocation.cwd");
  assert(
    JSON.stringify(invocation.environment) ===
      JSON.stringify(request.environment),
    "testkit.headless.invocation.environment",
  );
  assert(
    invocation.input === "oracle-stdin",
    "testkit.headless.invocation.stdin",
  );
  assert(
    decoder.decode(result.stderr) === "fixture-stderr",
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
          result.stdout.byteLength === request.stdoutLimitBytes
      : result.stderrTruncated &&
          result.stderr.byteLength === request.stderrLimitBytes,
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
  const root = observation.processes.find(({ role }) => role === "root")!;
  const [term, kill] = observation.signals;
  assert(
    term!.targetStartIdentity === root.startIdentity &&
      term!.monotonicAtMs >= request.monotonicExecutionDeadlineMs &&
      term!.monotonicAtMs >= observation.readyAtMs,
    "testkit.headless.timeout.early-term",
  );
  assert(
    kill!.targetStartIdentity === root.startIdentity &&
      kill!.monotonicAtMs >= term!.monotonicAtMs + request.terminationGraceMs,
    "testkit.headless.timeout.short-grace",
  );
};

const readTrace = (
  value: unknown,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): HeadlessExecutionTrace => {
  const record = strictRecord(value, "testkit.headless.trace.shape");
  exactKeys(record, traceKeys, "testkit.headless.trace.shape");
  assert(record.traceVersion === 1, "testkit.headless.trace.version");
  assert(
    record.runId === request.runId &&
      record.requestFingerprint === request.requestFingerprint,
    "testkit.headless.trace.binding",
  );
  const trace = Object.freeze({
    traceVersion: 1 as const,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    returnedAtMs: finiteTime(
      record.returnedAtMs,
      "testkit.headless.trace.timing",
    ),
    result: readResult(record.result),
    observation: readObservation(record.observation, scenario, request),
  });
  assertTerminalProtocol(trace, request);
  if (scenario === "correct") assertCorrect(trace.result, request);
  else if (scenario === "stdout-limit" || scenario === "stderr-limit")
    assertOutputLimit(
      trace.result,
      request,
      scenario.slice(0, -6) as "stdout" | "stderr",
    );
  else if (scenario === "timeout") assertTimeout(trace, request);
  else
    assert(
      trace.result.outcome === "exited" && trace.result.exitCode === 0,
      "testkit.headless.descendant.classification",
    );
  return trace;
};

const fingerprint = (value: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const instantiate = (
  scenario: HeadlessObserverScenario,
  input: Readonly<{ root: string; fixturePath: string }>,
): HeadlessSupervisorContractRun => {
  const now = performance.now();
  const common = Object.freeze({
    runId: randomUUID(),
    executable: process.execPath,
    arguments: Object.freeze(
      scenario === "correct"
        ? [input.fixturePath, "argument one", "--literal=$VALUE"]
        : [input.fixturePath],
    ),
    cwd: input.root,
    environment: Object.freeze({ AGENTSCOPE_ORACLE_VISIBLE: "visible-canary" }),
    stdin: encoder.encode("oracle-stdin"),
    stdoutLimitBytes: outputLimitBytes,
    stderrLimitBytes: outputLimitBytes,
    monotonicStartupDeadlineMs: now + 2_000,
    monotonicExecutionDeadlineMs: now + 5_000,
    monotonicShutdownDeadlineMs: now + 7_000,
    terminationGraceMs,
  });
  const requestFingerprint = fingerprint({
    ...common,
    stdin: Array.from(common.stdin),
  });
  const request = Object.freeze({ ...common, requestFingerprint });
  return Object.freeze({
    request,
    verify: (trace: unknown) => readTrace(trace, scenario, request),
  });
};

/**
 * Returns the synchronous, family-owned protocol cases. These cases verify only
 * closed plain-data traces. They do not execute a process, mint backend
 * authority, or establish execution, cancellation, cleanup, or join evidence.
 */
export const createBoundedHeadlessSupervisorContractSuite =
  (): readonly HeadlessSupervisorContractCase[] =>
    Object.freeze(
      (
        [
          ["headless:correct-invocation", "correct"],
          ["headless:stdout-limit", "stdout-limit"],
          ["headless:stderr-limit", "stderr-limit"],
          ["headless:timeout-escalation", "timeout"],
          ["headless:descendant-cleanup", "descendant"],
        ] as const
      ).map(([name, scenario]) =>
        Object.freeze({
          name,
          fixtureSource: fixtures[scenario],
          instantiate: (
            input: Readonly<{ root: string; fixturePath: string }>,
          ) => instantiate(scenario, input),
        }),
      ),
    );
