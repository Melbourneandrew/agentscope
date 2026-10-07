import { types } from "node:util";
import {
  classifyCodexCollectedChildFailure,
  decodeAdapterReportedFailureMarker,
  encodeAdapterReportedFailureMarker,
  extractAdapterReportedFailure,
  projectAdapterReportedFailure,
} from "../codex-pty-research.mjs";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  classifyCodexTraceGetFailure,
  codexTraceGetChildFailureCategory,
} from "../codex-runtime-evidence.mjs";
// Private integration JavaScript has no package declaration surface.
// @ts-expect-error no declaration file is published for this private module
import * as authority from "../immutable-candidate-authority.mjs";

const root = resolve(import.meta.dirname, "..");
const readIntegration = (name: string): string =>
  readFileSync(resolve(root, name), "utf8");
describe("adapter-reported unavailable scalar projection (not settlement authority)", () => {
  it("retains only a complete canonical five-field invocation observation and rejects partial vectors", () => {
    const source = readIntegration("codex-trace-child-diagnostics.mjs");
    const end = source.indexOf("export const codexTraceSearchUnavailable");
    expect(end).toBeGreaterThan(0);
    const functions = runInNewContext(
      `${source.slice(0, end).replace('import { types } from "node:util";', "").replaceAll("export const", "const")}\n({codexTraceGetAdapterReportedFailure, codexTraceGetChildFailureCategory})`,
      { Buffer, TextDecoder, types },
    ) as {
      codexTraceGetAdapterReportedFailure: (
        observation: ReturnType<typeof observe>,
      ) => unknown;
      codexTraceGetChildFailureCategory: (
        observation: ReturnType<typeof observe>,
      ) => string;
    };
    const original = JSON.parse(diagnostic(false).toString()) as {
      facts: Record<string, unknown>;
    };
    const reported = {
      retrieverReportedStage: 11,
      retrieverCutoffExpired: false,
      retrieverWorkerJoined: true,
      retrieverWatchdogJoined: null,
      retrieverLeaseReleased: false,
    };
    const bytes = (facts: Record<string, unknown>) =>
      Buffer.from(`${JSON.stringify({ ...original, facts })}\n`);
    for (const stage of Array.from({ length: 14 }, (_, index) => index + 1)) {
      const facts = {
        ...original.facts,
        ...reported,
        retrieverReportedStage: stage,
      };
      const observation = observe(bytes(facts));
      expect(functions.codexTraceGetChildFailureCategory(observation)).toBe(
        "invoke-get",
      );
      expect(
        functions.codexTraceGetAdapterReportedFailure(observation),
      ).toEqual({
        stage,
        cutoffExpired: false,
        workerJoined: true,
        watchdogJoined: null,
        leaseReleased: false,
      });
    }
    for (const changed of [
      { retrieverReportedStage: 0 },
      { retrieverReportedStage: 15 },
      { retrieverReportedStage: 1.5 },
      { retrieverCutoffExpired: null },
      { retrieverWorkerJoined: "CANARY" },
      { retrieverLeaseReleased: 1 },
      { retrieverPreparationFailed: true },
      { retrieverInvocationFailed: false },
      { privateCanary: "secret" },
    ]) {
      const observation = observe(
        bytes({ ...original.facts, ...reported, ...changed }),
      );
      expect(functions.codexTraceGetChildFailureCategory(observation)).toBe(
        "exit",
      );
      expect(
        functions.codexTraceGetAdapterReportedFailure(observation),
      ).toBeUndefined();
    }
    for (const key of Object.keys(reported)) {
      const partial: Record<string, unknown> = {
        ...original.facts,
        ...reported,
      };
      delete partial[key];
      expect(
        functions.codexTraceGetAdapterReportedFailure(observe(bytes(partial))),
      ).toBeUndefined();
      expect(
        functions.codexTraceGetChildFailureCategory(observe(bytes(partial))),
      ).toBe("exit");
    }
    expect(
      functions.codexTraceGetAdapterReportedFailure(observe(diagnostic(false))),
    ).toBeUndefined();
  });
});
const { decodeInteractiveFailureExitCode, encodeInteractiveFailureExitCode } =
  authority as unknown as {
    decodeInteractiveFailureExitCode: (
      code: number,
      scenario: string,
    ) => string | undefined;
    encodeInteractiveFailureExitCode: (
      predicate: string,
      scenario: string,
    ) => number | undefined;
  };
const diagnostic = (preparation: boolean) =>
  Buffer.from(
    `${JSON.stringify({
      category: "unavailable",
      code: "traces.unavailable",
      command: "agentscope traces get",
      schema: "agentscope.cli.diagnostic.v1",
      facts: {
        retrieverPreparationFailed: preparation,
        retrieverInvocationFailed: !preparation,
      },
    })}\n`,
  );
const observe = (stderr: Buffer, changes = {}) => ({
  code: 5,
  deadlineExpired: false,
  signal: null,
  stderrBytes: stderr.length,
  stdoutBytes: 0,
  maximumBytes: 1024 * 1024,
  stderr,
  stdout: Buffer.alloc(0),
  ...changes,
});

describe("prospective trace-get failure phase (never acceptance)", () => {
  it.each([true, false])(
    "projects only complementary owned booleans: %s",
    (preparation) => {
      const phase = preparation ? "prepare-retriever" : "invoke-get";
      expect(
        codexTraceGetChildFailureCategory(observe(diagnostic(preparation))),
      ).toBe(phase);
      const withRetry = Buffer.from(
        diagnostic(preparation)
          .toString()
          .replace('"facts":{', '"facts":{"retryAfterMilliseconds":250,'),
      );
      expect(codexTraceGetChildFailureCategory(observe(withRetry))).toBe(phase);
      expect(
        classifyCodexTraceGetFailure(
          `integration.codex.trace-get-child-${phase}`,
        ),
      ).toBe(`child-${phase}`);
    },
  );
  it("keeps every old trace-get ordinal and appends only two diagnoses", () => {
    const prior = [
      "locator-input",
      "child-spawn",
      "child-deadline",
      "child-signal",
      "child-exit",
      "child-output-limit",
      "terminal-deadline",
      "machine-output",
      "record-count",
      "locator-result",
      "unclassified",
    ];
    for (const [index, kind] of prior.entries()) {
      const name = `integration.fixture.codex-verify-trace-get-${kind}`;
      expect(
        encodeInteractiveFailureExitCode(name, "codex-tui-trace-smoke"),
      ).toBe(177 + index);
      expect(
        decodeInteractiveFailureExitCode(177 + index, "codex-tui-trace-smoke"),
      ).toBe(name);
    }
    for (const [index, phase] of [
      "prepare-retriever",
      "invoke-get",
    ].entries()) {
      const name = `integration.fixture.codex-verify-trace-get-child-${phase}`;
      expect(
        encodeInteractiveFailureExitCode(name, "codex-tui-trace-smoke"),
      ).toBe(188 + index);
      expect(
        decodeInteractiveFailureExitCode(188 + index, "codex-tui-trace-smoke"),
      ).toBe(name);
      expect(
        encodeInteractiveFailureExitCode(name, "unrelated"),
      ).toBeUndefined();
    }
  });
});

describe("trace-get refusal and outcome precedence", () => {
  it("discards malformed, duplicate, substituted and canary-bearing output", () => {
    const good = diagnostic(true).toString();
    const canary = "TRACE_GET_SECRET_CANARY";
    const cases = [
      Buffer.alloc(0),
      Buffer.from(canary),
      Buffer.from("x".repeat(4097)),
      Buffer.from(good.trimEnd()),
      Buffer.from(`\uFEFF${good}`),
      Buffer.from([0xff]),
      Buffer.from(
        good.replace(
          '"category":"unavailable"',
          '"category":"foreign","category":"unavailable"',
        ),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          '"retrieverPreparationFailed":true,"retrieverPreparationFailed":true',
        ),
      ),
      Buffer.from(good.replace('"unavailable"', '"unknown"')),
      Buffer.from(
        good.replace('"agentscope traces get"', '"agentscope traces search"'),
      ),
      Buffer.from(good.replace('"agentscope.cli.diagnostic.v1"', '"foreign"')),
      Buffer.from(good.replace('"retrieverPreparationFailed":true,', "")),
      Buffer.from(
        good.replace(
          '"retrieverInvocationFailed":false',
          '"retrieverInvocationFailed":true',
        ),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          '"retrieverPreparationFailed":false',
        ),
      ),
      Buffer.from(
        good.replace('"facts":{', '"facts":{"retryAfterMilliseconds":-1,'),
      ),
      Buffer.from(
        good.replace(
          '"facts":{',
          '"facts":{"retryAfterMilliseconds":"canary",',
        ),
      ),
      Buffer.from(
        good.replace('"facts":{', '"facts":{"retryAfterMilliseconds":1e400,'),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          `"retrieverPreparationFailed":"${canary}"`,
        ),
      ),
      Buffer.from(
        good.replace(
          '"retrieverPreparationFailed":true',
          `"unknown":"${canary}","retrieverPreparationFailed":true`,
        ),
      ),
    ];
    for (const stderr of cases) {
      const result = codexTraceGetChildFailureCategory(observe(stderr));
      expect(result).toBe("exit");
      expect(result.includes(canary)).toBe(false);
    }
  });
  it("preserves terminal outcome and byte-accounting precedence", () => {
    const stderr = diagnostic(true);
    for (const changes of [
      { code: 1 },
      { stdout: Buffer.from("canary"), stdoutBytes: 6 },
      { stderrBytes: stderr.length - 1 },
    ])
      expect(codexTraceGetChildFailureCategory(observe(stderr, changes))).toBe(
        "exit",
      );
    expect(
      codexTraceGetChildFailureCategory(
        observe(stderr, { deadlineExpired: true }),
      ),
    ).toBe("deadline");
    expect(
      codexTraceGetChildFailureCategory(observe(stderr, { signal: "SIGKILL" })),
    ).toBe("signal");
    expect(
      codexTraceGetChildFailureCategory(observe(stderr, { maximumBytes: 1 })),
    ).toBe("output-limit");
  });
});

const actualRun = (primary?: Error) => {
  const source = readIntegration("codex-pty-scenario.mjs");
  const start = source.indexOf("const run = (executable");
  const end = source.indexOf("const agentscope =", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const child = Object.assign(new EventEmitter(), {
    pid: 100,
    stdout: Object.assign(new EventEmitter(), { destroy: () => {} }),
    stderr: Object.assign(new EventEmitter(), { destroy: () => {} }),
    kill: () => {},
  });
  let remainingCalls = 0,
    timerBudget = 0,
    cleared = false;
  const context = {
    Buffer,
    process: { env: {} },
    maximumOutput: 1024 * 1024,
    bootNow: () => 100,
    spawn: () => child,
    remaining: () => {
      if (++remainingCalls === 2 && primary) throw primary;
    },
    setTimeout: (_callback: () => void, budget: number) => {
      timerBudget = budget;
      return 1;
    },
    clearTimeout: () => {
      cleared = true;
    },
    adapterReportedFailure: undefined,
    classifyCodexCollectedChildFailure,
    codexTraceSearchUnavailable: () => false,
    codexTraceSearchTimedOut: () => false,
    invoke: undefined as undefined | (() => Promise<unknown>),
  };
  runInNewContext(
    `${source.slice(start, end)}\ninvoke = () => run("closed", [], {monotonicDeadline: 600, traceGetDiagnostic: true});`,
    context,
  );
  return {
    context,
    child,
    run: () => context.invoke?.(),
    facts: () => ({ remainingCalls, timerBudget, cleared }),
  };
};

describe("actual collected-child failure wiring", () => {
  it("rejects the child with only a fixed phase and the original finite budget", async () => {
    const fixture = actualRun();
    const completion = fixture.run();
    fixture.child.stderr.emit("data", diagnostic(false));
    fixture.child.emit("close", 5, null);
    await expect(completion).rejects.toThrow(
      "integration.codex.trace-get-child-invoke-get",
    );
    expect(fixture.facts()).toEqual({
      remainingCalls: 2,
      timerBudget: 500,
      cleared: true,
    });
  });
  it("preserves an original cutoff failure by exact identity", async () => {
    const primary = new Error("synthetic-cutoff");
    const fixture = actualRun(primary);
    const completion = fixture.run();
    fixture.child.stderr.emit("data", diagnostic(true));
    fixture.child.emit("close", 5, null);
    await expect(completion).rejects.toBe(primary);
    expect(fixture.facts()).toEqual({
      remainingCalls: 2,
      timerBudget: 500,
      cleared: true,
    });
  });
});

describe("run-bound adapter-reported failure diagnostics", () => {
  const runId = "0123456789abcdef";
  const predicate =
    "integration.fixture.codex-verify-trace-get-child-invoke-get";
  const markerFor = (value: unknown) =>
    encodeAdapterReportedFailureMarker(predicate, runId, value);
  const observation = () => ({
    stage: 1,
    cutoffExpired: false,
    workerJoined: null,
    watchdogJoined: null,
    leaseReleased: null,
  });
  const verifyStage = (stage: number) => {
    for (const cutoffExpired of [false, true])
      for (const workerJoined of [null, false, true])
        for (const watchdogJoined of [null, false, true])
          for (const leaseReleased of [null, false, true]) {
            const value = {
              stage,
              cutoffExpired,
              workerJoined,
              watchdogJoined,
              leaseReleased,
            };
            const marker = markerFor(value);
            expect(typeof marker).toBe("string");
            expect(Buffer.byteLength(marker!)).toBe(83);
            expect(decodeAdapterReportedFailureMarker(marker, runId)).toEqual(
              value,
            );
            expect(
              extractAdapterReportedFailure(
                `integration.runner.adapter-reported-failure:${marker}`,
                runId,
              ),
            ).toEqual(value);
          }
  };
  it("canonically encodes every closed ordinal and nullable settlement vector within 128 bytes", () => {
    for (let stage = 1; stage <= 14; stage++) verifyStage(stage);
  });
  it("discards malformed, partial, extra, duplicate, and substituted observations", () => {
    const value = {
      ...observation(),
      stage: 14,
      watchdogJoined: true,
      leaseReleased: false,
    };
    const marker = markerFor(value)!;
    for (const invalid of [
      marker.slice(0, -1),
      `${marker}\n`,
      marker.replace("|e", "|f"),
      marker.replace("|e", "|0"),
      marker.replace("e0", "e2"),
      marker.replace("e0n", "e0x"),
      marker.replace(runId, "ffffffffffffffff"),
      `${marker}extra`,
      "x".repeat(129),
    ])
      expect(
        decodeAdapterReportedFailureMarker(invalid, runId),
      ).toBeUndefined();
    const line = `integration.runner.adapter-reported-failure:${marker}`;
    expect(extractAdapterReportedFailure(line + line, runId)).toBeUndefined();
    for (const invalid of [
      { ...value, stage: 0 },
      { ...value, stage: 15 },
      { ...value, stage: 1.5 },
      { ...value, cutoffExpired: null },
      { ...value, workerJoined: "true" },
      { ...value, extra: "canary" },
      { stage: 1 },
    ])
      expect(projectAdapterReportedFailure(invalid)).toBeUndefined();
    expect(
      encodeAdapterReportedFailureMarker(
        "integration.fixture.other",
        runId,
        value,
      ),
    ).toBeUndefined();
  });
  it("never invokes getters or Proxy traps and returns an insulated frozen null-prototype copy", () => {
    let reads = 0;
    const accessor = {
      ...observation(),
      get leaseReleased() {
        reads++;
        return true;
      },
    };
    expect(projectAdapterReportedFailure(accessor)).toBeUndefined();
    expect(
      projectAdapterReportedFailure(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              reads++;
              throw new Error("canary");
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(reads).toBe(0);
    const value = observation();
    const projected = projectAdapterReportedFailure(value);
    value.stage = 14;
    expect(projected?.stage).toBe(1);
    expect(Object.getPrototypeOf(projected)).toBeNull();
    expect(Object.isFrozen(projected)).toBe(true);
  });
});
