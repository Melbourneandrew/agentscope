import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import * as rootApi from "../index.js";
import {
  createBoundedHeadlessSupervisorContractSuite,
  createHostileHeadlessProcessMatrix,
  type HeadlessObserverScenario,
} from "../headless-supervisor-contract.js";
import {
  executeBoundedHeadlessSupervisor,
  executeSelectedHeadlessProcess,
} from "../headless-supervisor-kernel.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
} from "../headless-supervisor.js";
import {
  composeSelectedContainerHeadlessSupervisorCapability,
  executeSelectedContainerBackendForTest,
  executeScriptedSelectedHeadlessProcessForTest,
  executeScriptedHeadlessSupervisorForTest,
  readHeadlessSupervisorKernelErrorCode,
  readScriptedHeadlessCancellationDeliveriesForTest,
  readScriptedHeadlessLaunchCountForTest,
} from "../internal/headless-supervisor-backend.js";

const cases = createBoundedHeadlessSupervisorContractSuite();
const hostileCases = createHostileHeadlessProcessMatrix();
const scenarioFor = (name: string): HeadlessObserverScenario => {
  if (name === "headless:correct-invocation") return "correct";
  if (name === "headless:stdout-limit") return "stdout-limit";
  if (name === "headless:stderr-limit") return "stderr-limit";
  if (name === "headless:timeout-escalation") return "timeout";
  if (name === "headless:descendant-cleanup") return "descendant";
  throw new Error("testkit.headless.seed.case");
};
const genericRequest = () => {
  const now = performance.now();
  return {
    runId: "0123456789abcdef",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    executable: "/opt/agentscope/bin/agentscope",
    arguments: ["doctor", "--output", "json"],
    cwd: "/worktree",
    environment: { HOME: "/home/agentscope", LANG: "C.UTF-8" },
    stdin: new Uint8Array(),
    stdoutLimitBytes: 1_024,
    stderrLimitBytes: 1_024,
    monotonicStartupDeadlineMs: now + 100,
    monotonicExecutionDeadlineMs: now + 200,
    monotonicShutdownDeadlineMs: now + 400,
    terminationGraceMs: 10,
  };
};

describe("bounded headless supervisor scripted protocol", () => {
  it.each(cases)(
    "verifies $name without launching an OS process",
    async (candidate) => {
      const run = candidate.instantiate({
        root: "/synthetic/fixture",
        fixturePath: "/synthetic/fixture/fixture.mjs",
      });
      const envelope = await executeScriptedHeadlessSupervisorForTest(
        scenarioFor(candidate.name),
        run.request,
      );
      const trace = run.verify(envelope);
      expect(trace.observation.cleanup).toBe("clean");
      expect(trace.observation.processJoined).toBe(true);
      expect(readScriptedHeadlessLaunchCountForTest()).toBe(1);
    },
  );

  it.each(["wrong-binding", "uncertain"] as const)(
    "rejects a %s terminal receipt",
    async (seed) => {
      const candidate = cases[0]!;
      const run = candidate.instantiate({
        root: "/synthetic/fixture",
        fixturePath: "/synthetic/fixture/fixture.mjs",
      });
      await expect(
        executeScriptedHeadlessSupervisorForTest("correct", run.request, seed),
      ).rejects.toMatchObject({ code: "testkit.headless.backend.receipt" });
    },
  );
});

describe("selected headless supervisor protocol", () => {
  it("uses the selected backend for a closed generic request", async () => {
    const request = genericRequest();
    const pending = executeScriptedSelectedHeadlessProcessForTest(request);
    request.arguments[0] = "mutated";
    request.environment.HOME = "/mutated";
    const trace = await pending;
    expect(trace).toMatchObject({
      runId: "0123456789abcdef",
      requestFingerprint: `sha256:${"a".repeat(64)}`,
      result: { cleanup: "clean", outcome: "exited" },
      observation: { processJoined: true },
    });
  });

  it.each(["wrong-binding", "uncertain"] as const)(
    "rejects a generic %s receipt",
    async (seed) => {
      await expect(
        executeScriptedSelectedHeadlessProcessForTest(genericRequest(), seed),
      ).rejects.toMatchObject({ code: "testkit.headless.backend.receipt" });
    },
  );

  it("does not create a fresh window after the generic deadline", async () => {
    const request = genericRequest();
    const now = performance.now();
    request.monotonicStartupDeadlineMs = now + 5;
    request.monotonicExecutionDeadlineMs = now + 15;
    request.monotonicShutdownDeadlineMs = now + 30;
    await expect(
      executeScriptedSelectedHeadlessProcessForTest(request, "late"),
    ).rejects.toMatchObject({
      code: "testkit.headless.reconciliation.deadline",
    });
  });

  it("rejects an already-aborted generic request before launch", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeScriptedSelectedHeadlessProcessForTest(genericRequest(), "clean", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "testkit.headless.aborted" });
  });
});

describe("selected-container lifecycle", () => {
  it.each([
    ["clean", "exited"],
    ["descendant", "exited"],
    ["output-limit", "output-limit"],
    ["timeout", "timed-out"],
  ] as const)(
    "closes the selected-container %s lifecycle",
    async (seed, outcome) => {
      const request = genericRequest();
      request.monotonicStartupDeadlineMs = performance.now() + 50;
      request.monotonicExecutionDeadlineMs = performance.now() + 80;
      request.monotonicShutdownDeadlineMs = performance.now() + 160;
      const trace = await executeSelectedContainerBackendForTest(request, seed);
      expect(trace.result).toMatchObject({ cleanup: "clean", outcome });
      expect(trace.observation).toMatchObject({
        processJoined: true,
        stdinJoined: true,
        stdoutJoined: true,
        stderrJoined: true,
      });
    },
  );

  it.each([
    ["fast-exit", "testkit.headless.observer.root"],
    ["identity-substitution", "testkit.headless.observer.identity"],
    ["observer-failure", "testkit.headless.observer.read"],
    ["signal-failure", "testkit.headless.observer.signal"],
    ["stream-join-failure", "testkit.headless.reconciliation.deadline"],
    ["terminal-join-failure", "testkit.headless.reconciliation.deadline"],
  ] as const)("fails closed for selected-container %s", async (seed, code) => {
    const request = genericRequest();
    request.monotonicStartupDeadlineMs = performance.now() + 30;
    request.monotonicExecutionDeadlineMs = performance.now() + 50;
    request.monotonicShutdownDeadlineMs = performance.now() + 100;
    await expect(
      executeSelectedContainerBackendForTest(request, seed),
    ).rejects.toMatchObject({ code });
  });

  it("returns the joined selected-container abort receipt", async () => {
    const request = genericRequest();
    request.monotonicStartupDeadlineMs = performance.now() + 30;
    request.monotonicExecutionDeadlineMs = performance.now() + 50;
    request.monotonicShutdownDeadlineMs = performance.now() + 100;
    const trace = await executeSelectedContainerBackendForTest(
      request,
      "abort",
    );
    expect(trace.result).toMatchObject({
      cleanup: "clean",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(trace.observation.processJoined).toBe(true);
  });

  it("rechecks startup authority adjacent to selected-container spawn", async () => {
    const request = genericRequest();
    request.monotonicStartupDeadlineMs = performance.now() + 5;
    request.monotonicExecutionDeadlineMs = performance.now() + 50;
    request.monotonicShutdownDeadlineMs = performance.now() + 100;
    await expect(
      executeSelectedContainerBackendForTest(request, "startup-delay"),
    ).rejects.toMatchObject({ code: "testkit.headless.startup.deadline" });
  });
});

// The closed table keeps its full terminal and evidence oracle together.
// eslint-disable-next-line max-lines-per-function
describe("comprehensive hostile selected-container matrix", () => {
  it.each(hostileCases)("certifies $name", async (candidate) => {
    const request = genericRequest();
    request.monotonicStartupDeadlineMs =
      performance.now() + (candidate.seed === "delayed-startup" ? 5 : 50);
    request.monotonicExecutionDeadlineMs = performance.now() + 80;
    request.monotonicShutdownDeadlineMs = performance.now() + 180;
    let trace: Awaited<
      ReturnType<typeof executeSelectedContainerBackendForTest>
    > | null = null;
    let code: string | undefined;
    try {
      trace = await executeSelectedContainerBackendForTest(
        request,
        candidate.seed,
      );
    } catch (error: unknown) {
      code = readHeadlessSupervisorKernelErrorCode(error);
    }
    if (candidate.terminal.kind === "error") {
      expect(trace).toBeNull();
      expect(code).toBe(candidate.terminal.code);
      return;
    }
    expect(code).toBeUndefined();
    expect(trace).not.toBeNull();
    expect(trace!.result).toMatchObject({
      outcome: candidate.terminal.outcome,
      exitCode: candidate.terminal.exitCode,
      diagnosticCode: candidate.terminal.diagnosticCode,
    });
    expect(trace!.result.cleanup).toBe("clean");
    expect(trace!.observation).toMatchObject({
      cleanup: "clean",
      processJoined: true,
      stdinJoined: true,
      stdoutJoined: true,
      stderrJoined: true,
    });

    if (candidate.seed === "partial-output") {
      expect(new TextDecoder().decode(trace!.result.stdout)).toBe("partial");
      expect(new TextDecoder().decode(trace!.result.stderr)).toBe("fragment");
    } else if (candidate.seed === "malformed-output") {
      expect([...trace!.result.stdout]).toEqual([0xc3]);
    } else if (
      candidate.seed === "oversized-output" ||
      candidate.seed === "infinite-output"
    ) {
      expect(trace!.result.stdout.byteLength).toBe(request.stdoutLimitBytes);
      expect(trace!.result.stdoutTruncated).toBe(true);
    } else if (candidate.seed === "restricted-environment") {
      expect(
        JSON.parse(new TextDecoder().decode(trace!.result.stdout)),
      ).toEqual({ environmentKeys: ["HOME", "LANG"] });
    } else if (
      candidate.seed === "missing-hook-record" ||
      candidate.seed === "duplicate-hook-record"
    ) {
      expect(
        JSON.parse(new TextDecoder().decode(trace!.result.stdout)),
      ).toEqual({
        hookDeliveries: candidate.seed === "missing-hook-record" ? 0 : 2,
      });
      expect("hookDeliveries" in trace!).toBe(false);
      expect(candidate.evidenceAuthority).toBe("component-only");
    } else if (candidate.seed === "signal-race") {
      expect(trace!.result).toMatchObject({
        signal: "SIGTERM",
        termRequested: true,
        killRequested: false,
      });
    } else if (candidate.seed === "surviving-descendant") {
      expect(trace!.observation.processes.map(({ role }) => role)).toEqual([
        "root",
        "descendant",
      ]);
      expect(trace!.observation.signals).toHaveLength(1);
    }
  });

  it("keeps concurrent sessions isolated and deterministically classified", async () => {
    const first = genericRequest();
    const second = genericRequest();
    second.runId = "fedcba9876543210";
    second.requestFingerprint = `sha256:${"b".repeat(64)}`;
    for (const request of [first, second]) {
      request.monotonicStartupDeadlineMs = performance.now() + 50;
      request.monotonicExecutionDeadlineMs = performance.now() + 80;
      request.monotonicShutdownDeadlineMs = performance.now() + 180;
    }
    const [firstTrace, secondTrace] = await Promise.all([
      executeSelectedContainerBackendForTest(first, "partial-output"),
      executeSelectedContainerBackendForTest(second, "surviving-descendant"),
    ]);
    expect(firstTrace.runId).toBe(first.runId);
    expect(secondTrace.runId).toBe(second.runId);
    expect(firstTrace.requestFingerprint).toBe(first.requestFingerprint);
    expect(secondTrace.requestFingerprint).toBe(second.requestFingerprint);
    expect(firstTrace.observation.processes).toHaveLength(1);
    expect(secondTrace.observation.processes).toHaveLength(2);
  });

  it("retains deterministic content-free classifications under repetition", async () => {
    const projections = [];
    for (let index = 0; index < 8; index += 1) {
      const request = genericRequest();
      request.monotonicStartupDeadlineMs = performance.now() + 50;
      request.monotonicExecutionDeadlineMs = performance.now() + 80;
      request.monotonicShutdownDeadlineMs = performance.now() + 180;
      const trace = await executeSelectedContainerBackendForTest(
        request,
        "ignored-termination",
      );
      projections.push({
        outcome: trace.result.outcome,
        signal: trace.result.signal,
        cleanup: trace.result.cleanup,
        processJoined: trace.observation.processJoined,
        residualProcessCount: trace.result.residualProcessCount,
        stdoutBytes: trace.result.stdout.byteLength,
        stderrBytes: trace.result.stderr.byteLength,
      });
    }
    expect(
      new Set(projections.map((value) => JSON.stringify(value))).size,
    ).toBe(1);
  });
});

describe("bounded headless supervisor sequencing", () => {
  it("fails closed at the original shutdown authority without a fresh callback", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const now = performance.now();
    const request = {
      ...run.request,
      arguments: [...run.request.arguments],
      environment: { ...run.request.environment },
      stdin: new Uint8Array(run.request.stdin),
      monotonicStartupDeadlineMs: now + 50,
      monotonicExecutionDeadlineMs: now + 100,
      monotonicShutdownDeadlineMs: now + 300,
      terminationGraceMs: 10,
    };
    const startedAt = performance.now();
    const pending = executeScriptedHeadlessSupervisorForTest(
      "correct",
      request,
      "late",
    );
    request.monotonicShutdownDeadlineMs = now + 1_500;
    await expect(pending).rejects.toMatchObject({
      code: "testkit.headless.reconciliation.deadline",
    });
    expect(performance.now() - startedAt).toBeLessThan(800);
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(1);
  });

  it("uses one deep request snapshot across every asynchronous boundary", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const request = {
      ...run.request,
      arguments: [...run.request.arguments],
      environment: { ...run.request.environment },
      stdin: new Uint8Array(run.request.stdin),
    };
    const pending = executeScriptedHeadlessSupervisorForTest(
      "correct",
      request,
    );
    request.runId = "mutated-run";
    request.requestFingerprint = "mutated-fingerprint";
    request.arguments[0] = "mutated-argument";
    request.environment.AGENTSCOPE_ORACLE_VISIBLE = "mutated-environment";
    request.stdin[0] = 0;
    request.monotonicShutdownDeadlineMs += 20_000;
    const envelope = await pending;
    expect(() => run.verify(envelope)).not.toThrow();
  });

  it("delivers cancellation to the already-armed backend and fails closed", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const controller = new AbortController();
    const pending = executeScriptedHeadlessSupervisorForTest(
      "correct",
      run.request,
      "cancelled",
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "testkit.headless.aborted",
    });
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(1);
    expect(readScriptedHeadlessCancellationDeliveriesForTest()).toBe(1);
  });

  it("does not arm or launch when cancellation already exists", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeScriptedHeadlessSupervisorForTest(
        "correct",
        run.request,
        "clean",
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "testkit.headless.aborted" });
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(0);
  });
});

describe("bounded headless supervisor authority", () => {
  it("does not compose selected-container authority outside PID 1", () => {
    expect(() =>
      composeSelectedContainerHeadlessSupervisorCapability(
        performance.now() + 10_000,
      ),
    ).toThrow("testkit.headless.capability");
  });

  it("rejects forged production authority before hostile request input", async () => {
    let consulted = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => {
        consulted += 1;
        throw new Error("must-not-run");
      },
    });
    await expect(
      executeSelectedHeadlessProcess(
        Object.freeze({}) as HeadlessSupervisorCapability,
        hostile as never,
      ),
    ).rejects.toMatchObject({ code: "testkit.headless.capability" });
    expect(consulted).toBe(0);
  });

  it("rejects forged authority before consulting caller request data", async () => {
    let consulted = 0;
    const hostile = new Proxy(Object.create(null) as object, {
      get: () => {
        consulted += 1;
        throw new Error("must-not-run");
      },
    });
    await expect(
      executeBoundedHeadlessSupervisor(
        Object.freeze({}) as HeadlessSupervisorCapability,
        "correct",
        hostile as never,
      ),
    ).rejects.toMatchObject({
      code: "testkit.headless.capability",
      message: "testkit.headless.capability",
    });
    expect(consulted).toBe(0);
  });

  it("rejects forged authority before consulting caller cancellation data", async () => {
    let consulted = 0;
    const options = new Proxy(Object.create(null) as object, {
      get: () => {
        consulted += 1;
        throw new Error("must-not-run");
      },
    });
    await expect(
      executeBoundedHeadlessSupervisor(
        Object.freeze({}) as HeadlessSupervisorCapability,
        "correct",
        {} as never,
        options as never,
      ),
    ).rejects.toMatchObject({
      code: "testkit.headless.capability",
      message: "testkit.headless.capability",
    });
    expect(consulted).toBe(0);
  });

  it("normalizes a forged AbortSignal without invoking its callbacks", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    let consulted = 0;
    const signal = new Proxy(Object.create(null) as object, {
      get: () => {
        consulted += 1;
        throw new Error("caller-signal-content");
      },
    });
    await expect(
      executeScriptedHeadlessSupervisorForTest(
        "correct",
        run.request,
        "clean",
        { signal: signal as AbortSignal },
      ),
    ).rejects.toMatchObject({
      code: "testkit.headless.aborted",
      message: "testkit.headless.aborted",
    });
    expect(consulted).toBe(0);
  });
});

describe("bounded headless supervisor input authority", () => {
  it("rejects cancellation accessors only after snapshotting request authority", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const request = { ...run.request };
    const originalDeadline = request.monotonicShutdownDeadlineMs;
    let callbacks = 0;
    const options = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(options, "signal", {
      get: () => {
        callbacks += 1;
        request.monotonicShutdownDeadlineMs += 20_000;
        return undefined;
      },
    });
    await expect(
      executeScriptedHeadlessSupervisorForTest(
        "correct",
        request,
        "clean",
        options as never,
      ),
    ).rejects.toMatchObject({ code: "testkit.headless.kernel.options" });
    expect(callbacks).toBe(0);
    expect(request.monotonicShutdownDeadlineMs).toBe(originalDeadline);
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(0);
  });

  it("keeps pre-abort semantics when ambient Boolean changes after import", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const controller = new AbortController();
    controller.abort();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Boolean")!;
    let failure: unknown;
    try {
      Object.defineProperty(globalThis, "Boolean", {
        ...descriptor,
        value: () => false,
      });
      try {
        await executeScriptedHeadlessSupervisorForTest(
          "correct",
          run.request,
          "clean",
          { signal: controller.signal },
        );
      } catch (error: unknown) {
        failure = error;
      }
    } finally {
      Object.defineProperty(globalThis, "Boolean", descriptor);
    }
    expect(failure).toMatchObject({ code: "testkit.headless.aborted" });
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(0);
  });

  it("does not launch after the startup authority expires", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const now = performance.now();
    await expect(
      executeScriptedHeadlessSupervisorForTest("correct", {
        ...run.request,
        monotonicStartupDeadlineMs: now - 3,
        monotonicExecutionDeadlineMs: now + 100,
        monotonicShutdownDeadlineMs: now + 2_000,
      }),
    ).rejects.toMatchObject({ code: "testkit.headless.startup.deadline" });
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(0);
  });

  it("rejects proxy and accessor request shapes without invoking caller code", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    let callbacks = 0;
    const proxied = new Proxy(run.request, {
      get: () => {
        callbacks += 1;
        throw new Error("caller-content");
      },
    });
    await expect(
      executeScriptedHeadlessSupervisorForTest("correct", proxied),
    ).rejects.toMatchObject({ code: "testkit.headless.kernel.request" });
    const accessor = { ...run.request };
    Object.defineProperty(accessor, "runId", {
      get: () => {
        callbacks += 1;
        throw new Error("caller-content");
      },
    });
    await expect(
      executeScriptedHeadlessSupervisorForTest("correct", accessor),
    ).rejects.toMatchObject({ code: "testkit.headless.kernel.request" });
    expect(callbacks).toBe(0);
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(0);
  });
});

describe("bounded headless supervisor provenance", () => {
  it("freezes the diagnostic superclass before callers can install a carrier", () => {
    const carrier = function (): Error {
      return new Error("caller-controlled-carrier");
    };
    expect(Reflect.setPrototypeOf(HeadlessSupervisorError, carrier)).toBe(
      false,
    );
    const error = new HeadlessSupervisorError(
      "testkit.headless.kernel.failure",
    );
    expect(error).toMatchObject({
      code: "testkit.headless.kernel.failure",
      message: "testkit.headless.kernel.failure",
    });
    expect(String(error)).not.toContain("caller-controlled-carrier");
  });

  it("keeps capability provenance immutable after import", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      WeakMap.prototype,
      "get",
    )!;
    let callbacks = 0;
    let failure: unknown;
    try {
      Object.defineProperty(WeakMap.prototype, "get", {
        ...descriptor,
        value: () => {
          callbacks += 1;
          throw new Error("prototype-poison-called");
        },
      });
      try {
        await executeBoundedHeadlessSupervisor(
          Object.freeze({}) as HeadlessSupervisorCapability,
          "correct",
          {} as never,
        );
      } catch (error: unknown) {
        failure = error;
      }
    } finally {
      Object.defineProperty(WeakMap.prototype, "get", descriptor);
    }
    expect(failure).toMatchObject({ code: "testkit.headless.capability" });
    expect(callbacks).toBe(0);
  });
});

describe("bounded headless supervisor package surface", () => {
  it("keeps scripted and selected-backend authority off public exports", () => {
    expect("executeScriptedHeadlessSupervisorForTest" in rootApi).toBe(false);
    expect("readScriptedHeadlessLaunchCountForTest" in rootApi).toBe(false);
    expect("readScriptedHeadlessCancellationDeliveriesForTest" in rootApi).toBe(
      false,
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports?: unknown };
    expect(manifest.exports).toBe("./dist/index.js");
  });
});

describe("emitted selected-container lifecycle", () => {
  it("runs the adversarial lifecycle matrix from freshly emitted JavaScript", () => {
    const workspaceRoot = resolve(import.meta.dirname, "../../../..");
    const directory = mkdtempSync(
      resolve(tmpdir(), "agentscope-testkit-dist-"),
    );
    try {
      const compilation = spawnSync(
        process.execPath,
        [
          resolve(workspaceRoot, "node_modules/typescript/bin/tsc"),
          "-p",
          resolve(workspaceRoot, "packages/testkit/tsconfig.build.json"),
          "--outDir",
          directory,
        ],
        { encoding: "utf8" },
      );
      expect(compilation.status, compilation.stderr).toBe(0);
      const runner = resolve(directory, "emitted-lifecycle-review.mjs");
      writeFileSync(
        runner,
        `import { performance } from "node:perf_hooks";
	import { createHostileHeadlessProcessMatrix } from "./headless-supervisor-contract.js";
	import { executeSelectedContainerBackendForTest, readHeadlessSupervisorKernelErrorCode } from "./internal/headless-supervisor-backend.js";

const request = () => {
  const now = performance.now();
  return {
    runId: "0123456789abcdef",
    requestFingerprint: "sha256:${"a".repeat(64)}",
    executable: "/opt/agentscope/bin/agentscope",
    arguments: [],
    cwd: "/worktree",
    environment: { HOME: "/home/agentscope" },
    stdin: new Uint8Array(),
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    monotonicStartupDeadlineMs: now + 50,
    monotonicExecutionDeadlineMs: now + 80,
    monotonicShutdownDeadlineMs: now + 160,
    terminationGraceMs: 10,
  };
};

for (const seed of ["clean", "descendant", "output-limit", "timeout", "abort"]) {
  const result = await executeSelectedContainerBackendForTest(request(), seed);
  if (!result.observation.processJoined) throw new Error("emitted-positive-not-joined");
}
for (const seed of ["fast-exit", "identity-substitution", "observer-failure", "signal-failure", "stream-join-failure", "terminal-join-failure"]) {
  let rejected = false;
  try { await executeSelectedContainerBackendForTest(request(), seed); }
  catch { rejected = true; }
  if (!rejected) throw new Error("emitted-negative-admitted:" + seed);
}
for (const candidate of createHostileHeadlessProcessMatrix()) {
  const selected = request();
  if (candidate.seed === "delayed-startup") selected.monotonicStartupDeadlineMs = performance.now() + 5;
  let result;
  let code;
  try { result = await executeSelectedContainerBackendForTest(selected, candidate.seed); }
  catch (error) { code = readHeadlessSupervisorKernelErrorCode(error); }
  if (candidate.terminal.kind === "error") {
    if (result !== undefined || code !== candidate.terminal.code) throw new Error("emitted-hostile-error:" + candidate.seed);
  } else if (result?.result.outcome !== candidate.terminal.outcome || result.result.exitCode !== candidate.terminal.exitCode || result.result.diagnosticCode !== candidate.terminal.diagnosticCode || !result.observation.processJoined) {
    throw new Error("emitted-hostile-trace:" + candidate.seed);
  }
}
`,
        { encoding: "utf8", mode: 0o600 },
      );
      const replay = spawnSync(process.execPath, [runner], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(replay.status, `${replay.stdout}\n${replay.stderr}`).toBe(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }, 20_000);
});
