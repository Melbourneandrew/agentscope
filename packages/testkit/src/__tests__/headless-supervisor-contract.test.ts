import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createBoundedHeadlessSupervisorContractSuite,
  type HeadlessExecutionRequest,
  type HeadlessExecutionResult,
  type HeadlessSupervisorContractAdapter,
} from "../headless-supervisor-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const absentPid = 999_999_999;

type FixtureKind =
  "correct" | "stdout-limit" | "stderr-limit" | "timeout" | "descendant";

const fixtureKind = async (
  request: HeadlessExecutionRequest,
): Promise<FixtureKind> => {
  const path = request.arguments[0];
  if (path === undefined) throw new Error("seed.fixture.path");
  const source = await readFile(path, "utf8");
  if (source.includes("PRIVATE_TIMEOUT_CANARY")) return "timeout";
  if (source.includes("child.unref()")) return "descendant";
  if (source.includes('"O".repeat(4096)')) return "stdout-limit";
  if (source.includes('"E".repeat(4096)')) return "stderr-limit";
  return "correct";
};

const result = (
  overrides: Partial<HeadlessExecutionResult> = {},
): HeadlessExecutionResult => ({
  resultVersion: 1,
  outcome: "exited",
  exitCode: 0,
  signal: null,
  stdout: new Uint8Array(),
  stderr: new Uint8Array(),
  stdoutTruncated: false,
  stderrTruncated: false,
  termRequested: false,
  killRequested: false,
  cleanup: "clean",
  residualProcessCount: 0,
  diagnosticCode: null,
  ...overrides,
});

const correctResult = (request: HeadlessExecutionRequest) =>
  result({
    stdout: encoder.encode(
      JSON.stringify({
        arguments: request.arguments.slice(1),
        cwd: request.cwd,
        environment: request.environment,
        input: decoder.decode(request.stdin),
      }),
    ),
    stderr: encoder.encode("fixture-stderr"),
  });

const baselineRun = async (
  request: HeadlessExecutionRequest,
): Promise<HeadlessExecutionResult> => {
  const kind = await fixtureKind(request);
  const ledger = request.environment.AGENTSCOPE_ORACLE_LEDGER;
  if (ledger === undefined) throw new Error("seed.fixture.ledger");
  if (kind === "correct") return correctResult(request);
  if (kind === "stdout-limit")
    return result({
      outcome: "output-limit",
      stdout: new Uint8Array(request.stdoutLimitBytes).fill(79),
      stdoutTruncated: true,
      exitCode: null,
      termRequested: true,
      signal: "SIGTERM",
      diagnosticCode: "testkit.headless.output-limit",
    });
  if (kind === "stderr-limit")
    return result({
      outcome: "output-limit",
      stderr: new Uint8Array(request.stderrLimitBytes).fill(69),
      stderrTruncated: true,
      exitCode: null,
      termRequested: true,
      signal: "SIGTERM",
      diagnosticCode: "testkit.headless.output-limit",
    });
  if (kind === "timeout") {
    await writeFile(ledger, `started:${absentPid}\nterm\n`);
    return result({
      outcome: "timed-out",
      exitCode: null,
      signal: "SIGKILL",
      termRequested: true,
      killRequested: true,
      diagnosticCode: "testkit.headless.timeout",
    });
  }
  await writeFile(ledger, `descendant:${absentPid}\n`);
  return result({ termRequested: true, killRequested: true });
};

const adapter = (
  run: HeadlessSupervisorContractAdapter["run"] = baselineRun,
): HeadlessSupervisorContractAdapter => ({ run });

const contractCase = (
  implementation: HeadlessSupervisorContractAdapter,
  name: string,
) => {
  const selected = createBoundedHeadlessSupervisorContractSuite(
    implementation,
  ).find((candidate) => candidate.name === name);
  if (selected === undefined) throw new Error("seed.contract.case");
  return selected;
};

const mutateCorrect = (
  mutation: (
    value: HeadlessExecutionResult,
    request: HeadlessExecutionRequest,
  ) => unknown,
): HeadlessSupervisorContractAdapter =>
  adapter((request) =>
    Promise.resolve(mutation(correctResult(request), request)),
  );

describe("bounded headless supervisor contract", () => {
  it("owns a frozen bounded alpha-critical case inventory", async () => {
    const cases = createBoundedHeadlessSupervisorContractSuite(adapter());
    expect(Object.isFrozen(cases)).toBe(true);
    expect(cases.every((candidate) => Object.isFrozen(candidate))).toBe(true);
    expect(cases.map(({ name }) => name)).toEqual([
      "headless:correct-invocation",
      "headless:stdout-limit",
      "headless:stderr-limit",
      "headless:timeout-escalation",
      "headless:descendant-cleanup",
    ]);
    for (const candidate of cases) await candidate.run();
  });

  it.each([
    [
      "arguments",
      "testkit.headless.invocation.arguments",
      (value: HeadlessExecutionResult) => ({
        ...value,
        stdout: encoder.encode(
          JSON.stringify({
            arguments: [],
            cwd: "unused",
            environment: {},
            input: "unused",
          }),
        ),
      }),
    ],
    [
      "cwd",
      "testkit.headless.invocation.cwd",
      (value: HeadlessExecutionResult, request: HeadlessExecutionRequest) => ({
        ...value,
        stdout: encoder.encode(
          JSON.stringify({
            arguments: request.arguments.slice(1),
            cwd: "/wrong",
            environment: request.environment,
            input: decoder.decode(request.stdin),
          }),
        ),
      }),
    ],
    [
      "environment",
      "testkit.headless.invocation.environment",
      (value: HeadlessExecutionResult, request: HeadlessExecutionRequest) => ({
        ...value,
        stdout: encoder.encode(
          JSON.stringify({
            arguments: request.arguments.slice(1),
            cwd: request.cwd,
            environment: { AMBIENT_SECRET: "PRIVATE_CANARY" },
            input: decoder.decode(request.stdin),
          }),
        ),
      }),
    ],
  ] as const)(
    "rejects a supervisor that loses exact %s",
    async (_, code, seed) => {
      await expect(
        contractCase(mutateCorrect(seed), "headless:correct-invocation").run(),
      ).rejects.toThrow(code);
    },
  );
});

describe("bounded headless supervisor adversarial seeds", () => {
  it("rejects stdout and stderr ceiling violations", async () => {
    const overflow = adapter(async (request) => {
      const kind = await fixtureKind(request);
      const value = await baselineRun(request);
      if (kind === "stdout-limit")
        return {
          ...value,
          stdout: new Uint8Array(request.stdoutLimitBytes + 1),
        };
      return { ...value, stderr: new Uint8Array(request.stderrLimitBytes + 1) };
    });
    await expect(
      contractCase(overflow, "headless:stdout-limit").run(),
    ).rejects.toThrow("testkit.headless.stdout.bound");
    await expect(
      contractCase(overflow, "headless:stderr-limit").run(),
    ).rejects.toThrow("testkit.headless.stderr.bound");
  });

  it("rejects timeout misclassification and skipped TERM-to-KILL escalation", async () => {
    const misclassified = adapter(async (request) => {
      const value = await baselineRun(request);
      return {
        ...value,
        outcome: "exited",
        exitCode: 0,
        signal: null,
        diagnosticCode: null,
      };
    });
    await expect(
      contractCase(misclassified, "headless:timeout-escalation").run(),
    ).rejects.toThrow("testkit.headless.timeout.classification");

    const noEscalation = adapter(async (request) => {
      const value = await baselineRun(request);
      return { ...value, termRequested: false, killRequested: false };
    });
    await expect(
      contractCase(noEscalation, "headless:timeout-escalation").run(),
    ).rejects.toThrow("testkit.headless.timeout.escalation");
  });

  it("independently detects a seeded leak and awaits fixture expiry", async () => {
    const leaking = adapter(async (request) => {
      const ledger = request.environment.AGENTSCOPE_ORACLE_LEDGER;
      if (ledger === undefined) throw new Error("seed.fixture.ledger");
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),2000).unref();setInterval(()=>{},1000)",
        ],
        { detached: true, env: {}, stdio: "ignore" },
      );
      if (child.pid === undefined) throw new Error("seed.fixture.pid");
      await writeFile(ledger, `descendant:${child.pid}\n`);
      child.unref();
      return result({ termRequested: true, killRequested: true });
    });
    await expect(
      contractCase(leaking, "headless:descendant-cleanup").run(),
    ).rejects.toThrow("testkit.headless.descendant.cleanup");
  });

  it("rejects unsanitized diagnostic fields with a content-free code", async () => {
    const unsanitized = mutateCorrect((value) => ({
      ...value,
      diagnosticMessage: "PRIVATE_DIAGNOSTIC_CANARY",
    }));
    await expect(
      contractCase(unsanitized, "headless:correct-invocation").run(),
    ).rejects.toThrow("testkit.headless.result.shape");
  });
});
