import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

export type HeadlessSupervisorContractCase = Readonly<{
  name: string;
  run: () => Promise<void>;
}>;

export class HeadlessSupervisorContractAssertionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "HeadlessSupervisorContractAssertionError";
  }
}

const observerBrand: unique symbol = Symbol("headless-observer-authority");

export type HeadlessProcessSetObserver = Readonly<{
  runId: string;
  observeTerminal: () => Promise<HeadlessProcessSetObservation>;
  readonly [observerBrand]: true;
}>;

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
  processSetObserver: HeadlessProcessSetObserver;
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

export type HeadlessObserverScenario =
  "correct" | "stdout-limit" | "stderr-limit" | "timeout" | "descendant";

export type HeadlessObserverPlan = Readonly<{
  runId: string;
  requestFingerprint: string;
  scenario: HeadlessObserverScenario;
  expectedRoles: readonly ("root" | "descendant")[];
  monotonicStartupDeadlineMs: number;
  monotonicExecutionDeadlineMs: number;
  monotonicShutdownDeadlineMs: number;
  terminationGraceMs: number;
}>;

export type HeadlessProcessSetObserverSource = Readonly<{
  observeTerminal: () => Promise<unknown>;
}>;

/** A trusted isolation backend supplies this separately from the adapter. */
export type HeadlessProcessSetObserverBackend = Readonly<{
  open: (plan: HeadlessObserverPlan) => HeadlessProcessSetObserverSource;
}>;

export type HeadlessSupervisorContractAdapter = Readonly<{
  run: (request: HeadlessExecutionRequest) => Promise<unknown>;
}>;

type StrictRecord = Record<string, unknown>;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const outputLimitBytes = 1_024;
const terminationGraceMs = 1_000;
const authorities = new WeakSet<object>();
const observerStates = new WeakMap<object, { active: boolean }>();
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
  "observationVersion",
] as const;

const correctFixture = String.raw`
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const environment = Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd(), environment, input }));
process.stderr.write("fixture-stderr");
`;
const stdoutLimitFixture =
  'process.stdout.write("O".repeat(4096)); setInterval(() => {}, 1000);';
const stderrLimitFixture =
  'process.stderr.write("E".repeat(4096)); setInterval(() => {}, 1000);';
const timeoutFixture = String.raw`
process.stderr.write("PRIVATE_TIMEOUT_CANARY");
setTimeout(() => process.exit(71), 9000).unref();
setInterval(() => {}, 1000);
`;
const descendantFixture = String.raw`
import { spawn } from "node:child_process";
const source = 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 9000).unref(); setInterval(() => {}, 1000);';
const child = spawn(process.execPath, ["-e", source], { detached: true, env: {}, stdio: "ignore" });
child.unref();
`;

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
  assert(
    Reflect.ownKeys(value).every((key) => typeof key === "string") &&
      Object.keys(descriptors).length === expected.length &&
      Object.keys(descriptors)
        .sort()
        .every((key, index) => key === expected.sort()[index]) &&
      Object.values(descriptors).every(
        ({ get, set }) => get === undefined && set === undefined,
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
  plan: HeadlessObserverPlan,
  processes: readonly HeadlessProcessIdentity[],
): readonly string[] => {
  const root = processes.find(({ role }) => role === "root")!.startIdentity;
  const descendant = processes.find(
    ({ role }) => role === "descendant",
  )?.startIdentity;
  if (plan.scenario === "correct") return [];
  if (plan.scenario === "stdout-limit" || plan.scenario === "stderr-limit")
    return [`SIGTERM:${root}`];
  if (plan.scenario === "timeout")
    return [`SIGTERM:${root}`, `SIGKILL:${root}`];
  return [`SIGTERM:${descendant!}`, `SIGKILL:${descendant!}`];
};

const readSignals = (
  value: unknown,
  plan: HeadlessObserverPlan,
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
      JSON.stringify(expectedSignalKeys(plan, processes)),
    "testkit.headless.observer.signal-sequence",
  );
  return signals;
};

const readResidualIdentities = (
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
  plan: HeadlessObserverPlan,
): HeadlessProcessSetObservation => {
  const record = strictRecord(value, "testkit.headless.observer.shape");
  exactKeys(record, observationKeys, "testkit.headless.observer.shape");
  assert(record.observationVersion === 1, "testkit.headless.observer.version");
  assert(
    record.runId === plan.runId &&
      record.requestFingerprint === plan.requestFingerprint,
    "testkit.headless.observer.binding",
  );
  const processes = readProcesses(record.processes, plan.expectedRoles);
  const signals = readSignals(record.signals, plan, processes);
  const residualStartIdentities = readResidualIdentities(
    record.residualStartIdentities,
    processes,
  );
  assert(
    record.cleanup === "clean" ||
      record.cleanup === "residual" ||
      record.cleanup === "uncertain",
    "testkit.headless.observer.cleanup",
  );
  assert(
    (record.cleanup === "clean" && residualStartIdentities.length === 0) ||
      (record.cleanup === "residual" && residualStartIdentities.length > 0) ||
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
    runId: plan.runId,
    requestFingerprint: plan.requestFingerprint,
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
    residualStartIdentities: Object.freeze(residualStartIdentities),
  });
};

const mintObserver = (
  source: HeadlessProcessSetObserverSource,
  plan: HeadlessObserverPlan,
  consumed: { value: boolean },
): HeadlessProcessSetObserver => {
  const state = { active: false };
  let snapshot: Promise<HeadlessProcessSetObservation> | undefined;
  const authority = Object.freeze({
    runId: plan.runId,
    observeTerminal: () => {
      if (state.active) consumed.value = true;
      snapshot ??= Promise.resolve()
        .then(() => source.observeTerminal())
        .then((value) => readObservation(value, plan));
      return snapshot;
    },
    [observerBrand]: true as const,
  });
  authorities.add(authority);
  observerStates.set(authority, state);
  return authority;
};

const assertAuthority = (observer: HeadlessProcessSetObserver): void => {
  assert(
    authorities.has(observer) && observer[observerBrand] === true,
    "testkit.headless.observer.authority",
  );
};

const setAdapterActive = (
  observer: HeadlessProcessSetObserver,
  active: boolean,
): void => {
  const state = observerStates.get(observer);
  assert(state !== undefined, "testkit.headless.observer.authority");
  state!.active = active;
};

const fingerprint = (value: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const makeRequest = (
  root: string,
  fixturePath: string,
  scenario: HeadlessObserverScenario,
  backend: HeadlessProcessSetObserverBackend,
): { request: HeadlessExecutionRequest; consumed: { value: boolean } } => {
  const now = performance.now();
  const runId = randomUUID();
  const expectedRoles = Object.freeze(
    scenario === "descendant"
      ? (["root", "descendant"] as const)
      : (["root"] as const),
  );
  const common = Object.freeze({
    runId,
    executable: process.execPath,
    arguments: Object.freeze(
      scenario === "correct"
        ? [fixturePath, "argument one", "--literal=$VALUE"]
        : [fixturePath],
    ),
    cwd: root,
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
  const plan = Object.freeze({
    runId,
    requestFingerprint,
    scenario,
    expectedRoles,
    monotonicStartupDeadlineMs: common.monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs: common.monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs: common.monotonicShutdownDeadlineMs,
    terminationGraceMs,
  });
  const consumed = { value: false };
  let source: HeadlessProcessSetObserverSource;
  try {
    source = backend.open(plan);
  } catch {
    return fail("testkit.headless.observer.open");
  }
  const observer = mintObserver(source, plan, consumed);
  return {
    request: Object.freeze({
      ...common,
      requestFingerprint,
      processSetObserver: observer,
    }),
    consumed,
  };
};

const withinDeadline = async <T>(
  promise: Promise<T>,
  deadlineMs: number,
  code: string,
): Promise<T> => {
  const controller = new AbortController();
  const remaining = Math.max(0, deadlineMs - performance.now());
  try {
    return await Promise.race([
      promise,
      delay(remaining, undefined, { signal: controller.signal }).then(() =>
        fail(code),
      ),
    ]);
  } catch (error) {
    if (error instanceof HeadlessSupervisorContractAssertionError) throw error;
    return fail(`${code}.failure`);
  } finally {
    controller.abort();
  }
};

const runObserved = async (
  adapter: HeadlessSupervisorContractAdapter,
  request: HeadlessExecutionRequest,
  consumed: { value: boolean },
): Promise<{
  result: HeadlessExecutionResult;
  observation: HeadlessProcessSetObservation;
  returnedAtMs: number;
}> => {
  assertAuthority(request.processSetObserver);
  const observer = request.processSetObserver;
  setAdapterActive(observer, true);
  let raw: unknown;
  try {
    raw = await withinDeadline(
      Promise.resolve().then(() => adapter.run(request)),
      request.monotonicShutdownDeadlineMs,
      "testkit.headless.adapter.deadline",
    );
  } finally {
    setAdapterActive(observer, false);
  }
  const returnedAtMs = performance.now();
  const result = readResult(raw);
  const observation = await withinDeadline(
    request.processSetObserver.observeTerminal(),
    request.monotonicShutdownDeadlineMs,
    "testkit.headless.observer.deadline",
  );
  assert(consumed.value, "testkit.headless.observer.not-consumed");
  return { result, observation, returnedAtMs };
};

const assertTerminal = (
  result: HeadlessExecutionResult,
  observation: HeadlessProcessSetObservation,
  request: HeadlessExecutionRequest,
  returnedAtMs: number,
): void => {
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

const withFixture = async (
  fixture: string,
  scenario: HeadlessObserverScenario,
  backend: HeadlessProcessSetObserverBackend,
  operation: (
    request: HeadlessExecutionRequest,
    consumed: { value: boolean },
  ) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-headless-oracle-"));
  const fixturePath = join(root, "fixture.mjs");
  await writeFile(fixturePath, fixture, { mode: 0o600 });
  try {
    const { request, consumed } = makeRequest(
      root,
      fixturePath,
      scenario,
      backend,
    );
    await operation(request, consumed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const assertCorrectCompletion = async (
  adapter: HeadlessSupervisorContractAdapter,
  backend: HeadlessProcessSetObserverBackend,
): Promise<void> =>
  withFixture(correctFixture, "correct", backend, async (base, consumed) => {
    const request = base;
    const observed = await runObserved(adapter, request, consumed);
    assertTerminal(
      observed.result,
      observed.observation,
      request,
      observed.returnedAtMs,
    );
    const { result } = observed;
    assert(
      result.outcome === "exited" &&
        result.exitCode === 0 &&
        result.signal === null &&
        result.diagnosticCode === null &&
        !result.stdoutTruncated &&
        !result.stderrTruncated &&
        !result.termRequested &&
        !result.killRequested,
      "testkit.headless.completion",
    );
    let invocation: StrictRecord;
    try {
      invocation = strictRecord(
        JSON.parse(decoder.decode(result.stdout)) as unknown,
        "testkit.headless.invocation.record",
      );
    } catch (error) {
      if (error instanceof HeadlessSupervisorContractAssertionError)
        throw error;
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
  });

const assertOutputLimit = async (
  adapter: HeadlessSupervisorContractAdapter,
  backend: HeadlessProcessSetObserverBackend,
  stream: "stdout" | "stderr",
): Promise<void> =>
  withFixture(
    stream === "stdout" ? stdoutLimitFixture : stderrLimitFixture,
    `${stream}-limit`,
    backend,
    async (request, consumed) => {
      const observed = await runObserved(adapter, request, consumed);
      assertTerminal(
        observed.result,
        observed.observation,
        request,
        observed.returnedAtMs,
      );
      const { result } = observed;
      assert(
        result.outcome === "output-limit" &&
          result.exitCode === null &&
          result.signal === "SIGTERM" &&
          result.diagnosticCode === "testkit.headless.output-limit" &&
          result.termRequested,
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
      const identity = observed.observation.processes.find(
        ({ role }) => role === "root",
      )!.startIdentity;
      assert(
        observed.observation.signals.some(
          (event) =>
            event.signal === "SIGTERM" &&
            event.targetStartIdentity === identity,
        ),
        "testkit.headless.observer.signal-sequence",
      );
    },
  );

const rootIdentity = (observation: HeadlessProcessSetObservation): string => {
  const root = observation.processes.find(({ role }) => role === "root");
  assert(root !== undefined, "testkit.headless.observer.process-set");
  return root!.startIdentity;
};

const requiredSignal = (
  observation: HeadlessProcessSetObservation,
  signal: "SIGTERM" | "SIGKILL",
  targetStartIdentity: string,
): HeadlessObservedSignal => {
  const event = observation.signals.find(
    (candidate) =>
      candidate.signal === signal &&
      candidate.targetStartIdentity === targetStartIdentity,
  );
  assert(event !== undefined, "testkit.headless.observer.signal-sequence");
  return event!;
};

const assertTimeout = async (
  adapter: HeadlessSupervisorContractAdapter,
  backend: HeadlessProcessSetObserverBackend,
): Promise<void> =>
  withFixture(timeoutFixture, "timeout", backend, async (request, consumed) => {
    const observed = await runObserved(adapter, request, consumed);
    assertTerminal(
      observed.result,
      observed.observation,
      request,
      observed.returnedAtMs,
    );
    const { result, observation } = observed;
    assert(
      result.outcome === "timed-out" &&
        result.exitCode === null &&
        result.signal === "SIGKILL" &&
        result.diagnosticCode === "testkit.headless.timeout",
      "testkit.headless.timeout.classification",
    );
    assert(
      result.termRequested && result.killRequested,
      "testkit.headless.timeout.escalation",
    );
    const identity = rootIdentity(observation);
    const term = requiredSignal(observation, "SIGTERM", identity);
    const kill = requiredSignal(observation, "SIGKILL", identity);
    assert(
      term.monotonicAtMs >= request.monotonicExecutionDeadlineMs &&
        term.monotonicAtMs >= observation.readyAtMs,
      "testkit.headless.timeout.early-term",
    );
    assert(
      kill.monotonicAtMs >= term.monotonicAtMs + request.terminationGraceMs,
      "testkit.headless.timeout.short-grace",
    );
    assert(
      kill.monotonicAtMs <= request.monotonicShutdownDeadlineMs &&
        observation.settledAtMs >= kill.monotonicAtMs,
      "testkit.headless.timeout.settlement",
    );
  });

const assertDescendant = async (
  adapter: HeadlessSupervisorContractAdapter,
  backend: HeadlessProcessSetObserverBackend,
): Promise<void> =>
  withFixture(
    descendantFixture,
    "descendant",
    backend,
    async (request, consumed) => {
      const observed = await runObserved(adapter, request, consumed);
      assertTerminal(
        observed.result,
        observed.observation,
        request,
        observed.returnedAtMs,
      );
      assert(
        observed.result.outcome === "exited" && observed.result.exitCode === 0,
        "testkit.headless.descendant.classification",
      );
      assert(
        observed.result.termRequested && observed.result.killRequested,
        "testkit.headless.descendant.escalation",
      );
      const identity = observed.observation.processes.find(
        ({ role }) => role === "descendant",
      )!.startIdentity;
      const term = requiredSignal(observed.observation, "SIGTERM", identity);
      const kill = requiredSignal(observed.observation, "SIGKILL", identity);
      assert(
        kill.monotonicAtMs >= term.monotonicAtMs + request.terminationGraceMs,
        "testkit.headless.descendant.short-grace",
      );
    },
  );

/**
 * Creates the bounded non-PTY component oracle. The family owns stimuli,
 * deadlines, run binding, and pass criteria. The separately supplied trusted
 * backend mints raw observations; adapters can consume but cannot mint or
 * replace the runtime-authenticated observer authority.
 */
export const createBoundedHeadlessSupervisorContractSuite = (
  adapter: HeadlessSupervisorContractAdapter,
  backend: HeadlessProcessSetObserverBackend,
): readonly HeadlessSupervisorContractCase[] =>
  Object.freeze([
    Object.freeze({
      name: "headless:correct-invocation",
      run: () => assertCorrectCompletion(adapter, backend),
    }),
    Object.freeze({
      name: "headless:stdout-limit",
      run: () => assertOutputLimit(adapter, backend, "stdout"),
    }),
    Object.freeze({
      name: "headless:stderr-limit",
      run: () => assertOutputLimit(adapter, backend, "stderr"),
    }),
    Object.freeze({
      name: "headless:timeout-escalation",
      run: () => assertTimeout(adapter, backend),
    }),
    Object.freeze({
      name: "headless:descendant-cleanup",
      run: () => assertDescendant(adapter, backend),
    }),
  ]);
