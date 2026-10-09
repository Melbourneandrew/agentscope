import { describe, expect, it } from "vitest";

import { sanitizeFixtureResult } from "./operations.js";

// This component fixture exercises retained shape only. Actual native facts,
// four graphs and request association are verified by the outer caller.
const native = () => ({
  observationVersion: 1,
  kind: "claude-code-native",
  nativeSessionId: "01234567-89ab-cdef-0123-456789abcdef",
  nativeToolUseId: "toolu_agentscope_claude_read_1",
  modelRequestBodySha256: ["a".repeat(64), "b".repeat(64)],
  doctorErrors: 0,
  uninstallDisposition: "committed",
});
const hooks = () =>
  ["SessionStart", "PreToolUse", "PostToolUse", "Stop"].map(
    (eventName, index) => ({
      eventName,
      traceId: String(index + 1).repeat(32),
      canonicalGraphDigest: String(index + 1).repeat(64),
      contextDisposition: "unversioned-workspace-redacted",
      spanIds:
        index === 0 ? ["a".repeat(16)] : ["a".repeat(16), "b".repeat(16)],
    }),
  );
const entry = () => ({
  operation: "otlp",
  method: "POST",
  path: "/api/public/otel/v1/traces",
  bodyBytes: 40,
  outcome: "accepted",
});
const fixture = (complete = false) => ({
  evidenceVersion: 1,
  resultStatus: complete ? "complete" : "partial",
  scenarioId: "claude-interactive-trace-smoke",
  artifactFileName: "agentscope-cli.tgz",
  certificationReadiness: null,
  lifecycle: complete
    ? [
        "install",
        "configure",
        "hook",
        "execute",
        "export",
        "retrieve",
        "uninstall",
      ]
    : ["install", "configure", "hook", "execute"],
  eventKinds: complete ? ["hook", "model", "destination"] : ["hook", "model"],
  harnessObservation: complete
    ? {
        ...native(),
        kind: "claude-code-trace",
        hookObservations: hooks(),
      }
    : native(),
  modelLedger: {
    ledgerVersion: 1,
    scenarioId: "claude-interactive-trace-smoke",
    entries: Array.from({ length: 2 }, () => ({
      routeId: "anthropic-messages",
      provider: "anthropic",
      method: "POST",
      path: "/v1/messages",
      bodyBytes: 20,
    })),
  },
  destinationLedger: {
    ledgerVersion: 1,
    scenarioId: "claude-interactive-trace-smoke",
    ingestion: complete ? Array.from({ length: 4 }, entry) : [],
    retrieval: [],
  },
});
const reject = (input: unknown) => {
  expect(() =>
    sanitizeFixtureResult(input, "claude-interactive-trace-smoke"),
  ).toThrow("integration.operations.fixture-result");
};

describe("Claude content-free retained observation", () => {
  it.each([false, true])(
    "retains frozen exact %s completion with optional actual model",
    (complete) => {
      const input = fixture(complete);
      const result = sanitizeFixtureResult(input, input.scenarioId);
      expect(result).toEqual(input);
      expect(Object.isFrozen(result.harnessObservation)).toBe(true);
      expect(result.harnessObservation).not.toHaveProperty("nativeModelName");
      expect(result.harnessObservation).not.toHaveProperty("canonicalGraph");
      const observedModel = {
        ...input,
        harnessObservation: {
          ...input.harnessObservation,
          nativeModelName: "fixture-model",
        },
      };
      expect(sanitizeFixtureResult(observedModel, input.scenarioId)).toEqual(
        observedModel,
      );
    },
  );
  it("rejects malformed native identity, fabricated fields and request tuples", () => {
    const input = fixture();
    for (const fields of [
      { nativeSessionId: "01234567-89AB-cdef-0123-456789abcdef" },
      { nativeSessionId: "not-a-uuid" },
      { nativeToolUseId: "different-tool" },
      { nativeToolUseId: undefined },
      { nativeModelName: "" },
      { nativeModelName: "a".repeat(257) },
      { modelRequestBodySha256: ["a".repeat(64)] },
      { modelRequestBodySha256: ["a".repeat(64), "B".repeat(64)] },
      {
        modelRequestBodySha256: [
          "a".repeat(64),
          "b".repeat(64),
          "c".repeat(64),
        ],
      },
      { privateNonce: "private" },
      { canonicalGraph: {} },
      { doctorErrors: 1 },
      { uninstallDisposition: "pending" },
    ])
      reject({
        ...input,
        harnessObservation: { ...input.harnessObservation, ...fields },
      });
  });
  it("partial evidence cannot acquire complete graph projection or destination claims", () => {
    const input = fixture();
    for (const changed of [
      { resultStatus: "complete" },
      { lifecycle: fixture(true).lifecycle },
      { eventKinds: ["hook", "model", "destination"] },
      { destinationLedger: fixture(true).destinationLedger },
      { modelLedger: { ...input.modelLedger, entries: [] } },
      {
        harnessObservation: {
          ...input.harnessObservation,
          hookObservations: hooks(),
        },
      },
      {
        harnessObservation: {
          ...input.harnessObservation,
          traceId: "a".repeat(32),
        },
      },
    ])
      reject({ ...input, ...changed });
  });
});

describe("Claude complete hook projection", () => {
  it("complete evidence requires exactly four ordered distinct hook observations", () => {
    const input = fixture(true);
    const rows = hooks();
    for (const changed of [
      [],
      rows.slice(0, 3),
      [...rows, rows[0]],
      [rows[1], rows[0], rows[2], rows[3]],
      rows.map((row) => ({ ...row, traceId: rows[0]!.traceId })),
      rows.map((row, index) =>
        index === 0
          ? { ...row, spanIds: ["a".repeat(16), "b".repeat(16)] }
          : row,
      ),
      rows.map((row, index) =>
        index === 1 ? { ...row, spanIds: ["a".repeat(16)] } : row,
      ),
      rows.map((row, index) =>
        index === 2
          ? { ...row, spanIds: ["a".repeat(16), "a".repeat(16)] }
          : row,
      ),
    ])
      reject({
        ...input,
        harnessObservation: {
          ...input.harnessObservation,
          hookObservations: changed,
        },
      });
    for (const fields of [
      { eventName: "SessionEnd" },
      { traceId: "A".repeat(32) },
      { canonicalGraphDigest: "a".repeat(63) },
      { contextDisposition: "available" },
      { canonicalGraph: {} },
      { timestamp: "private" },
      { privateNonce: "private" },
    ])
      reject({
        ...input,
        harnessObservation: {
          ...input.harnessObservation,
          hookObservations: [{ ...rows[0], ...fields }, ...rows.slice(1)],
        },
      });
    reject({
      ...input,
      harnessObservation: {
        ...input.harnessObservation,
        hookObservations: undefined,
      },
    });
    reject({
      ...input,
      harnessObservation: { ...input.harnessObservation, canonicalGraph: {} },
    });
  });
});

describe("Claude complete ledger projection", () => {
  it("complete projection preserves auxiliary model rows and requires four exact accepted POSTs", () => {
    const input = fixture(true);
    const auxiliary = {
      ...input,
      modelLedger: {
        ...input.modelLedger,
        entries: [
          ...input.modelLedger.entries,
          {
            routeId: "native-auxiliary",
            provider: "anthropic",
            method: "POST",
            path: "/v1/auxiliary",
            bodyBytes: 10,
          },
        ],
      },
    };
    expect(sanitizeFixtureResult(auxiliary, input.scenarioId)).toEqual(
      auxiliary,
    );
    for (const changed of [
      { resultStatus: "partial" },
      { lifecycle: fixture().lifecycle },
      { eventKinds: ["hook", "model"] },
      {
        modelLedger: {
          ...input.modelLedger,
          entries: input.modelLedger.entries.slice(0, 1),
        },
      },
      {
        modelLedger: {
          ...input.modelLedger,
          entries: input.modelLedger.entries.map((row) => ({
            ...row,
            provider: "foreign-provider",
          })),
        },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          ingestion: input.destinationLedger.ingestion.slice(0, 3),
        },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          ingestion: [...input.destinationLedger.ingestion, entry()],
        },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          ingestion: input.destinationLedger.ingestion.map((row) => ({
            ...row,
            method: "GET",
          })),
        },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          ingestion: input.destinationLedger.ingestion.map((row) => ({
            ...row,
            path: "/v1/traces",
          })),
        },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          ingestion: input.destinationLedger.ingestion.map((row) => ({
            ...row,
            operation: "other",
          })),
        },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          ingestion: input.destinationLedger.ingestion.map((row) => ({
            ...row,
            outcome: "failed",
          })),
        },
      },
      {
        destinationLedger: { ...input.destinationLedger, retrieval: [entry()] },
      },
      {
        destinationLedger: {
          ...input.destinationLedger,
          scenarioId: "foreign-scenario",
        },
      },
    ])
      reject({ ...input, ...changed });
  });
});
