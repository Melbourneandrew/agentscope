import { describe, expect, it } from "vitest";

import {
  compileLocalSelection,
  mapWithConcurrency,
  planArtifactRetention,
  sanitizeFixtureResult,
  type ArtifactDirectoryEntry,
} from "./operations.js";

const fixtureResult = () => ({
  evidenceVersion: 1,
  resultStatus: "complete",
  scenarioId: "fixture-process-smoke",
  artifactFileName: "agentscope-cli.tgz",
  lifecycle: [
    "install",
    "configure",
    "hook",
    "execute",
    "export",
    "retrieve",
    "uninstall",
  ],
  eventKinds: [
    "hook",
    "canonical",
    "redaction",
    "git",
    "model",
    "tool",
    "destination",
  ],
  modelLedger: {
    ledgerVersion: 1,
    scenarioId: "fixture-process-smoke",
    entries: [
      {
        routeId: "openai-responses",
        provider: "openai-responses",
        method: "POST",
        path: "/v1/responses",
        bodyBytes: 20,
      },
    ],
  },
  destinationLedger: {
    ledgerVersion: 1,
    scenarioId: "fixture-process-smoke",
    ingestion: [
      {
        operation: "otlp-ingest",
        method: "POST",
        path: "/v1/traces",
        bodyBytes: 40,
        outcome: "accepted",
      },
    ],
    retrieval: [
      {
        operation: "get",
        method: "GET",
        path: "/trace/0123456789abcdef0123456789abcdef",
        bodyBytes: 0,
        outcome: "accepted",
      },
    ],
  },
});

describe("integration retained artifacts", () => {
  it("reconstructs a frozen exact sanitized fixture result", () => {
    const input = fixtureResult();
    const result = sanitizeFixtureResult(input, "fixture-process-smoke");
    expect(result).toEqual(input);
    expect(Object.isFrozen(result.destinationLedger.ingestion[0])).toBe(true);
  });

  it("rejects scenario drift, extra data, and unbounded ledger values", () => {
    expect(() =>
      sanitizeFixtureResult(
        { ...fixtureResult(), scenarioId: "other-scenario" },
        "fixture-process-smoke",
      ),
    ).toThrow("integration.operations.fixture-result");
    expect(() =>
      sanitizeFixtureResult(
        { ...fixtureResult(), secret: "CANARY_SECRET" },
        "fixture-process-smoke",
      ),
    ).toThrow("integration.operations.fixture-result");
    const oversized = fixtureResult();
    oversized.modelLedger.entries[0]!.bodyBytes = 32 * 1024 * 1024;
    expect(() =>
      sanitizeFixtureResult(oversized, "fixture-process-smoke"),
    ).toThrow("integration.operations.fixture-result");
  });

  it("retains bounded partial ledgers without treating them as complete", () => {
    const partial = fixtureResult();
    partial.resultStatus = "partial";
    partial.eventKinds = [];
    partial.modelLedger.entries = [];
    partial.destinationLedger.ingestion = [];
    partial.destinationLedger.retrieval = [];
    expect(sanitizeFixtureResult(partial, "fixture-process-smoke")).toEqual(
      partial,
    );
    partial.resultStatus = "complete";
    expect(() =>
      sanitizeFixtureResult(partial, "fixture-process-smoke"),
    ).toThrow("integration.operations.fixture-result");
  });

  it("plans deterministic bounded retention while protecting current", () => {
    const bundle = (digit: string) => `sha256-${digit.repeat(64)}`;
    const entries: ArtifactDirectoryEntry[] = [
      ...["1", "2", "3", "4", "5"].map((digit, index) => ({
        collection: "candidates" as const,
        name: bundle(digit),
        modifiedMilliseconds: index,
        bytes: 10,
      })),
      ...Array.from({ length: 18 }, (_, index) => ({
        collection: "runs" as const,
        name: index.toString(16).padStart(16, "0"),
        modifiedMilliseconds: index,
        bytes: 5,
      })),
      {
        collection: "contexts" as const,
        name: "abcdef0123456789",
        modifiedMilliseconds: 20,
        bytes: 20,
      },
    ];
    const plan = planArtifactRetention(entries, bundle("1"));
    expect(plan.totalBytes).toBe(160);
    expect(
      plan.retain.filter(({ collection }) => collection === "runs"),
    ).toHaveLength(16);
    expect(plan.retain.map(({ name }) => name)).toContain(bundle("1"));
    expect(plan.remove.map(({ collection }) => collection)).toContain(
      "contexts",
    );
  });

  it("rejects hostile retention inventory", () => {
    expect(() =>
      planArtifactRetention([
        {
          collection: "runs",
          name: "../outside",
          modifiedMilliseconds: 1,
          bytes: 1,
        },
      ]),
    ).toThrow("integration.operations.artifacts");
  });
});

describe("integration bounded scheduling", () => {
  it("preserves input order while enforcing concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapWithConcurrency([3, 1, 2, 0], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 2;
    });
    expect(result).toEqual([6, 2, 4, 0]);
    expect(maximum).toBe(2);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects invalid concurrency", async () => {
    await expect(
      mapWithConcurrency([1], 0, (value) => Promise.resolve(value)),
    ).rejects.toThrow("integration.operations.concurrency");
  });

  it("observes all workers before returning an operation failure", async () => {
    const completed: number[] = [];
    await expect(
      mapWithConcurrency([1, 2], 2, async (value) => {
        await new Promise((resolve) => setTimeout(resolve, value));
        if (value === 1) throw new Error("fixed-failure");
        completed.push(value);
        return value;
      }),
    ).rejects.toThrow("fixed-failure");
    expect(completed).toEqual([2]);
  });
});

describe("integration local selectors", () => {
  it("compiles explicit scenario, shard, and full modes", () => {
    expect(
      compileLocalSelection({
        AGENTSCOPE_INTEGRATION_SCENARIO: "fixture-process-smoke",
      }),
    ).toEqual({
      mode: "scenario",
      selector: { scenarioId: "fixture-process-smoke" },
    });
    expect(
      compileLocalSelection({ AGENTSCOPE_INTEGRATION_SHARD: "0/1" }),
    ).toEqual({ mode: "shard", selector: { shard: { index: 0, total: 1 } } });
    expect(compileLocalSelection({ AGENTSCOPE_INTEGRATION_FULL: "1" })).toEqual(
      { mode: "full", selector: {} },
    );
  });

  it("rejects implicit, conflicting, and malformed modes", () => {
    for (const environment of [
      {},
      {
        AGENTSCOPE_INTEGRATION_FULL: "1",
        AGENTSCOPE_INTEGRATION_TAG: "smoke",
      },
      { AGENTSCOPE_INTEGRATION_FULL: "true" },
    ])
      expect(() => compileLocalSelection(environment)).toThrow(
        "integration.manifest.selector",
      );
    expect(() =>
      compileLocalSelection({ AGENTSCOPE_INTEGRATION_SHARD: "one/two" }),
    ).toThrow("integration.manifest.shard");
  });
});
