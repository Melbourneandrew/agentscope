import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type Observation = {
  maximum?: number;
  spawned: number;
  exitCode: number;
  error?: string;
  diagnostic?: string;
  terminal?: {
    contained: boolean;
    residualWorkObserved: boolean;
    terminationInitiated: boolean;
    completedWithinDeadline: boolean;
  };
};

// Both production modules execute unchanged; only the host clock and child
// payload are synthetic. The real supervisor owns and joins the Node child.
function observeWrapper(
  outer: string | undefined,
  uptime: string,
  diagnosticFailure?: "sync" | "async",
): Observation {
  const directory = resolve(import.meta.dirname, "..");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-vm-modules",
      "--input-type=module",
      "-e",
      `
      import { spawn } from 'node:child_process';
      import { readFileSync } from 'node:fs';
      import { resolve } from 'node:path';
      import { performance } from 'node:perf_hooks';
      import { EventEmitter } from 'node:events';
      import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
      import { mockServerResearchStopFitsTerminalObservation } from ${JSON.stringify(resolve(directory, "dist/mockserver-research-request.js"))};
      const directory = ${JSON.stringify(directory)};
      const outer = ${JSON.stringify(outer) ?? "undefined"};
      const uptime = ${JSON.stringify(uptime)};
      const observed = { spawned: 0, exitCode: 0 };
      const diagnosticFailure = ${JSON.stringify(diagnosticFailure) ?? "undefined"};
      const stdout = new EventEmitter();
      stdout.write = (value) => {
        if (diagnosticFailure === 'sync') throw new Error('synthetic-write');
        observed.diagnostic = value;
        if (diagnosticFailure === 'async') queueMicrotask(() =>
          stdout.emit('error', new Error('synthetic-EPIPE')));
      };
      const context = createContext({ process, setTimeout, clearTimeout });
      const synthetic = (values, selectedContext) => new SyntheticModule(
        Object.keys(values), function() {
          for (const [key, value] of Object.entries(values)) this.setExport(key, value);
        }, { context: selectedContext });
      const supervisor = new SourceTextModule(
        readFileSync(resolve(directory, 'supervisor.mjs'), 'utf8'), { context });
      await supervisor.link((name) => {
        if (name === 'node:perf_hooks') return synthetic({ performance }, context);
        if (name !== 'node:child_process') throw new Error('unexpected-supervisor-import');
        return synthetic({ spawn: (executable, arguments_, options) => {
          if (executable !== process.execPath || arguments_.length !== 1 ||
              arguments_[0] !== resolve(directory, 'controller-process.mjs'))
            throw new Error('unexpected-wrapper-child');
          observed.spawned++;
          return spawn(process.execPath, ['-e', 'process.exit(3)'], {
            ...options, stdio: 'ignore',
          });
        } }, context);
      });
      await supervisor.evaluate();
      const wrapperProcess = {
        env: outer === undefined ? {} : {
          AGENTSCOPE_INTEGRATION_OUTER_DEADLINE_MONOTONIC_MS: outer,
        }, execPath: process.execPath, exitCode: 0,
        stderr: { write() { throw new Error('unexpected-wrapper-stderr'); } },
        stdout,
      };
      const wrapperContext = createContext({ process: wrapperProcess });
      const wrapper = new SourceTextModule(
        readFileSync(resolve(directory, 'controller.mjs'), 'utf8'), {
          context: wrapperContext,
          initializeImportMeta(meta) { meta.dirname = directory; },
        });
      await wrapper.link((name) => {
        if (name === 'node:fs') return synthetic({ readFileSync: (path) => {
          if (path !== '/proc/uptime') throw new Error('unexpected-clock-path');
          return uptime + ' 0';
        } }, wrapperContext);
        if (name === 'node:path') return synthetic({ resolve }, wrapperContext);
        if (name === './dist/mockserver-research-request.js') return synthetic({
          mockServerResearchStopFitsTerminalObservation,
        }, wrapperContext);
        if (name !== './supervisor.mjs') throw new Error('unexpected-wrapper-import');
        return synthetic({ runSupervisedProcess: async (input) => {
          observed.maximum = input.maximumMilliseconds;
          observed.terminal = await supervisor.namespace.runSupervisedProcess(input);
          return observed.terminal;
        } }, wrapperContext);
      });
      try { await wrapper.evaluate(); }
      catch (error) { observed.error = error.message; }
      observed.exitCode = wrapperProcess.exitCode;
      console.log(JSON.stringify(observed));
      `,
    ],
    { env: {}, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Observation;
}

describe("actual controller wrapper preserves the original deadline", () => {
  it.each(["sync", "async"] as const)(
    "preserves settled research outcome after %s diagnostic failure",
    (failure) => {
      const result = observeWrapper("3248010", "2048.01", failure);
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(3);
      expect(result.terminal).toMatchObject({
        contained: true,
        residualWorkObserved: false,
      });
    },
  );
  it("floors a valid fractional host-derived budget and really joins the child", () => {
    const original = 3_248_010 - Number("2048.01") * 1000;
    expect(Number.isSafeInteger(original)).toBe(false);
    const result = observeWrapper("3248010", "2048.01");
    expect(result.maximum).toBe(Math.floor(original));
    expect(result.maximum).toBeLessThanOrEqual(original);
    expect(result).toMatchObject({
      maximum: 1_199_999,
      spawned: 1,
      exitCode: 3,
      terminal: {
        contained: true,
        residualWorkObserved: false,
        terminationInitiated: false,
        completedWithinDeadline: true,
      },
    });
    expect(result.error).toBeUndefined();
    expect(JSON.parse(result.diagnostic!)).toEqual({
      kind: "integration.controller.supervised-terminal",
      code: 3,
      signal: null,
      contained: true,
      residualWorkObserved: false,
      terminationInitiated: false,
      completedWithinDeadline: true,
    });
  });

  it.each([
    ["3248010", "2048.00", 1_200_010],
    [undefined, "invalid", 1_440_000],
    ["9999999", "2048.01", 1_440_000],
  ])(
    "preserves integer, default and capped budgets (%s)",
    (outer, uptime, maximum) => {
      expect(observeWrapper(outer, uptime)).toMatchObject({
        maximum,
        spawned: 1,
        exitCode: 3,
      });
    },
  );

  it.each([
    ["2168010", "2048.01"],
    ["2000000", "2048.01"],
    ["3248010.5", "2048.01"],
  ])(
    "rejects insufficient, expired or malformed authority before spawn (%s)",
    (outer, uptime) => {
      const result = observeWrapper(outer, uptime);
      expect(result).toMatchObject({
        spawned: 0,
        error: "integration.controller.outer-deadline",
      });
      expect(result.diagnostic).toBeUndefined();
    },
  );

  it("retains the actual supervisor's fail-closed malformed clock guard", () => {
    expect(observeWrapper("3248010", "invalid")).toMatchObject({
      spawned: 0,
      error: "integration.controller.deadline",
    });
  });
});
