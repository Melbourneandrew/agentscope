import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

it("operational projection strips only the prepared member without authenticating or mutating it", () => {
  const source = readFileSync(
    new URL("../verify-operations.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const operationalIsolationEvidence =");
  const end = source.indexOf("const wait =", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const project = runInNewContext(
    `${source.slice(start, end)}; operationalIsolationEvidence`,
    {
      compileIsolationEvidence: (value: Record<string, unknown>) => {
        if (Object.keys(value).some((key) => key !== "runId"))
          throw new Error("strict-isolation");
        return value;
      },
    },
  ) as (value: unknown) => unknown;
  const original = Object.freeze({
    runId: "owned",
    preparedHarnessMaterial: Object.freeze({ untrusted: true }),
  });
  expect(project(original)).toEqual({ runId: "owned" });
  expect(project({ runId: "owned" })).toEqual({ runId: "owned" });
  expect(original.preparedHarnessMaterial).toEqual({ untrusted: true });
  expect(() => project({ ...original, arbitraryExtra: true })).toThrow(
    "strict-isolation",
  );
});

import {
  compileLocalSelection,
  mapWithConcurrency,
  planArtifactRetention,
  readSelectedWriterOtlpBatch,
  sanitizeFixtureResult,
  type ArtifactDirectoryEntry,
} from "./operations.js";

describe("selected compact JSON writer privacy boundary", () => {
  const canaries = ["PRIVATE_CANARY"];
  const read = (text: string) =>
    readSelectedWriterOtlpBatch(Buffer.from(text), canaries);
  it("retains unknown values for accounting before any canonical projection", () => {
    expect(read('{"resourceSpans":[],"unknown":{"value":"ordinary"}}')).toEqual(
      {
        resourceSpans: [],
        unknown: { value: "ordinary" },
      },
    );
  });
  it.each([
    '{"resourceSpans":[],"unknown":"PRIVATE_CANARY"}',
    '{"resourceSpans":[],"unknown":"\\u0050RIVATE_CANARY"}',
    '{"resourceSpans":[],"\\u0050RIVATE_CANARY":false}',
    '{"unknown":"\\u0050RIVATE_CANARY","unknown":"ordinary"}',
    '{ "resourceSpans": [] }',
    '{"resourceSpans":[],"resourceSpans":[]}',
    '{"value":1e0}',
    "{malformed}",
  ])("refuses raw/escaped canaries or non-selected serialization", (text) => {
    expect(() => read(text)).toThrow("integration.operations.otlp-input");
  });
  it("refuses malformed UTF8, empty/oversized bodies and missing canaries", () => {
    for (const bytes of [
      Buffer.from([0xc0, 0xaf]),
      Buffer.alloc(0),
      Buffer.alloc(1024 * 1024 + 1),
    ]) {
      expect(() => readSelectedWriterOtlpBatch(bytes, canaries)).toThrow(
        "integration.operations.otlp-input",
      );
    }
    expect(() => readSelectedWriterOtlpBatch(Buffer.from("{}"), [])).toThrow(
      "integration.operations.otlp-input",
    );
  });
});

describe("outer collector create failure privacy", () => {
  it.each([
    "codex-tui-trace-smoke",
    "claude-interactive-trace-smoke",
    "fixture-process-smoke",
  ])(
    "collapses argv-bearing errors only for selected TLS collector %s",
    async (scenarioId) => {
      const source = readFileSync(
        new URL("../run-scenarios.mjs", import.meta.url),
        "utf8",
      );
      const start = source.indexOf("const startDestinationSidecar =");
      const end = source.indexOf("const startCollector =", start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const predicateStart = source.indexOf("const isNativeTraceScenario =");
      const predicateEnd = source.indexOf("const isGateCapableMockServer =");
      expect(predicateStart).toBeGreaterThan(0);
      expect(predicateEnd).toBeGreaterThan(predicateStart);
      const original = Object.assign(Error("PRIVATE_TEST_KEY"), {
        stdout: "PRIVATE_TEST_KEY",
        stderr: "PRIVATE_TEST_KEY",
      });
      const calls: string[][] = [];
      const run = runInNewContext(
        `${source.slice(predicateStart, predicateEnd)}\n${source.slice(start, end)}; startDestinationSidecar`,
        {
          collectorTlsCertificate: "PUBLIC_CERTIFICATE",
          collectorTlsKey: "PRIVATE_TEST_KEY",
          canonicalImagePlatform: "linux/amd64",
          labelArguments: () => [],
          sidecarResourceArguments: () => [],
          tmpfsArguments: () => [],
          ISOLATION_EXECUTOR_LIMITS: {
            containers: {},
            requests: { destinationServerMaximumBytes: 1024 * 1024 },
          },
          dockerWithSignal: (args: string[]) => {
            calls.push(args);
            return Promise.reject(original);
          },
        },
      ) as (plan: unknown, signal: unknown, mode: string) => Promise<void>;
      const result = await run(
        {
          scenarioId,
          collectorName: "selected",
          networkName: "network",
          imageTag: "image",
        },
        {},
        "ingestion",
      ).catch((error: unknown) => error);
      if (scenarioId !== "fixture-process-smoke") {
        expect(result).toMatchObject({
          message: "integration.isolation.collector-create",
        });
        expect(Object.getOwnPropertyNames(result)).not.toContain("cause");
        expect(Object.getOwnPropertyNames(result)).not.toContain("stdout");
        expect(Object.getOwnPropertyNames(result)).not.toContain("stderr");
        expect(calls[0]).toContain(
          "AGENTSCOPE_COLLECTOR_TLS_KEY=PRIVATE_TEST_KEY",
        );
      } else {
        expect(result).toBe(original);
        expect(calls[0]).not.toContain(
          "AGENTSCOPE_COLLECTOR_TLS_KEY=PRIVATE_TEST_KEY",
        );
      }
    },
  );
});

const fixtureResult = () => ({
  evidenceVersion: 1,
  resultStatus: "complete",
  scenarioId: "fixture-process-smoke",
  artifactFileName: "agentscope-cli.tgz",
  certificationReadiness: null,
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
    partial.lifecycle = ["install", "configure"];
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
    for (const lifecycle of [
      ["configure"],
      ["install", "hook"],
      [
        "install",
        "configure",
        "hook",
        "execute",
        "export",
        "retrieve",
        "uninstall",
      ],
    ]) {
      const invalidPartial = fixtureResult();
      invalidPartial.resultStatus = "partial";
      invalidPartial.lifecycle = lifecycle;
      expect(() =>
        sanitizeFixtureResult(invalidPartial, "fixture-process-smoke"),
      ).toThrow("integration.operations.fixture-result");
    }
  });

  it("accepts complete evidence with observed retrieval and no invented ingestion", () => {
    const result = fixtureResult();
    result.destinationLedger.ingestion = [];
    expect(sanitizeFixtureResult(result, "fixture-process-smoke")).toEqual(
      result,
    );
  });
});

describe("integration Codex retained evidence", () => {
  it("retains native-only evidence without inventing destination completion", () => {
    const native = {
      ...fixtureResult(),
      resultStatus: "partial",
      lifecycle: ["install", "configure", "hook", "execute"],
      eventKinds: ["hook", "model"],
      destinationLedger: {
        ledgerVersion: 1,
        scenarioId: "fixture-process-smoke",
        ingestion: [],
        retrieval: [],
      },
      harnessObservation: {
        observationVersion: 1,
        kind: "codex-tui-native",
        nativeSessionId: "actual-session",
        nativeTurnId: "actual-turn",
        nativeModelName: "fixture-model",
        modelRequestBodySha256: "a".repeat(64),
        doctorErrors: 0,
        uninstallDisposition: "committed",
        sessionStartCommandDurationMilliseconds: 125,
      },
    };
    expect(sanitizeFixtureResult(native, "fixture-process-smoke")).toEqual(
      native,
    );
    for (const changed of [
      { resultStatus: "complete" },
      { lifecycle: ["install", "configure", "hook", "execute", "ingest"] },
      { eventKinds: ["hook", "model", "ingestion"] },
      { destinationLedger: fixtureResult().destinationLedger },
      {
        harnessObservation: {
          ...native.harnessObservation,
          traceId: "b".repeat(32),
        },
      },
      {
        harnessObservation: { ...native.harnessObservation, nativeTurnId: "" },
      },
      {
        harnessObservation: {
          ...native.harnessObservation,
          parentLinked: true,
        },
      },
      {
        harnessObservation: {
          ...native.harnessObservation,
          canonicalGraph: {},
        },
      },
      {
        harnessObservation: {
          ...native.harnessObservation,
          canonicalGraphDigest: "a".repeat(64),
        },
      },
      {
        harnessObservation: {
          ...native.harnessObservation,
          spanIds: ["b".repeat(16), "c".repeat(16)],
        },
      },
      {
        harnessObservation: {
          ...native.harnessObservation,
          contextDisposition: "unversioned-workspace-redacted",
        },
      },
    ])
      expect(() =>
        sanitizeFixtureResult(
          { ...native, ...changed },
          "fixture-process-smoke",
        ),
      ).toThrow("integration.operations.fixture-result");
  });
});

describe("integration retained artifact planning", () => {
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
