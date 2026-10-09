import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { types } from "node:util";
import { imagePreparationFailureRequiresOuterHostRetirement } from "../image-preparation.mjs";
import {
  createPullOperation,
  prepareImageOperation,
  readImagePreparationDiagnostic,
  recordUnexpectedEngineStatus,
} from "../image-preparation/preparation.mjs";
import {
  completionCopySourceMissingResponseMatches,
  formatControllerFailureDiagnostic,
  knownFailureCode,
  readControllerFailureDiagnostic,
} from "./controller-failure-diagnostic.js";
import {
  IntegrationControllerFailure,
  runIntegrationStages,
  settleAbortableOperation,
} from "./controller.js";
import type { IntegrationStageDependencies } from "./controller.js";
import { SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES } from "./substrate-certification.js";
// @ts-expect-error private transport diagnostic has no public declaration
import * as requestDiagnosticModule from "../image-preparation/boundary.mjs";
import {
  buildPhaseFailure,
  settledBuildFailure,
} from "../image-preparation/build-policy.mjs";
const { fixedError } = requestDiagnosticModule as {
  fixedError: (code: string, timedOut?: boolean) => Error & { code?: string };
};
const { readImageRequestDiagnostic, recordImageRequestDiagnostic } =
  requestDiagnosticModule as {
    readImageRequestDiagnostic: (error: unknown) => unknown;
    recordImageRequestDiagnostic: <ErrorType>(
      error: ErrorType,
      phase: string,
      outcome: string,
      status?: number,
    ) => ErrorType;
  };

const completionContainerId = "c".repeat(64);
const collectorPhases = [
  "held-identity",
  "https-exec",
  "snapshot",
  "terminal-wait",
  "terminal-witness",
] as const;
const collectorTerminal = {
  Id: completionContainerId,
  Name: "/owned",
  Config: { Labels: { "com.agentscope.integration.run": "a".repeat(16) } },
  State: {
    Status: "exited",
    Running: false,
    OOMKilled: false,
    Paused: false,
    Restarting: false,
    Dead: false,
    ExitCode: 0,
    Pid: 0,
    Error: "",
  },
};
type CollectorFunctions = {
  joinCollectorObservations: (
    plan: object,
    signal: AbortSignal,
    deadline: number,
    observe: (phase: string) => void,
  ) => Promise<Buffer[]>;
  joinMockServer: (plan: object, signal: AbortSignal) => Promise<void>;
  publishOperationFailureDiagnostic: (
    slot: string,
    error: unknown,
    plan: object,
    context: object,
  ) => void;
};
const collectorTestSource = () => {
  const source = readFileSync(
    new URL("../run-scenarios.mjs", import.meta.url),
    "utf8",
  );
  const collectorStart = source.indexOf("const decodeCollectorSnapshot =");
  const collectorEnd = source.indexOf(
    "const mockServerNetworkObservation =",
    collectorStart,
  );
  const diagnosticStart = source.indexOf("const operationFailureSlots =");
  const diagnosticEnd = source.indexOf(
    "/* eslint-disable complexity",
    diagnosticStart,
  );
  const joinStart = source.indexOf("const joinMockServer =");
  const joinEnd = source.indexOf("const createScenarioContainer =", joinStart);
  expect(collectorEnd).toBeGreaterThan(collectorStart);
  expect(diagnosticEnd).toBeGreaterThan(diagnosticStart);
  expect(joinEnd).toBeGreaterThan(joinStart);
  return `${source.slice(collectorStart, collectorEnd)} ${source.slice(diagnosticStart, diagnosticEnd)} ${source.slice(joinStart, joinEnd)}; ({joinCollectorObservations,joinMockServer,publishOperationFailureDiagnostic})`;
};
const actualCollectorObservation = (failure: string, sinkFails = false) => {
  const plan = {
    runId: "a".repeat(16),
    collectorName: "owned",
    scenarioId: "codex-tui-trace-smoke",
  };
  const output: string[] = [],
    calls: string[][] = [];
  const original = new Error("PRIVATE PROCESS FAILURE");
  let phase: string | undefined,
    now = 0;
  const functions = runInNewContext(collectorTestSource(), {
    Buffer,
    AbortSignal,
    types,
    knownFailureCode,
    preparedDockerClient: {},
    preparedDockerClientRequiresOuterHostRetirement: () => false,
    linuxBootMonotonicMilliseconds: () => now,
    scenarioContainerIdentities: new Map([["owned", completionContainerId]]),
    mockServerContainerIdentities: new Map([[plan.runId, "b".repeat(64)]]),
    mockServerJoinDeadlines: new Map([[plan.runId, 1000]]),
    mockServerControls: new Map([[plan.runId, {}]]),
    assertControlVolumeCurrent: () => {},
    openMockServerControl: () => ({
      stop: () => ({ status: 200 }),
      snapshot: () => ({ entries: [] }),
    }),
    verifyMockServerControlBoundary: () => {},
    assertJoinedMockServerTerminal: () => {},
    createFinalMockServerLedgerDirectory: () => "/synthetic",
    resolve: (_root: string, name: string) => `/synthetic/${name}`,
    readMockServerFinalLedger: () => Buffer.from("[]"),
    projectMockServerRequests: () => [],
    assertMockServerFinalLedger: () => {},
    fixtureResults: new Map(),
    fixtureTrafficObservations: new Map(),
    modelRoutes: {},
    manifest: { scenarios: [plan] },
    ISOLATION_EXECUTOR_LIMITS: {
      containers: { collector: {} },
      requests: { destinationServerMaximumBytes: 1048576 },
    },
    assertContainer: () =>
      failure === "held-identity" ? "d".repeat(64) : completionContainerId,
    writeSync: (_fd: number, bytes: Buffer) => {
      if (sinkFails) throw Error("PRIVATE SINK");
      output.push(bytes.toString());
    },
    dockerWithSignal: (
      args: string[],
      signal: AbortSignal,
      options: unknown,
    ) => {
      calls.push(args);
      expect(signal.aborted).toBe(false);
      expect(options).toMatchObject({ terminal: true });
      if (
        args[0] === "logs" ||
        args[0] === "cp" ||
        args.includes("b".repeat(64))
      )
        return { stdout: "", stderr: "" };
      if (args[0] === "exec") {
        expect(args.slice(0, 5)).toEqual([
          "exec",
          completionContainerId,
          "/usr/local/bin/node",
          "--input-type=module",
          "-e",
        ]);
        expect(options).toMatchObject({ maxBuffer: 12 * 1024 * 1024 });
        if (failure === "https-exec") throw original;
        if (failure === "expired") now = 1000;
        return {
          stdout:
            failure === "snapshot"
              ? "PRIVATE INVALID"
              : JSON.stringify({
                  observationVersion: 2,
                  scenarioId: plan.scenarioId,
                  batches: ["e30="],
                  aggregateBytes: 2,
                }),
        };
      }
      if (args[1] === "wait") {
        if (failure === "terminal-wait") throw original;
        if (failure === "expired") throw original;
        return { stdout: "0\n" };
      }
      if (failure === "terminal-witness") return { stdout: "[]" };
      return { stdout: JSON.stringify([collectorTerminal]) };
    },
  }) as CollectorFunctions;
  return {
    functions,
    plan,
    original,
    output,
    calls,
    phase: () => phase,
    observe: (value: string) => {
      phase = value;
    },
  };
};
describe("actual collector failure phase observation", () => {
  it("wires the actual Codex outer catch to the same original collector error", async () => {
    const f = actualCollectorObservation("terminal-wait");
    await expect(
      f.functions.joinMockServer(f.plan, new AbortController().signal),
    ).rejects.toBe(f.original);
    expect(f.output).toHaveLength(1);
    expect(f.output[0]).toContain('"collector":{"phase":"terminal-wait"}');
    expect(f.output[0]).not.toContain("PRIVATE");
  });
  it("preserves success/order and swallows a refused optional observer", async () => {
    const f = actualCollectorObservation("success");
    expect(
      await f.functions.joinCollectorObservations(
        f.plan,
        new AbortController().signal,
        1000,
        () => {
          throw Error("PRIVATE OBSERVER");
        },
      ),
    ).toEqual([Buffer.from("{}")]);
    expect(
      f.calls.map((args) => (args[0] === "exec" ? "exec" : args[1])),
    ).toEqual(["exec", "wait", "inspect"]);
    expect(f.output).toEqual([]);
  });
  it("preserves the original remaining deadline when exec work consumes it", async () => {
    const f = actualCollectorObservation("expired");
    await expect(
      f.functions.joinCollectorObservations(
        f.plan,
        new AbortController().signal,
        1000,
        f.observe,
      ),
    ).rejects.toBe(f.original);
    expect(f.phase()).toBe("terminal-wait");
    expect(f.calls).toHaveLength(2);
  });
  it("keeps sink failure optional and excludes unknown phases/other slots", () => {
    const f = actualCollectorObservation("success", true);
    expect(() => {
      f.functions.publishOperationFailureDiagnostic(
        "join-collector-read",
        f.original,
        f.plan,
        { collectorPhase: "snapshot" },
      );
    }).not.toThrow();
    expect(f.output).toEqual([]);
    const ordinary = actualCollectorObservation("success");
    ordinary.functions.publishOperationFailureDiagnostic(
      "join-collector-read",
      ordinary.original,
      ordinary.plan,
      { collectorPhase: "PRIVATE UNKNOWN" },
    );
    ordinary.functions.publishOperationFailureDiagnostic(
      "join-collector-project",
      ordinary.original,
      ordinary.plan,
      { collectorPhase: "snapshot" },
    );
    expect(ordinary.output).toHaveLength(2);
    for (const line of ordinary.output) {
      expect(line).not.toContain('collector":');
      expect(line).not.toContain("PRIVATE");
    }
  });
  it.each(collectorPhases)(
    "keeps the original %s failure and bounds its existing diagnostic",
    async (phase) => {
      const f = actualCollectorObservation(phase);
      let error: unknown;
      try {
        await f.functions.joinCollectorObservations(
          f.plan,
          new AbortController().signal,
          1000,
          f.observe,
        );
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      if (phase === "terminal-wait") expect(error).toBe(f.original);
      else
        expect(error).toMatchObject({
          message: "integration.isolation.collector-terminal",
        });
      expect(f.phase()).toBe(phase);
      f.functions.publishOperationFailureDiagnostic(
        "join-collector-read",
        error,
        f.plan,
        { collectorPhase: f.phase() },
      );
      expect(f.output).toHaveLength(1);
      expect(Buffer.byteLength(f.output[0]!)).toBeLessThanOrEqual(512);
      const row = JSON.parse(
        f.output[0]!.slice(f.output[0]!.indexOf(":") + 1),
      ) as { collector: object };
      expect(row.collector).toEqual({ phase });
      expect(f.output[0]).not.toContain("PRIVATE");
      expect(f.output[0]).not.toContain(completionContainerId);
      if (phase === "held-identity") expect(f.calls).toEqual([]);
    },
  );
});
const ledgerReasons = [
  "none",
  "late-publish",
  "load-generated",
  "drop",
  "consumer",
  "start",
  "shutdown",
  "eviction",
  "truncation",
  "reset",
  "clear",
  "drain",
  "correlation",
  "request-type",
  "correlation-missing",
  "response-missing",
  "response-duplicate",
  "response-null",
  "response-status",
  "row-count",
  "serialization",
  "control-capture",
];
const producerParser = () => {
  const source = readFileSync(
    new URL("../run-scenarios.mjs", import.meta.url),
    "utf8",
  );
  return runInNewContext(
    `${source.slice(source.indexOf("const mockServerProducerRefusalObservation ="), source.indexOf("const readProducerRefusal ="))}; mockServerProducerRefusalObservation`,
    { types, Buffer },
  ) as (output: unknown) => unknown;
};
describe("closed event-log refusal reason observation", () => {
  it.each(ledgerReasons)(
    "retains only fixed %s with all existing booleans",
    (reason) => {
      const parse = producerParser();
      for (const stage of ["eligibility", "publication"])
        for (let mask = 0; mask < 16; mask++) {
          const fields = [
            "terminal",
            "snapshotAvailable",
            "persistenceClosed",
            "persistenceFailed",
          ];
          const booleans = Object.fromEntries(
            fields.map((name, index) => [name, Boolean(mask & (1 << index))]),
          );
          const line = `[agentscope-mockserver-ledger:v1 stage=${stage} ${fields.map((name) => `${name}=${booleans[name]}`).join(" ")} reason=${reason}]\n`;
          expect(Buffer.byteLength(line)).toBeLessThanOrEqual(256);
          expect(parse({ stdout: "", stderr: line })).toEqual({
            stage,
            ...booleans,
            reason,
          });
        }
    },
  );
  it("refuses extensions, duplicate lines, and hostile process output", () => {
    const parse = producerParser();
    const line =
      "[agentscope-mockserver-ledger:v1 stage=eligibility terminal=true snapshotAvailable=false persistenceClosed=true persistenceFailed=false reason=correlation]\n";
    for (const stderr of [
      line.replace("correlation", "PRIVATE"),
      line.replace("reason=", "other="),
      line.replace("]", " other=false]"),
      line + line,
      line.replace("reason=correlation", "reason=none reason=correlation"),
      line.replace("false reason=", "false]\nreason="),
      "PRIVATE".repeat(12000),
    ])
      expect(parse({ stdout: "", stderr })).toBeUndefined();
    let reads = 0;
    const hostile = Object.defineProperty({}, "stdout", {
      get() {
        reads++;
        throw new Error("PRIVATE");
      },
    });
    expect(parse(hostile)).toBeUndefined();
    expect(
      parse(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              reads++;
              throw new Error("PRIVATE");
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(reads).toBe(0);
  });
});
const completionResponse = `Error response from daemon: Could not find the file /control/private/requests.complete in container ${completionContainerId}\n`;
const completionContext = {
  containerId: completionContainerId,
  originalAborted: false,
  joinAborted: false,
  deadline: "live",
};
const completionError = (fields: object = {}) =>
  Object.assign(new Error("SYNTHETIC PRIVATE ERROR"), {
    code: 1,
    signal: null,
    killed: false,
    stdout: "",
    stderr: completionResponse,
    ...fields,
  });

describe("exact completion source-missing response observation", () => {
  it("matches the exact upstream response without changing the Error", () => {
    const error = completionError();
    const before = Object.getOwnPropertyDescriptors(error);
    expect(
      completionCopySourceMissingResponseMatches(error, completionContext),
    ).toBe(true);
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
  });
  it.each([
    completionResponse.trimEnd(),
    `${completionResponse}\n`,
    completionResponse.replace("\n", "\r\n"),
    `PRIVATE ${completionResponse}`,
    `${completionResponse}PRIVATE`,
    completionResponse.replace("requests.complete", "requests.json"),
    completionResponse.replace("requests.complete", "requests.complete.tmp"),
    completionResponse.replace("/control/private/", "/control/private/../"),
    completionResponse.replace(completionContainerId, "d".repeat(64)),
    completionResponse.replace(completionContainerId, "named-container"),
    completionResponse.replace("Could", "could"),
    `\u001b[31m${completionResponse}`,
    "ENOENT: missing local destination",
    "Error response from daemon: No such container",
    "",
    "PRIVATE".repeat(100),
    Buffer.from(completionResponse),
    { toString: () => completionResponse },
  ])("does not interpret a near miss as missing source %#", (stderr) => {
    expect(
      completionCopySourceMissingResponseMatches(
        completionError({ stderr }),
        completionContext,
      ),
    ).toBe(false);
  });
  it.each([
    { code: 0 },
    { code: "1" },
    { code: "ENOENT" },
    { signal: "SIGTERM" },
    { signal: undefined },
    { killed: true },
    { killed: undefined },
    { stdout: "PRIVATE" },
    { stdout: undefined },
  ])("requires all exact settled process fields %#", (fields) => {
    expect(
      completionCopySourceMissingResponseMatches(
        completionError(fields),
        completionContext,
      ),
    ).toBe(false);
  });
  it.each([
    { containerId: "c".repeat(63) },
    { containerId: "C".repeat(64) },
    { containerId: null },
    { originalAborted: true },
    { originalAborted: undefined },
    { joinAborted: true },
    { joinAborted: null },
    { deadline: "expired" },
    { deadline: "unavailable" },
  ])("requires the same live join context %#", (fields) => {
    expect(
      completionCopySourceMissingResponseMatches(completionError(), {
        ...completionContext,
        ...fields,
      }),
    ).toBe(false);
  });
});

describe("hostile completion response metadata", () => {
  it.each(["stderr", "stdout", "code", "signal", "killed"])(
    "never invokes an own %s accessor",
    (field) => {
      const getter = vi.fn(() => {
        throw new Error("PRIVATE GETTER");
      });
      const error = completionError();
      Object.defineProperty(error, field, { get: getter });
      expect(
        completionCopySourceMissingResponseMatches(error, completionContext),
      ).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("rejects plain, inherited and Proxy metadata without traps/coercion", () => {
    const trap = vi.fn(() => {
      throw new Error("PRIVATE TRAP");
    });
    const native = completionError();
    const proxy = new Proxy(native, {
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
    });
    for (const error of [
      { ...native },
      Object.create(native),
      proxy,
      undefined,
      null,
    ])
      expect(
        completionCopySourceMissingResponseMatches(error, completionContext),
      ).toBe(false);
    expect(trap).not.toHaveBeenCalled();
  });
  it("rejects inherited fields on a native Error and never coerces stderr", () => {
    const inherited = completionError();
    Reflect.deleteProperty(inherited, "stderr");
    Object.setPrototypeOf(inherited, completionError());
    const coerce = vi.fn(() => completionResponse);
    for (const error of [
      inherited,
      completionError({ stderr: { toString: coerce } }),
    ])
      expect(
        completionCopySourceMissingResponseMatches(error, completionContext),
      ).toBe(false);
    expect(coerce).not.toHaveBeenCalled();
  });
});

const actualCompletionObservation = (sinkFails = false, producerLine = "") => {
  const source = readFileSync(
    new URL("../run-scenarios.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const operationFailureSlots =");
  const end = source.indexOf("/* eslint-disable complexity", start);
  const joinStart = source.indexOf("const joinMockServer =");
  const joinEnd = source.indexOf("const createScenarioContainer =", joinStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(joinEnd).toBeGreaterThan(joinStart);
  const runId = "e".repeat(16);
  const error = completionError();
  const output: string[] = [];
  const copies: string[][] = [];
  const identities = new Map([[runId, completionContainerId]]);
  const state = {
    now: 100,
    retired: false,
    beforeFailure: undefined as (() => void) | undefined,
  };
  const functions = runInNewContext(
    `${source.slice(start, end)}\n${source.slice(joinStart, joinEnd)};
    ({ joinMockServer, publishOperationFailureDiagnostic })`,
    {
      Buffer,
      types,
      AbortSignal,
      completionCopySourceMissingResponseMatches,
      knownFailureCode,
      preparedDockerClient: {},
      preparedDockerClientRequiresOuterHostRetirement: () => state.retired,
      linuxBootMonotonicMilliseconds: () => state.now,
      writeSync: (_fd: number, bytes: Buffer) => {
        if (sinkFails) throw new Error("PRIVATE SINK");
        output.push(bytes.toString("utf8"));
      },
      mockServerContainerIdentities: identities,
      mockServerJoinDeadlines: new Map([[runId, 1000]]),
      assertControlVolumeCurrent: () => {},
      mockServerControls: new Map([[runId, {}]]),
      openMockServerControl: () => ({ stop: () => ({ status: 200 }) }),
      verifyMockServerControlBoundary: () => {},
      assertJoinedMockServerTerminal: () => {},
      createFinalMockServerLedgerDirectory: () => "/synthetic-ledger",
      resolve: (_directory: string, name: string) =>
        `/synthetic-ledger/${name}`,
      dockerWithSignal: (args: string[]) => {
        if (args[0] === "logs") return { stdout: "", stderr: producerLine };
        if (args[0] !== "cp") return { stdout: "" };
        copies.push(args);
        if (args[1]!.endsWith("requests.json")) {
          // The observer must use the same held identity, never reread this map.
          identities.set(runId, "f".repeat(64));
          return { stdout: "" };
        }
        state.retired = true;
        state.beforeFailure?.();
        throw error;
      },
    },
  ) as {
    joinMockServer: (plan: object, signal: AbortSignal) => Promise<void>;
    publishOperationFailureDiagnostic: (
      slot: string,
      error: unknown,
      plan: object,
      context: object,
    ) => void;
  };
  return { functions, runId, output, copies, error, state };
};
const assertUnknownProducerRefusal = (output: string[], runId: string) => {
  expect(output).toHaveLength(2);
  expect(output[1]).toBe(
    `integration.isolation.mockserver-ledger-diagnostic:${JSON.stringify({
      runId,
      stage: "unknown",
      terminal: null,
      snapshotAvailable: null,
      persistenceClosed: null,
      persistenceFailed: null,
      reason: null,
    })}\n`,
  );
  expect(Buffer.byteLength(output[1]!)).toBeLessThanOrEqual(256);
};

describe("actual-source completion copy fixed refusal reason", () => {
  it.each(ledgerReasons)(
    "projects %s without replacing the original copy failure",
    async (reason) => {
      const line = `[agentscope-mockserver-ledger:v1 stage=eligibility terminal=true snapshotAvailable=false persistenceClosed=true persistenceFailed=false reason=${reason}]\n`;
      for (const sinkFails of [false, true]) {
        const f = actualCompletionObservation(sinkFails, line);
        await expect(
          f.functions.joinMockServer(
            { runId: f.runId },
            new AbortController().signal,
          ),
        ).rejects.toBe(f.error);
        expect(f.state.retired).toBe(true);
        expect(f.copies).toHaveLength(2);
        if (sinkFails) expect(f.output).toEqual([]);
        else {
          expect(f.output).toHaveLength(2);
          expect(
            JSON.parse(f.output[1]!.slice(f.output[1]!.indexOf(":") + 1)),
          ).toEqual({
            runId: f.runId,
            stage: "eligibility",
            terminal: true,
            snapshotAvailable: false,
            persistenceClosed: true,
            persistenceFailed: false,
            reason,
          });
          expect(Buffer.byteLength(f.output[1]!)).toBeLessThanOrEqual(256);
          expect(f.output.join("")).not.toMatch(
            /PRIVATE|\/control\/private|cccccccc/u,
          );
        }
      }
    },
  );
});
describe("actual-source completion copy observation", () => {
  it.each([false, true])(
    "preserves the identical copy error and retirement when sinkFails=%s",
    async (sinkFails) => {
      const f = actualCompletionObservation(sinkFails);
      await expect(
        f.functions.joinMockServer(
          { runId: f.runId },
          new AbortController().signal,
        ),
      ).rejects.toBe(f.error);
      expect(f.state.retired).toBe(true);
      expect(f.copies).toEqual([
        [
          "cp",
          `${completionContainerId}:/control/private/requests.json`,
          "/synthetic-ledger/requests.json",
        ],
        [
          "cp",
          `${completionContainerId}:/control/private/requests.complete`,
          "/synthetic-ledger/requests.complete",
        ],
      ]);
      if (sinkFails) expect(f.output).toEqual([]);
      else {
        assertUnknownProducerRefusal(f.output, f.runId);
        expect(Buffer.byteLength(f.output[0]!)).toBeLessThanOrEqual(512);
        const row: unknown = JSON.parse(
          f.output[0]!.slice(f.output[0]!.indexOf(":") + 1),
        );
        expect(row).toMatchObject({
          slot: "join-ledger-complete",
          runId: f.runId,
          clientRetirementRequired: true,
          process: { completionSourceMissingResponse: true },
        });
        for (const privateText of [
          "PRIVATE",
          completionContainerId,
          "/control/private/",
          completionResponse,
        ])
          expect(f.output.join("")).not.toContain(privateText);
      }
    },
  );
  it.each(["abort", "expired"])(
    "does not match when actual join context becomes %s",
    async (failure) => {
      const f = actualCompletionObservation();
      const controller = new AbortController();
      f.state.beforeFailure = () => {
        if (failure === "abort") controller.abort();
        else f.state.now = 1000;
      };
      await expect(
        f.functions.joinMockServer({ runId: f.runId }, controller.signal),
      ).rejects.toBe(f.error);
      assertUnknownProducerRefusal(f.output, f.runId);
      const row: unknown = JSON.parse(
        f.output[0]!.slice(f.output[0]!.indexOf(":") + 1),
      );
      expect(row).toMatchObject({
        process: { completionSourceMissingResponse: false },
      });
      expect(f.state.retired).toBe(true);
    },
  );
  it("leaves candidate and other slots without the match-only field", () => {
    const f = actualCompletionObservation();
    for (const slot of [
      "candidate-image-build",
      "runtime-original",
      "cleanup-images",
    ])
      f.functions.publishOperationFailureDiagnostic(
        slot,
        f.error,
        { runId: f.runId },
        {
          signal: new AbortController().signal,
          joinSignal: new AbortController().signal,
          deadline: 1000,
          containerId: completionContainerId,
        },
      );
    expect(f.output).toHaveLength(3);
    for (const row of f.output) {
      expect(row).not.toContain("completionSourceMissingResponse");
      expect(row).not.toContain("mockserver-ledger-diagnostic");
    }
  });
});

const storage = {
  cleanupFails: false,
  cleanups: 0,
  created: 0,
  cleanupDeadlines: [] as number[],
};
const storageDependencies = {
  createPrivateClientRoot: () => {
    storage.created += 1;
    return { root: "/synthetic-private-root" };
  },
  cleanupPrivateClient: (_owned: unknown, deadline: number) => {
    storage.cleanups += 1;
    storage.cleanupDeadlines.push(deadline);
    if (storage.cleanupFails) throw new Error("SYNTHETIC-PRIVATE-CONTENT");
  },
};
beforeEach(() => {
  storage.cleanupFails = false;
  storage.cleanups = 0;
  storage.created = 0;
  storage.cleanupDeadlines = [];
});

const image = `registry.invalid/example@sha256:${"a".repeat(64)}`;
const policy = { workDeadline: 100, reconciliationDeadline: 200 };
const pullInput = {
  daemon: { apiVersion: "1.45" },
  image,
  platform: { os: "linux", architecture: "amd64" },
  policy,
  transport: undefined,
};
const syntheticPull = async (trigger: string, reconciliationFails = false) => {
  const inspectLocalImage = vi.fn(() => {
    if (reconciliationFails)
      return Promise.reject(new Error("SYNTHETIC-RECONCILIATION-CONTENT"));
    return Promise.resolve();
  });
  const engineCall = vi.fn(() => {
    if (trigger === "transport")
      return Promise.reject(new Error("integration.images.transport"));
    if (trigger === "timeout")
      return Promise.reject(
        Object.assign(new Error("integration.images.timeout"), {
          code: "ETIMEDOUT",
        }),
      );
    if (trigger === "abort")
      return Promise.reject(new Error("integration.images.interrupted"));
    if (trigger === "unexpected-status")
      return Promise.reject(
        recordUnexpectedEngineStatus(new Error("integration.images.daemon")),
      );
    if (trigger === "unknown")
      return Promise.reject(new Error("SYNTHETIC-VENDOR-CONTENT"));
    const body =
      trigger === "empty-events"
        ? "\n"
        : trigger === "malformed-event"
          ? "{SYNTHETIC-CONTENT"
          : trigger === "daemon-error-event"
            ? '{"error":"SYNTHETIC-VENDOR-CONTENT"}'
            : '{"status":"complete"}';
    return Promise.resolve({ body: Buffer.from(body) });
  });
  const pull = createPullOperation({
    engineCall,
    inspectLocalImage,
    platformText: () => "linux/amd64",
  });
  let failure: unknown;
  try {
    await pull(pullInput);
  } catch (error) {
    failure = error;
  }
  return { failure, engineCall, inspectLocalImage };
};

const controllerCodes = (primaryCause: unknown, cleanupCause?: unknown) => {
  const failure = new IntegrationControllerFailure({
    primaryCause,
    cleanupCause,
    retirementRequired: false,
    stage: "runScenarios",
  });
  return readControllerFailureDiagnostic(failure).firstCodes;
};
describe("actual fixed image failure producer vocabulary", () => {
  it.each([
    "integration.images.build",
    "integration.images.socket",
    "integration.images.executable",
    "integration.images.interrupted",
    "integration.images.output",
    "integration.images.teardown",
  ])(
    "preserves actual fixedError %s with no numeric process metadata",
    (code) => {
      const error = fixedError(code);
      expect(Object.getOwnPropertyDescriptor(error, "code")).toBeUndefined();
      expect(knownFailureCode(error)).toBe(code);
      expect(controllerCodes(error)).toEqual({
        primary: code,
        causal: "unknown",
        cleanup: "unknown",
      });
    },
  );
  it.each(["context", "authority"])(
    "preserves the actual %s wrapper without expanding causes",
    (phase) => {
      const error = buildPhaseFailure(new Error("PRIVATE"), phase, []);
      expect(knownFailureCode(error)).toBe(`integration.images.build.${phase}`);
      expect(knownFailureCode(new Error("PRIVATE", { cause: error }))).toBe(
        "unknown",
      );
    },
  );
  it("preserves the existing timed-out teardown code without converting it into an exit", () => {
    const error = fixedError("integration.images.teardown", true);
    expect(error.code).toBe("ETIMEDOUT");
    expect(knownFailureCode(error)).toBe("integration.images.teardown");
  });
});

describe("actual settled build failure finite vocabulary", () => {
  const cases = [
    "preflight",
    "builder-create",
    "builder-bootstrap",
    "image-build",
    "unknown-operation",
  ].flatMap((operation) =>
    [
      "resource-conflict",
      "build-failed",
      "bootstrap-failed",
      "permission-denied",
      "unknown",
    ].map((outcome) => [operation, outcome] as const),
  );
  it.each(cases)(
    "retains actual producer %s/%s and rejects extensions",
    (operation, outcome) => {
      const error = settledBuildFailure(
        {
          firstFailureDiagnostic: {
            operationKind: operation,
            process: { stderrClass: outcome },
          },
        },
        new Error("PRIVATE"),
      );
      const code = `integration.images.build.${operation}.${outcome}`;
      expect(knownFailureCode(error)).toBe(code);
      expect(knownFailureCode(new Error(`${code}.PRIVATE`))).toBe("unknown");
      expect(knownFailureCode(new Error(`${code}\n`))).toBe("unknown");
      expect(knownFailureCode({ message: code })).toBe("unknown");
    },
  );
  it.each([
    "integration.images.build.other.build-failed",
    "integration.images.build.image-build.other",
    "integration.images.socket.PRIVATE",
    "integration.images.platform-identity",
  ])("keeps unapproved %s unknown", (code) => {
    expect(knownFailureCode(new Error(code))).toBe("unknown");
  });
  it("does not invoke new-message accessors or Proxy traps", () => {
    let reads = 0;
    const getter = () => {
      reads++;
      throw new Error("PRIVATE");
    };
    const accessor = new Error("integration.images.build.authority");
    Object.defineProperty(accessor, "message", { get: getter });
    const proxy = new Proxy(
      new Error("integration.images.build.image-build.build-failed"),
      {
        get: getter,
        getOwnPropertyDescriptor: getter,
      },
    );
    for (const error of [accessor, proxy])
      expect(knownFailureCode(error)).toBe("unknown");
    expect(reads).toBe(0);
  });
});
describe("direct source-derived operation failure codes", () => {
  it.each([
    "integration.mockserver.control",
    "integration.isolation.base-image",
    "integration.images.build.input",
    "integration.images.build.base",
    "integration.images.build.artifact",
    "integration.images.build.context-header",
    "integration.images.build.context-path",
    "integration.images.build.context-file-type",
    "integration.images.build.context-file-identity",
    "integration.images.build.context-aggregate-size",
    "integration.images.build.context-file-length",
    "integration.images.build.context-file-race",
    "integration.images.build.context-directory",
    "integration.images.build.context-symlink",
    "integration.images.build.context-special",
    "integration.images.build.context-policy",
    "integration.images.build.context-root",
    "integration.images.build.context-size",
    "integration.images.build.context-entries",
    "integration.images.build.context-unknown",
    "integration.images.build.context-file-size-harness-material-default",
    "integration.images.build.context-file-size-harness-material-harness",
    "integration.images.build.context-file-size-candidate-default",
    "integration.images.build.context-file-size-candidate-harness",
    "integration.images.build.context-file-size-testkit-default",
    "integration.images.build.context-file-size-testkit-harness",
    "integration.images.build.context-file-size-runtime-default",
    "integration.images.build.context-file-size-runtime-harness",
    "integration.images.build.context-file-size-controller-default",
    "integration.images.build.context-file-size-controller-harness",
    "integration.operations.fixture-result",
    "integration.certification.predicate",
  ])("retains only direct native data code %s", (code) => {
    expect(knownFailureCode(new Error(code))).toBe(code);
    expect(knownFailureCode(new Error(`${code}.PRIVATE`))).toBe("unknown");
    expect(
      knownFailureCode(new Error("PRIVATE", { cause: new Error(code) })),
    ).toBe("unknown");
    let reads = 0;
    const accessor = new Error(code);
    Object.defineProperty(accessor, "message", {
      get: () => {
        reads++;
        return code;
      },
    });
    const proxy = new Proxy(new Error(code), {
      get: () => {
        reads++;
        return code;
      },
    });
    for (const value of [accessor, proxy, { message: code }])
      expect(knownFailureCode(value)).toBe("unknown");
    expect(reads).toBe(0);
  });
});
describe("closed certification failure codes", () => {
  it.each(Object.values(SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES))(
    "projects only the existing exact certification code %s",
    (primary) => {
      expect(controllerCodes(new Error(primary))).toEqual({
        primary,
        causal: "unknown",
        cleanup: "unknown",
      });
      expect(
        controllerCodes(
          new Error("integration.controller.unsettled-operation", {
            cause: new Error(primary),
          }),
          new Error(primary),
        ),
      ).toEqual({
        primary: "integration.controller.unsettled-operation",
        causal: primary,
        cleanup: primary,
      });
      for (const value of [
        `${primary}.PRIVATE`,
        `${primary}\nPRIVATE`,
        "integration.certification.unlisted",
      ])
        expect(controllerCodes(new Error(value))).toBeUndefined();
      expect(controllerCodes({ message: primary })).toBeUndefined();
      expect(
        controllerCodes(
          new Error("UNKNOWN", {
            cause: new Error(primary),
          }),
        ),
      ).toBeUndefined();
    },
  );

  it("does not read substituted certification messages through accessors or proxies", () => {
    const primary = SUBSTRATE_CERTIFICATION_PRIMARY_FAILURES["leaked-child"];
    let reads = 0;
    const accessor = new Error(primary);
    Object.defineProperty(accessor, "message", {
      get: () => {
        reads += 1;
        return primary;
      },
    });
    const proxy = new Proxy(new Error(primary), {
      get: () => {
        reads += 1;
        return primary;
      },
    });
    expect(controllerCodes(accessor)).toBeUndefined();
    expect(controllerCodes(proxy)).toBeUndefined();
    expect(reads).toBe(0);
  });
});

describe("closed first controller failure codes", () => {
  it.each([
    "integration.harness-scenario-admission.invalid",
    "integration.harness-admission.invalid",
  ])("retains only the fixed direct admission code %s", (primary) => {
    expect(
      controllerCodes(
        new Error(primary, {
          cause: new Error("integration.images.transport"),
        }),
      ),
    ).toEqual({
      primary,
      causal: "unknown",
      cleanup: "unknown",
    });
    expect(controllerCodes(new Error(`${primary}.PRIVATE`))).toBeUndefined();
  });
  it.each([
    "preflight",
    "validate-package",
    "validate-descriptors",
    "download-key",
    "download-manifest",
    "download-signature",
    "download-platform-package",
    "integrity",
    "download-binary",
    "download-tarball",
    "download-attestation",
    "compile-audit",
    "verify",
    "verify-context",
    "verify-build",
    "verify-build-input",
    "verify-build-context",
    "verify-build-authority",
    "verify-build-preflight",
    "verify-build-create",
    "verify-build-bootstrap",
    "verify-build-image-build",
    "verify-build-containment",
    "verify-build-timeout",
    "verify-retire",
    "compile-authority",
    "publish",
  ])(
    "retains one actual material envelope phase %s without inspecting deeper causes",
    (phase) => {
      const cause = new Error(`integration.harness-material.${phase}`, {
        cause: new Error("PRIVATE_DEEP_CAUSE"),
      });
      const primary = new Error("integration.harness-material.failed", {
        cause,
      });
      expect(
        controllerCodes(
          primary,
          new Error("integration.isolation.cleanup-inventory"),
        ),
      ).toEqual({
        primary: "integration.harness-material.failed",
        causal: `integration.harness-material.${phase}`,
        cleanup: "integration.isolation.cleanup-inventory",
      });
    },
  );
  it("retains one known controller envelope and first cleanup code", () => {
    const primary = new Error("integration.controller.unsettled-operation", {
      cause: new Error("integration.isolation.mockserver-terminal"),
    });
    expect(
      controllerCodes(
        primary,
        new Error("integration.isolation.cleanup-network-remove"),
      ),
    ).toEqual({
      primary: "integration.controller.unsettled-operation",
      causal: "integration.isolation.mockserver-terminal",
      cleanup: "integration.isolation.cleanup-network-remove",
    });
  });
  it("does not unwrap an arbitrary envelope or walk past a known envelope", () => {
    const known = new Error("integration.images.transport");
    expect(
      controllerCodes(new Error("PRIVATE", { cause: known })),
    ).toBeUndefined();
    expect(
      controllerCodes(
        new Error("integration.harness-material.failed", {
          cause: new Error("PRIVATE", { cause: known }),
        }),
      ),
    ).toEqual({
      primary: "integration.harness-material.failed",
      causal: "unknown",
      cleanup: "unknown",
    });
    expect(
      controllerCodes(
        new Error("integration.isolation.context", { cause: known }),
      ),
    ).toEqual({
      primary: "integration.isolation.context",
      causal: "unknown",
      cleanup: "unknown",
    });
  });
});
describe("closed controller code hostile inputs", () => {
  it("rejects nonallowlisted suffixes, plain values, accessors and proxies without traps", () => {
    let traps = 0;
    const getter = () => {
      traps++;
      throw new Error("PRIVATE");
    };
    const messageAccessor = Object.defineProperty(new Error(), "message", {
      get: getter,
    });
    const proxy = new Proxy(new Error("integration.images.transport"), {
      get: getter,
      getOwnPropertyDescriptor: getter,
    });
    for (const value of [
      messageAccessor,
      proxy,
      { message: "integration.images.transport" },
      new Error(
        "integration.harness-material.download-attestation-root-upstream",
      ),
      new Error(
        "integration.harness-material.verify-build-image-build.PRIVATE",
      ),
      new Error("integration.harness-material.verify-build-unknown"),
      new Error("integration.isolation.context" + "PRIVATE".repeat(100)),
    ])
      expect(controllerCodes(value)).toBeUndefined();
    const primary = Object.defineProperty(
      new Error("integration.harness-material.failed"),
      "cause",
      { get: getter },
    );
    expect(controllerCodes(primary)).toEqual({
      primary: "integration.harness-material.failed",
      causal: "unknown",
      cleanup: "unknown",
    });
    expect(traps).toBe(0);
  });
});

describe("content-free image preparation request hints", () => {
  it("keeps an observed pull request failure uncertain even after successful reconciliation", async () => {
    const primary = recordImageRequestDiagnostic(
      new Error("integration.images.transport"),
      "image-pull",
      "request-error",
    );
    const inspectLocalImage = vi.fn(() => Promise.resolve());
    const pull = createPullOperation({
      engineCall: () => Promise.reject(primary),
      inspectLocalImage,
      platformText: () => "linux/amd64",
    });
    const failure = await pull(pullInput).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "integration.images.daemon-uncertain",
    });
    expect(inspectLocalImage).toHaveBeenCalledOnce();
    expect(readImagePreparationDiagnostic(failure)).toEqual({
      primary: "pull-outcome-unknown",
      cleanup: "none",
      trigger: "transport",
      reconciliation: "completed",
      request: { phase: "image-pull", outcome: "request-error" },
    });
    expect(imagePreparationFailureRequiresOuterHostRetirement(failure)).toBe(
      true,
    );
  });
  it.each([false, true])(
    "retains the first observed request hint through preparation cleanup failure=%s and the controller envelope",
    async (cleanupFails) => {
      storage.cleanupFails = cleanupFails;
      const primary = new Error("integration.images.transport");
      recordImageRequestDiagnostic(
        primary,
        "registry-auth",
        "unexpected-status",
        503,
      );
      recordImageRequestDiagnostic(
        primary,
        "daemon-info",
        "request-error",
        401,
      );
      let failure: unknown;
      try {
        await prepareImageOperation(
          { admitPreparedSet: () => undefined },
          {
            ...storageDependencies,
            engineTransport: () => undefined,
            prepareImageSet: () => Promise.reject(primary),
          },
          [image],
          {
            socketIdentityForTesting: {
              path: "/synthetic.sock",
              device: "1",
              inode: "2",
              mode: "3",
              owner: "4",
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      if (cleanupFails)
        expect(failure).toMatchObject({
          message: "integration.images.cleanup",
        });
      else expect(failure).toBe(primary);
      expect(storage.cleanups).toBe(1);
      const expected = {
        phase: "registry-auth",
        outcome: "unexpected-status",
        status: 503,
      };
      expect(readImagePreparationDiagnostic(failure)?.request).toEqual(
        expected,
      );
      const wrapped = new IntegrationControllerFailure({
        primaryCause: new Error("integration.images.transport", {
          cause: failure,
        }),
        retirementRequired: true,
        stage: "prepareImages",
      });
      expect(
        readControllerFailureDiagnostic(wrapped).imagePreparation?.request,
      ).toEqual(expected);
    },
  );
  it("keeps invalid phases/outcomes and absent status unknown without property inspection", () => {
    const failure = Object.defineProperty(new Error("PRIVATE"), "code", {
      get: () => {
        throw new Error("must-not-read");
      },
    });
    expect(
      recordImageRequestDiagnostic(
        failure,
        "https://PRIVATE",
        "request-error",
        503,
      ),
    ).toBe(failure);
    recordImageRequestDiagnostic(failure, "daemon-info", "PRIVATE", 503);
    expect(readImageRequestDiagnostic(failure)).toBeUndefined();
    recordImageRequestDiagnostic(failure, "daemon-info", "request-error", 0);
    expect(readImageRequestDiagnostic(failure)).toEqual({
      phase: "daemon-info",
      outcome: "request-error",
    });
    expect(readImagePreparationDiagnostic(failure)).toBeUndefined();
    expect(formatControllerFailureDiagnostic(failure)).not.toContain("PRIVATE");
  });
});
describe("content-free image preparation diagnostics", () => {
  it.each([
    "transport",
    "timeout",
    "abort",
    "unexpected-status",
    "empty-events",
    "malformed-event",
    "daemon-error-event",
    "unknown",
  ])(
    "retains %s without converting reconciliation into success",
    async (trigger) => {
      for (const reconciliationFails of [false, true]) {
        const { failure, inspectLocalImage } = await syntheticPull(
          trigger,
          reconciliationFails,
        );
        expect(failure).toMatchObject({
          message:
            trigger === "abort"
              ? "integration.images.interrupted-uncertain"
              : "integration.images.daemon-uncertain",
        });
        expect(readImagePreparationDiagnostic(failure)).toEqual({
          primary: "pull-outcome-unknown",
          cleanup: "none",
          trigger,
          reconciliation: reconciliationFails ? "failed" : "completed",
        });
        expect(inspectLocalImage).toHaveBeenCalledExactlyOnceWith({
          daemon: pullInput.daemon,
          image,
          missingAllowed: true,
          policy: { ...policy, workDeadline: 200 },
          signal: undefined,
          transport: undefined,
        });
        expect(
          JSON.stringify(readImagePreparationDiagnostic(failure)),
        ).not.toContain("SYNTHETIC");
      }
    },
  );

  it("never claims success when a pull response is lost after daemon mutation", async () => {
    let mutationObserved = false;
    const pull = createPullOperation({
      engineCall: () => {
        mutationObserved = true;
        return Promise.reject(new Error("integration.images.transport"));
      },
      inspectLocalImage: () => Promise.resolve({ present: true }),
      platformText: () => "linux/amd64",
    });
    let failure: unknown;
    try {
      await pull(pullInput);
    } catch (error) {
      failure = error;
    }
    expect(mutationObserved).toBe(true);
    expect(failure).toMatchObject({
      message: "integration.images.daemon-uncertain",
    });
    expect(readImagePreparationDiagnostic(failure)?.reconciliation).toBe(
      "completed",
    );
  });

  it("successful pull events have no failure projection or reconciliation", async () => {
    const result = await syntheticPull("success");
    expect(result.failure).toBeUndefined();
    expect(result.inspectLocalImage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retains preparation primary beside cleanup failure: %s",
    async (withPrimary) => {
      const { failure: primary } = await syntheticPull("transport");
      if (!(primary instanceof Error))
        throw new Error("expected synthetic pull failure");
      storage.cleanupFails = true;
      const state = { admitPreparedSet: vi.fn() };
      const dependencies = {
        ...storageDependencies,
        engineTransport: () => undefined,
        prepareImageSet: () =>
          withPrimary ? Promise.reject(primary) : Promise.resolve({}),
      };
      let failure: unknown;
      try {
        await prepareImageOperation(state, dependencies, [image], {
          socketIdentityForTesting: {
            path: "/synthetic.sock",
            device: "1",
            inode: "2",
            mode: "600",
            owner: "0",
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ message: "integration.images.cleanup" });
      expect(readImagePreparationDiagnostic(failure)).toEqual({
        primary: withPrimary ? "pull-outcome-unknown" : "none",
        trigger: withPrimary ? "transport" : "unknown",
        reconciliation: withPrimary ? "completed" : "not-attempted",
        cleanup: "private-cleanup-failed",
      });
      expect(storage).toMatchObject({ created: 1, cleanups: 1 });
      expect(storage.cleanupDeadlines).toHaveLength(1);
      expect(Number.isFinite(storage.cleanupDeadlines[0])).toBe(true);
      expect(state.admitPreparedSet).not.toHaveBeenCalled();
    },
  );
});

const stages = (): IntegrationStageDependencies => ({
  clean: vi.fn(async () => {}),
  maintainArtifacts: vi.fn(async () => {}),
  prepareCandidate: vi.fn(async () => {}),
  prepareImages: vi.fn(async () => {}),
  prepareModelRoutes: vi.fn(async () => {}),
  runScenarios: vi.fn(async () => {}),
  select: vi.fn(async () => {}),
});

const actualPreparationEntryWrapper = (error: unknown): unknown => {
  const source = readFileSync(
    new URL("../prepare-images.mjs", import.meta.url),
    "utf8",
  );
  expect(Buffer.byteLength(source)).toBeLessThan(8_192);
  const marker = "} catch (error) {";
  const start = source.indexOf(marker);
  const end = source.indexOf("} finally {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start + marker.length, end);
  try {
    runInNewContext(
      `(() => {${body}})()`,
      {
        error,
        Error,
        imagePreparationFailureRequiresOuterHostRetirement,
        process: {
          stderr: {
            write: (value: string) => {
              expect(value).toBe("integration.images.cleanup\n");
            },
          },
        },
      },
      { timeout: 100 },
    );
  } catch (wrapped) {
    expect(wrapped).toMatchObject({
      message: "integration.images.cleanup",
      cause: error,
    });
    return wrapped;
  }
  throw new Error("expected actual entry failure");
};

describe("actual preparation entry propagation", () => {
  it.each([false, true])(
    "retains primary/private cleanup through the real wrapper: %s",
    async (withPrimary) => {
      const { failure: primary } = await syntheticPull("transport");
      if (!(primary instanceof Error))
        throw new Error("expected synthetic pull failure");
      storage.cleanupFails = true;
      let inner: unknown;
      try {
        await prepareImageOperation(
          { admitPreparedSet: vi.fn() },
          {
            ...storageDependencies,
            engineTransport: () => undefined,
            prepareImageSet: () =>
              withPrimary ? Promise.reject(primary) : Promise.resolve({}),
          },
          [image],
          {
            socketIdentityForTesting: {
              path: "/synthetic.sock",
              device: "1",
              inode: "2",
              mode: "600",
              owner: "0",
            },
          },
        );
      } catch (error) {
        inner = error;
      }
      const wrapped = actualPreparationEntryWrapper(inner);
      const dependencies = stages();
      vi.mocked(dependencies.prepareImages).mockRejectedValue(wrapped);
      let failure: unknown;
      try {
        await runIntegrationStages("lifecycle", dependencies);
      } catch (error) {
        failure = error;
      }
      expect(readControllerFailureDiagnostic(failure)).toMatchObject({
        stage: "prepareImages",
        kind: withPrimary ? "pull-outcome-unknown" : "preparation-failed",
        imagePreparation: {
          primary: withPrimary ? "pull-outcome-unknown" : "none",
          cleanup: "private-cleanup-failed",
          trigger: withPrimary ? "transport" : "unknown",
        },
        failure: "integration.controller.retire-outer-host",
      });
      expect(dependencies.runScenarios).not.toHaveBeenCalled();
      expect(formatControllerFailureDiagnostic(failure)).not.toContain(
        "SYNTHETIC",
      );
    },
  );
});

describe("controller failure projection and unchanged retirement", () => {
  it("normalizes a forged runtime stage instead of printing arbitrary content", () => {
    const failure = new IntegrationControllerFailure({
      primaryCause: new Error("SYNTHETIC"),
      retirementRequired: true,
      stage: "SYNTHETIC" as unknown as "select",
    });
    expect(readControllerFailureDiagnostic(failure).stage).toBe("unknown");
    expect(formatControllerFailureDiagnostic(failure)).not.toContain(
      "SYNTHETIC",
    );
  });
  it("distinguishes actual grace-unsettled from wrapped pull uncertainty", async () => {
    const { failure: imageFailure } = await syntheticPull("empty-events");
    const dependencies = stages();
    vi.mocked(dependencies.prepareImages).mockRejectedValue(
      new Error("integration.controller.unsettled-operation", {
        cause: imageFailure,
      }),
    );
    let failure: unknown;
    try {
      await runIntegrationStages("lifecycle", dependencies);
    } catch (error) {
      failure = error;
    }
    expect(readControllerFailureDiagnostic(failure)).toMatchObject({
      stage: "prepareImages",
      kind: "pull-outcome-unknown",
      cleanup: "not-attempted",
      failure: "integration.controller.retire-outer-host",
      imagePreparation: {
        trigger: "empty-events",
        reconciliation: "completed",
      },
    });
    expect(dependencies.clean).not.toHaveBeenCalled();
    expect(dependencies.prepareModelRoutes).not.toHaveBeenCalled();
    expect(dependencies.runScenarios).not.toHaveBeenCalled();

    const generic = stages();
    vi.mocked(generic.prepareImages).mockImplementation(() =>
      settleAbortableOperation(2, () => new Promise(() => {}), 2),
    );
    try {
      await runIntegrationStages("lifecycle", generic);
    } catch (error) {
      failure = error;
    }
    expect(readControllerFailureDiagnostic(failure)).toMatchObject({
      stage: "prepareImages",
      kind: "operation-grace-unsettled",
      imagePreparation: null,
    });
    expect(generic.clean).not.toHaveBeenCalled();
    expect(generic.prepareModelRoutes).not.toHaveBeenCalled();
  });

  it.each([
    "prepareCandidate",
    "select",
    "prepareImages",
    "prepareModelRoutes",
    "runScenarios",
    "maintainArtifacts",
    "clean",
  ] as const)(
    "binds the reached failure stage %s without exposing its message",
    async (stage) => {
      const dependencies = stages();
      vi.mocked(dependencies[stage]).mockRejectedValue(
        new Error("SYNTHETIC-VENDOR-CONTENT"),
      );
      let failure: unknown;
      try {
        await runIntegrationStages(
          stage === "prepareCandidate" ? "candidate" : "lifecycle",
          dependencies,
        );
      } catch (error) {
        failure = error;
      }
      expect(readControllerFailureDiagnostic(failure).stage).toBe(stage);
      expect(formatControllerFailureDiagnostic(failure)).not.toContain(
        "SYNTHETIC",
      );
    },
  );
});

describe("hostile diagnostic objects", () => {
  it("requires the exact private cause identity and never follows a second wrapper", async () => {
    const { failure: leaf } = await syntheticPull("transport");
    if (!(leaf instanceof Error))
      throw new Error("expected synthetic pull failure");
    const once = new Error("integration.images.daemon-uncertain", {
      cause: leaf,
    });
    const accepted = new IntegrationControllerFailure({
      primaryCause: once,
      retirementRequired: true,
    });
    expect(readControllerFailureDiagnostic(accepted).kind).toBe(
      "pull-outcome-unknown",
    );
    for (const cause of [
      once,
      { ...leaf },
      JSON.parse(JSON.stringify(leaf)) as unknown,
    ]) {
      const rejected = new IntegrationControllerFailure({
        primaryCause: new Error("integration.images.daemon-uncertain", {
          cause,
        }),
        retirementRequired: true,
      });
      expect(
        readControllerFailureDiagnostic(rejected).imagePreparation,
      ).toBeNull();
      expect(readControllerFailureDiagnostic(rejected).kind).toBe("unknown");
    }
  });

  it("rejects forged, proxy, accessor and recursive causes without executing getters", () => {
    let accesses = 0;
    const accessor = new Error("integration.controller.unsettled-operation");
    Object.defineProperty(accessor, "cause", {
      get: () => {
        accesses += 1;
        throw new Error("SYNTHETIC");
      },
    });
    const hostile = new Proxy(
      {},
      {
        get: () => {
          accesses += 1;
          throw new Error("SYNTHETIC");
        },
        getOwnPropertyDescriptor: () => {
          accesses += 1;
          throw new Error("SYNTHETIC");
        },
      },
    );
    const recursive = new Error("integration.controller.unsettled-operation");
    Object.defineProperty(recursive, "cause", { value: recursive });
    for (const value of [null, "SYNTHETIC", {}, hostile, accessor, recursive]) {
      expect(readControllerFailureDiagnostic(value).kind).toBe("unknown");
      expect(readImagePreparationDiagnostic(value)).toBeUndefined();
      const recorded = new IntegrationControllerFailure({
        primaryCause: value,
        retirementRequired: true,
      });
      expect(readControllerFailureDiagnostic(recorded).kind).toBe("unknown");
      expect(formatControllerFailureDiagnostic(recorded)).not.toContain(
        "SYNTHETIC",
      );
      expect(formatControllerFailureDiagnostic(recorded).length).toBeLessThan(
        1024,
      );
    }
    expect(accesses).toBe(0);
  });
});
