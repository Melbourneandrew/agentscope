import { spawn } from "node:child_process";

import type { HarnessScenarioAdapter } from "@agentscope/harnesses-core/testing";

/** Versioned recipe supplied by each @agentscope/harness-* package. */
export interface HarnessScenario {
  id: string;
  harness: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  expect: HarnessExpectations;
}

export interface HarnessExpectations {
  modelPaths: readonly string[];
  telemetryPaths: readonly string[];
  exitCode?: number;
}

export interface HarnessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HarnessScenarioRuntime {
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  expect: HarnessExpectations;
}

/** Composes family-owned harness data with the generic isolated process seam. */
export function composeHarnessScenario(
  adapter: HarnessScenarioAdapter,
  runtime: HarnessScenarioRuntime,
): Readonly<HarnessScenario> {
  return Object.freeze({
    id: adapter.scenarioId,
    harness: adapter.harnessId,
    command: runtime.command,
    args: Object.freeze([...adapter.commandArguments]),
    cwd: runtime.cwd,
    env: Object.freeze({ ...runtime.env }),
    ...(runtime.timeoutMs === undefined
      ? {}
      : { timeoutMs: runtime.timeoutMs }),
    expect: Object.freeze({
      modelPaths: Object.freeze([...runtime.expect.modelPaths]),
      telemetryPaths: Object.freeze([...runtime.expect.telemetryPaths]),
      ...(runtime.expect.exitCode === undefined
        ? {}
        : { exitCode: runtime.expect.exitCode }),
    }),
  });
}

/** Runs a real harness process; testkit never replaces the executable with a fake. */
export async function runHarnessScenario(
  scenario: HarnessScenario,
): Promise<HarnessRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(scenario.command, [...scenario.args], {
      cwd: scenario.cwd,
      env: { ...process.env, ...scenario.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Harness scenario ${scenario.id} timed out after ${scenario.timeoutMs ?? 60_000}ms`,
        ),
      );
    }, scenario.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export function assertHarnessExit(
  result: HarnessRunResult,
  scenario: HarnessScenario,
): void {
  const expected = scenario.expect.exitCode ?? 0;
  if (result.exitCode !== expected) {
    throw new Error(
      `Harness ${scenario.harness} scenario ${scenario.id} exited ${result.exitCode}; expected ${expected}. stderr: ${result.stderr}`,
    );
  }
}
