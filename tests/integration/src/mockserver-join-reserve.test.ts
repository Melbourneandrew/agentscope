import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const load = (cleanupStart: number, preparationMilliseconds = 0) => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../run-scenarios.mjs"),
    "utf8",
  );
  const candidateStart = source.indexOf("const runScenario = async");
  const candidateEnd = source.indexOf("  let stdout;", candidateStart);
  const joinStart = source.indexOf("const joinMockServer = async");
  const joinEnd = source.indexOf("  const authority =", joinStart);
  expect(candidateStart).toBeGreaterThan(0);
  expect(candidateEnd).toBeGreaterThan(candidateStart);
  expect(joinStart).toBeGreaterThan(0);
  expect(joinEnd).toBeGreaterThan(joinStart);
  const deadlines = new Map<string, number>();
  const candidateCutoffs: number[] = [];
  const waits: number[] = [];
  const volumeChecks: unknown[] = [];
  let now = 1_000;
  const functions = runInNewContext(
    `${source.slice(candidateStart, candidateEnd)}};
     ${source.slice(joinStart, joinEnd)}};
     ({ runScenario, joinMockServer });`,
    {
      performance: { now: () => now },
      linuxBootMonotonicMilliseconds: () => now + 100_000,
      capability: {
        binding: { cleanupStartMonotonicMilliseconds: cleanupStart },
      },
      mockServerJoinDeadlines: deadlines,
      mockServerContainerIdentities: new Map([["run", "a".repeat(64)]]),
      createImmutableCandidateHandoff: () => {
        now += preparationMilliseconds;
        return Promise.resolve({});
      },
      createScenarioContainer: (
        _plan: unknown,
        _signal: unknown,
        cutoff: number,
      ) => {
        candidateCutoffs.push(cutoff);
        return Promise.resolve();
      },
      assertControlVolumeCurrent: (_plan: unknown, signal: unknown) => {
        volumeChecks.push(signal);
        return Promise.resolve();
      },
      AbortSignal: {
        timeout: (milliseconds: number) => {
          waits.push(milliseconds);
          return { milliseconds };
        },
        any: (signals: unknown[]) => signals,
      },
    },
  ) as {
    runScenario: (
      plan: unknown,
      signal: unknown,
      deadline: number,
    ) => Promise<void>;
    joinMockServer: (plan: unknown, signal: unknown) => Promise<void>;
  };
  return {
    functions,
    deadlines,
    candidateCutoffs,
    waits,
    volumeChecks,
    advanceTo: (value: number) => {
      now = value;
    },
  };
};

describe("MockServer join uses the original final reserve", () => {
  const plan = { runId: "run" };
  const signal = {};
  it("allows join at the legal candidate cutoff without renewing authority", async () => {
    const value = load(100_000, 5_000);
    await value.functions.runScenario(plan, signal, 61_000);
    expect(value.candidateCutoffs).toEqual([151_000]);
    expect(value.deadlines.get("run")).toBe(161_000);
    value.advanceTo(51_000);
    await value.functions.joinMockServer(plan, signal);
    expect(value.waits).toEqual([10_000]);
    expect(value.volumeChecks).toEqual([[signal, { milliseconds: 10_000 }]]);
    value.advanceTo(61_000);
    await expect(value.functions.joinMockServer(plan, signal)).rejects.toThrow(
      "integration.isolation.mockserver-terminal",
    );
    expect(value.deadlines.get("run")).toBe(161_000);
    expect(value.volumeChecks).toHaveLength(1);
  });
  it("caps candidate and join at the unchanged global cleanup boundary", async () => {
    const value = load(41_000);
    await value.functions.runScenario(plan, signal, 91_000);
    expect(value.candidateCutoffs).toEqual([131_000]);
    expect(value.deadlines.get("run")).toBe(141_000);
    value.advanceTo(40_999);
    await value.functions.joinMockServer(plan, signal);
    expect(value.waits).toEqual([1]);
    value.advanceTo(41_000);
    await expect(value.functions.joinMockServer(plan, signal)).rejects.toThrow(
      "integration.isolation.mockserver-terminal",
    );
    expect(value.deadlines.get("run")).toBe(141_000);
  });
  it("does not manufacture authority when the original budget is too short", async () => {
    const value = load(40_999);
    await expect(
      value.functions.runScenario(plan, signal, 91_000),
    ).rejects.toThrow("integration.isolation.headless-authority");
    expect(value.deadlines.size).toBe(0);
    expect(value.candidateCutoffs).toEqual([]);
    expect(value.volumeChecks).toEqual([]);
  });
});
