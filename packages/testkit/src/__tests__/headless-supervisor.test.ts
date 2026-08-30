import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  executeSyntheticBackendDeadlineSeedForTest,
  executeSyntheticComponentFixtureHeadlessSupervisor,
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

const fixtureFor = (
  source: string,
): Readonly<{ file: string; root: string }> => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "agentscope-supervisor-kernel-")),
  );
  const file = join(root, "fixture.mjs");
  writeFileSync(file, source, { encoding: "utf8", mode: 0o600 });
  return { file, root };
};

const processesContaining = (needle: string): readonly string[] => {
  if (process.platform === "win32") return [];
  const output = execFileSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
    maxBuffer: 1_048_576,
    timeout: 1_000,
  });
  return output.split("\n").filter((line) => line.includes(needle));
};

describe("bounded headless supervisor kernel", () => {
  it.each(cases)(
    "executes and verifies $name as closed synthetic component evidence",
    async (candidate) => {
      if (process.platform === "win32") return;
      const fixture = fixtureFor(candidate.fixtureSource);
      try {
        const run = candidate.instantiate({
          root: fixture.root,
          fixturePath: fixture.file,
        });
        const envelope =
          await executeSyntheticComponentFixtureHeadlessSupervisor(
            scenarioFor(candidate.name),
            run.request,
          );
        const trace = run.verify(envelope);
        expect(trace.runId).toBe(run.request.runId);
        expect(trace.observation.processJoined).toBe(true);
        expect(trace.observation.cleanup).toBe("clean");
      } finally {
        expect(processesContaining(fixture.file)).toEqual([]);
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
    12_000,
  );
});

describe("bounded headless supervisor authority and startup", () => {
  it("rejects missing or forged authority before launching", async () => {
    const candidate = cases[0]!;
    const fixture = fixtureFor(candidate.fixtureSource);
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      await expect(
        executeBoundedHeadlessSupervisor(
          Object.freeze({}) as HeadlessSupervisorCapability,
          "correct",
          run.request,
        ),
      ).rejects.toMatchObject({ code: "testkit.headless.capability" });
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects forged authority before consulting hostile request data", async () => {
    let consulted = 0;
    const hostileRequest = new Proxy(Object.create(null) as object, {
      get: () => {
        consulted += 1;
        throw new Error("must-not-run");
      },
    });
    await expect(
      executeBoundedHeadlessSupervisor(
        Object.freeze({}) as HeadlessSupervisorCapability,
        "correct",
        hostileRequest as never,
      ),
    ).rejects.toMatchObject({
      code: "testkit.headless.capability",
      message: "testkit.headless.capability",
    });
    expect(consulted).toBe(0);
  });

  it("rejects an expired startup authority before launching", async () => {
    const candidate = cases[0]!;
    const fixture = fixtureFor(candidate.fixtureSource);
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      const now = performance.now();
      const expired = {
        ...run.request,
        monotonicStartupDeadlineMs: now - 3_000,
        monotonicExecutionDeadlineMs: now - 2_000,
        monotonicShutdownDeadlineMs: now - 500,
      };
      await expect(
        executeSyntheticComponentFixtureHeadlessSupervisor("correct", expired),
      ).rejects.toMatchObject({ code: "testkit.headless.startup.deadline" });
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a non-fixture executable before component launch", async () => {
    const candidate = cases[0]!;
    const fixture = fixtureFor(candidate.fixtureSource);
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      await expect(
        executeSyntheticComponentFixtureHeadlessSupervisor("correct", {
          ...run.request,
          executable: join(fixture.root, "missing"),
        }),
      ).rejects.toMatchObject({
        code: "testkit.headless.component.fixture",
        message: "testkit.headless.component.fixture",
      });
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("bounded headless supervisor component boundary", () => {
  it("rejects an escaped-descendant stimulus outside the closed component family", async () => {
    if (process.platform === "win32") return;
    const token = `agentscope-fast-escape-${process.pid}`;
    const fixture = fixtureFor(`
      import { spawn } from "node:child_process";
      spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", ${JSON.stringify(token)}], {
        detached: true,
        stdio: "ignore",
      }).unref();
      setTimeout(() => {}, 300);
    `);
    try {
      const candidate = cases.find(
        ({ name }) => name === "headless:descendant-cleanup",
      )!;
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      await expect(
        executeSyntheticComponentFixtureHeadlessSupervisor(
          "descendant",
          run.request,
        ),
      ).rejects.toMatchObject({
        code: "testkit.headless.component.fixture",
        message: "testkit.headless.component.fixture",
      });
      expect(processesContaining(token)).toEqual([]);
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("bounded headless supervisor diagnostics", () => {
  it("rejects hostile component arguments with a content-free diagnostic", async () => {
    const candidate = cases[0]!;
    const fixture = fixtureFor(candidate.fixtureSource);
    const secret = "must-not-escape";
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      let received: unknown;
      try {
        await executeSyntheticComponentFixtureHeadlessSupervisor("correct", {
          ...run.request,
          arguments: [`\0${secret}`],
        });
      } catch (error: unknown) {
        received = error;
      }
      expect(received).toMatchObject({
        code: "testkit.headless.component.fixture",
        message: "testkit.headless.component.fixture",
      });
      expect(String(received)).not.toContain(secret);
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("bounded headless supervisor reconciliation authority", () => {
  it.each(["live-never", "signal-never"] as const)(
    "fails the %s backend seed within the original shutdown authority",
    async (seed) => {
      if (process.platform === "win32") return;
      const candidate = cases.find(
        ({ name }) => name === "headless:stdout-limit",
      )!;
      const fixture = fixtureFor(candidate.fixtureSource);
      try {
        const run = candidate.instantiate({
          root: fixture.root,
          fixturePath: fixture.file,
        });
        const now = performance.now();
        const request = {
          ...run.request,
          monotonicStartupDeadlineMs: now + 300,
          monotonicExecutionDeadlineMs: now + 700,
          monotonicShutdownDeadlineMs: now + 1_700,
          terminationGraceMs: 200,
        };
        await expect(
          executeSyntheticBackendDeadlineSeedForTest(
            seed,
            "stdout-limit",
            request,
          ),
        ).rejects.toMatchObject({
          code: "testkit.headless.reconciliation.deadline",
          message: "testkit.headless.reconciliation.deadline",
        });
        expect(performance.now()).toBeLessThan(
          request.monotonicShutdownDeadlineMs + 500,
        );
        expect(processesContaining(fixture.file)).toEqual([]);
      } finally {
        rmSync(fixture.root, { force: true, recursive: true });
      }
    },
    5_000,
  );
});

describe("bounded headless supervisor cancellation and surface", () => {
  it("delivers cancellation and joins the process before rejecting", async () => {
    if (process.platform === "win32") return;
    const candidate = cases.find(
      ({ name }) => name === "headless:timeout-escalation",
    )!;
    const markerName = "pre-abort-launched";
    const fixture = fixtureFor(
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerName)}, "launched");\n${candidate.fixtureSource}`,
    );
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        executeSyntheticComponentFixtureHeadlessSupervisor(
          "timeout",
          run.request,
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "testkit.headless.aborted" });
      expect(() => readFileSync(join(fixture.root, markerName))).toThrow();
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }, 12_000);

  it("delivers cancellation after launch and joins before rejecting", async () => {
    if (process.platform === "win32") return;
    const candidate = cases.find(
      ({ name }) => name === "headless:timeout-escalation",
    )!;
    const fixture = fixtureFor(candidate.fixtureSource);
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      const controller = new AbortController();
      Object.defineProperty(controller.signal, "removeEventListener", {
        value: () => {
          throw new HeadlessSupervisorError("caller-controlled-diagnostic");
        },
      });
      const execution = executeSyntheticComponentFixtureHeadlessSupervisor(
        "timeout",
        run.request,
        controller.signal,
      );
      setTimeout(() => {
        controller.abort();
      }, 100);
      await expect(execution).rejects.toMatchObject({
        code: "testkit.headless.aborted",
        message: "testkit.headless.aborted",
      });
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  }, 12_000);

  it("sanitizes caller failures before a capability can launch", async () => {
    const candidate = cases[0]!;
    const fixture = fixtureFor(candidate.fixtureSource);
    const secret = "caller-controlled-diagnostic";
    try {
      const run = candidate.instantiate({
        root: fixture.root,
        fixturePath: fixture.file,
      });
      const options = Object.defineProperty({}, "signal", {
        get: () => {
          throw new HeadlessSupervisorError(secret);
        },
      });
      let received: unknown;
      try {
        await executeBoundedHeadlessSupervisor(
          Object.freeze({}) as HeadlessSupervisorCapability,
          "correct",
          run.request,
          options,
        );
      } catch (error: unknown) {
        received = error;
      }
      expect(received).toMatchObject({
        code: "testkit.headless.kernel.failure",
        message: "testkit.headless.kernel.failure",
      });
      expect(String(received)).not.toContain(secret);
      expect(processesContaining(fixture.file)).toEqual([]);
    } finally {
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps the package-private authority mint off root and subpath surfaces", async () => {
    expect(
      "executeSyntheticComponentFixtureHeadlessSupervisor" in rootApi,
    ).toBe(false);
    expect("executeSyntheticBackendDeadlineSeedForTest" in rootApi).toBe(false);
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports?: unknown };
    expect(manifest.exports).toBe("./dist/index.js");
    const privateSpecifier =
      "@agentscope/testkit/internal/headless-supervisor-backend";
    await expect(import(privateSpecifier)).rejects.toBeDefined();
  });
});
