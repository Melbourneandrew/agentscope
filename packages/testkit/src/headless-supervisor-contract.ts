import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

export type HeadlessExecutionRequest = Readonly<{
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

export type HeadlessSupervisorContractAdapter = Readonly<{
  run: (request: HeadlessExecutionRequest) => Promise<unknown>;
}>;

type StrictRecord = Record<string, unknown>;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const outputLimitBytes = 1_024;
const resultKeys = Object.freeze([
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
]);

const correctFixture = String.raw`
import { readFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const environment = Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
process.stdout.write(JSON.stringify({ arguments: process.argv.slice(2), cwd: process.cwd(), environment, input }));
process.stderr.write("fixture-stderr");
`;

const stdoutLimitFixture = String.raw`
process.stdout.write("O".repeat(4096));
setInterval(() => {}, 1000);
`;

const stderrLimitFixture = String.raw`
process.stderr.write("E".repeat(4096));
setInterval(() => {}, 1000);
`;

const timeoutFixture = String.raw`
import { appendFileSync } from "node:fs";
const ledger = process.env.AGENTSCOPE_ORACLE_LEDGER;
if (!ledger) process.exit(70);
appendFileSync(ledger, "started:" + process.pid + "\n");
process.on("SIGTERM", () => appendFileSync(ledger, "term\n"));
process.stderr.write("PRIVATE_TIMEOUT_CANARY");
setTimeout(() => process.exit(71), 9000).unref();
setInterval(() => {}, 1000);
`;

const descendantFixture = String.raw`
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const ledger = process.env.AGENTSCOPE_ORACLE_LEDGER;
if (!ledger) process.exit(70);
const source = 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 9000).unref(); setInterval(() => {}, 1000);';
const child = spawn(process.execPath, ["-e", source], { detached: true, env: {}, stdio: "ignore" });
appendFileSync(ledger, "descendant:" + child.pid + "\n");
child.unref();
`;

const assert = (condition: boolean, code: string): void => {
  if (!condition) throw new HeadlessSupervisorContractAssertionError(code);
};

const strictRecord = (value: unknown, code: string): StrictRecord => {
  if (typeof value !== "object" || value === null)
    throw new HeadlessSupervisorContractAssertionError(code);
  let keys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new HeadlessSupervisorContractAssertionError(code);
  }
  assert(
    keys.every((key) => typeof key === "string"),
    code,
  );
  assert(
    Object.values(descriptors).every(
      (descriptor) =>
        Object.hasOwn(descriptor, "value") &&
        descriptor.get === undefined &&
        descriptor.set === undefined,
    ),
    code,
  );
  return Object.fromEntries(
    keys.map((key) => [key as string, descriptors[key as string]!.value]),
  );
};

const exactKeys = (
  record: StrictRecord,
  expected: readonly string[],
  code: string,
): void => {
  const actual = Object.keys(record).sort();
  assert(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    code,
  );
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
  const expectedDiagnostic = {
    exited: null,
    "output-limit": "testkit.headless.output-limit",
    "timed-out": "testkit.headless.timeout",
    "cleanup-failed": "testkit.headless.cleanup",
  }[record.outcome as HeadlessExecutionOutcome];
  assert(
    record.diagnosticCode === expectedDiagnostic,
    "testkit.headless.result.diagnostic",
  );
  return record as unknown as HeadlessExecutionResult;
};

const assertBounded = (
  result: HeadlessExecutionResult,
  request: HeadlessExecutionRequest,
): void => {
  assert(
    result.stdout.byteLength <= request.stdoutLimitBytes,
    "testkit.headless.stdout.bound",
  );
  assert(
    result.stderr.byteLength <= request.stderrLimitBytes,
    "testkit.headless.stderr.bound",
  );
};

const assertClean = (result: HeadlessExecutionResult): void => {
  assert(
    result.cleanup === "clean" && result.residualProcessCount === 0,
    "testkit.headless.cleanup.complete",
  );
};

const makeRequest = (
  root: string,
  fixturePath: string,
  ledgerPath: string,
  arguments_: readonly string[] = [],
): HeadlessExecutionRequest => {
  const now = performance.now();
  // These are aggregate-safe component-test authorities, not product latency
  // claims. The timeout fixture ledger independently proves process readiness.
  return Object.freeze({
    executable: process.execPath,
    arguments: Object.freeze([fixturePath, ...arguments_]),
    cwd: root,
    environment: Object.freeze({
      AGENTSCOPE_ORACLE_LEDGER: ledgerPath,
      AGENTSCOPE_ORACLE_VISIBLE: "visible-canary",
    }),
    stdin: encoder.encode("oracle-stdin"),
    stdoutLimitBytes: outputLimitBytes,
    stderrLimitBytes: outputLimitBytes,
    monotonicStartupDeadlineMs: now + 2_000,
    monotonicExecutionDeadlineMs: now + 5_000,
    monotonicShutdownDeadlineMs: now + 7_000,
  });
};

const withFixture = async (
  source: string,
  operation: (
    request: HeadlessExecutionRequest,
    ledgerPath: string,
  ) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "agentscope-headless-oracle-"));
  const fixturePath = join(root, "fixture.mjs");
  const ledgerPath = join(root, "ledger.txt");
  await writeFile(fixturePath, source, { mode: 0o600 });
  try {
    await operation(makeRequest(root, fixturePath, ledgerPath), ledgerPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const readLedger = async (path: string, code: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new HeadlessSupervisorContractAssertionError(code);
  }
};

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const awaitFixtureExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (!processExists(pid)) return;
    await delay(10);
  }
  throw new HeadlessSupervisorContractAssertionError(
    "testkit.headless.fixture.cleanup",
  );
};

const readPid = (ledger: string, prefix: string, code: string): number => {
  const line = ledger
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  const pid = Number(line?.slice(prefix.length));
  assert(Number.isSafeInteger(pid) && pid > 1, code);
  return pid;
};

const assertCorrectCompletion = async (
  adapter: HeadlessSupervisorContractAdapter,
): Promise<void> => {
  await withFixture(correctFixture, async (baseRequest) => {
    const request = Object.freeze({
      ...baseRequest,
      arguments: Object.freeze([
        baseRequest.arguments[0]!,
        "argument one",
        "--literal=$VALUE",
      ]),
    });
    const result = readResult(await adapter.run(request));
    assertBounded(result, request);
    assertClean(result);
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
    let observed: StrictRecord;
    try {
      observed = strictRecord(
        JSON.parse(decoder.decode(result.stdout)) as unknown,
        "testkit.headless.invocation.record",
      );
    } catch (error) {
      if (error instanceof HeadlessSupervisorContractAssertionError)
        throw error;
      throw new HeadlessSupervisorContractAssertionError(
        "testkit.headless.invocation.record",
      );
    }
    exactKeys(
      observed,
      ["arguments", "cwd", "environment", "input"],
      "testkit.headless.invocation.record",
    );
    assert(
      JSON.stringify(observed.arguments) ===
        JSON.stringify(["argument one", "--literal=$VALUE"]),
      "testkit.headless.invocation.arguments",
    );
    assert(observed.cwd === request.cwd, "testkit.headless.invocation.cwd");
    assert(
      JSON.stringify(observed.environment) ===
        JSON.stringify(request.environment),
      "testkit.headless.invocation.environment",
    );
    assert(
      observed.input === "oracle-stdin",
      "testkit.headless.invocation.stdin",
    );
    assert(
      decoder.decode(result.stderr) === "fixture-stderr",
      "testkit.headless.invocation.stderr",
    );
  });
};

const assertOutputLimit = async (
  adapter: HeadlessSupervisorContractAdapter,
  stream: "stdout" | "stderr",
): Promise<void> => {
  const source = stream === "stdout" ? stdoutLimitFixture : stderrLimitFixture;
  await withFixture(source, async (request) => {
    const result = readResult(await adapter.run(request));
    assertBounded(result, request);
    assertClean(result);
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
  });
};

const assertTimeoutEscalation = async (
  adapter: HeadlessSupervisorContractAdapter,
): Promise<void> => {
  await withFixture(timeoutFixture, async (request, ledgerPath) => {
    const result = readResult(await adapter.run(request));
    assertBounded(result, request);
    assertClean(result);
    const ledger = await readLedger(
      ledgerPath,
      "testkit.headless.timeout.ledger",
    );
    const pid = readPid(ledger, "started:", "testkit.headless.timeout.ledger");
    try {
      assert(
        result.outcome === "timed-out" &&
          result.exitCode === null &&
          result.signal === "SIGKILL" &&
          result.diagnosticCode === "testkit.headless.timeout",
        "testkit.headless.timeout.classification",
      );
      assert(
        result.termRequested &&
          result.killRequested &&
          ledger.includes("term\n"),
        "testkit.headless.timeout.escalation",
      );
      assert(!processExists(pid), "testkit.headless.timeout.cleanup");
    } finally {
      await awaitFixtureExit(pid);
    }
  });
};

const assertDescendantCleanup = async (
  adapter: HeadlessSupervisorContractAdapter,
): Promise<void> => {
  await withFixture(descendantFixture, async (request, ledgerPath) => {
    const result = readResult(await adapter.run(request));
    assertBounded(result, request);
    const ledger = await readLedger(
      ledgerPath,
      "testkit.headless.descendant.ledger",
    );
    const pid = readPid(
      ledger,
      "descendant:",
      "testkit.headless.descendant.ledger",
    );
    try {
      assertClean(result);
      assert(
        result.outcome === "exited" && result.exitCode === 0,
        "testkit.headless.descendant.classification",
      );
      assert(
        result.termRequested && result.killRequested,
        "testkit.headless.descendant.escalation",
      );
      assert(!processExists(pid), "testkit.headless.descendant.cleanup");
    } finally {
      await awaitFixtureExit(pid);
    }
  });
};

/**
 * Creates the bounded non-PTY component contract that the shared supervisor must
 * pass. The family owns every executable stimulus and expected fact; callers
 * provide only the execution implementation under test.
 */
export const createBoundedHeadlessSupervisorContractSuite = (
  adapter: HeadlessSupervisorContractAdapter,
): readonly HeadlessSupervisorContractCase[] =>
  Object.freeze([
    Object.freeze({
      name: "headless:correct-invocation",
      run: () => assertCorrectCompletion(adapter),
    }),
    Object.freeze({
      name: "headless:stdout-limit",
      run: () => assertOutputLimit(adapter, "stdout"),
    }),
    Object.freeze({
      name: "headless:stderr-limit",
      run: () => assertOutputLimit(adapter, "stderr"),
    }),
    Object.freeze({
      name: "headless:timeout-escalation",
      run: () => assertTimeoutEscalation(adapter),
    }),
    Object.freeze({
      name: "headless:descendant-cleanup",
      run: () => assertDescendantCleanup(adapter),
    }),
  ]);
