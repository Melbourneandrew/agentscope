import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import * as rootApi from "../index.js";
import {
  createBoundedHeadlessSupervisorContractSuite,
  type HeadlessObserverScenario,
} from "../headless-supervisor-contract.js";
import { executeBoundedHeadlessSupervisor } from "../headless-supervisor-kernel.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
} from "../headless-supervisor.js";
import {
  executeScriptedHeadlessSupervisorForTest,
  readScriptedHeadlessCancellationDeliveriesForTest,
  readScriptedHeadlessLaunchCountForTest,
} from "../internal/headless-supervisor-backend.js";

const cases = createBoundedHeadlessSupervisorContractSuite();
const scenarioFor = (name: string): HeadlessObserverScenario => {
  if (name === "headless:correct-invocation") return "correct";
  if (name === "headless:stdout-limit") return "stdout-limit";
  if (name === "headless:stderr-limit") return "stderr-limit";
  if (name === "headless:timeout-escalation") return "timeout";
  if (name === "headless:descendant-cleanup") return "descendant";
  throw new Error("testkit.headless.seed.case");
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

  it("fails closed at the original shutdown authority without a fresh callback", async () => {
    const candidate = cases[0]!;
    const run = candidate.instantiate({
      root: "/synthetic/fixture",
      fixturePath: "/synthetic/fixture/fixture.mjs",
    });
    const now = performance.now();
    await expect(
      executeScriptedHeadlessSupervisorForTest(
        "correct",
        {
          ...run.request,
          monotonicStartupDeadlineMs: now + 50,
          monotonicExecutionDeadlineMs: now + 100,
          monotonicShutdownDeadlineMs: now + 180,
          terminationGraceMs: 10,
        },
        "late",
      ),
    ).rejects.toMatchObject({
      code: "testkit.headless.reconciliation.deadline",
    });
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(1);
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
      controller.signal,
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
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "testkit.headless.aborted" });
    expect(readScriptedHeadlessLaunchCountForTest()).toBe(0);
  });
});

describe("bounded headless supervisor authority", () => {
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
        signal as AbortSignal,
      ),
    ).rejects.toMatchObject({
      code: "testkit.headless.aborted",
      message: "testkit.headless.aborted",
    });
    expect(consulted).toBe(0);
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
  it("keeps scripted and selected-backend authority off public exports", async () => {
    expect("executeScriptedHeadlessSupervisorForTest" in rootApi).toBe(false);
    expect("readScriptedHeadlessLaunchCountForTest" in rootApi).toBe(false);
    expect("readScriptedHeadlessCancellationDeliveriesForTest" in rootApi).toBe(
      false,
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports?: unknown };
    expect(manifest.exports).toBe("./dist/index.js");
    const privateSpecifier =
      "@agentscope/testkit/internal/headless-supervisor-backend";
    await expect(import(privateSpecifier)).rejects.toBeDefined();
  });
});
