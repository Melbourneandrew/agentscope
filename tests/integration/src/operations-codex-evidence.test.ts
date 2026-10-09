import { describe, expect, it } from "vitest";

import { sanitizeFixtureResult } from "./operations.js";

// Component-only projection fixture, not native execution or graph verification.
// The outer oracle verifies the actual ephemeral graph before this boundary.
const complete = () => {
  return {
    evidenceVersion: 1,
    resultStatus: "complete",
    scenarioId: "codex-tui-trace-smoke",
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
    eventKinds: ["hook", "model", "destination"],
    modelLedger: {
      ledgerVersion: 1,
      scenarioId: "codex-tui-trace-smoke",
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
      scenarioId: "codex-tui-trace-smoke",
      ingestion: [
        {
          operation: "otlp-ingest",
          method: "POST",
          path: "/v1/traces",
          bodyBytes: 40,
          outcome: "accepted",
        },
      ],
      retrieval: [],
    },
    harnessObservation: {
      observationVersion: 1,
      kind: "codex-tui-trace",
      modelRequestBodySha256: "a".repeat(64),
      traceId: "b".repeat(32),
      spanIds: ["c".repeat(16), "d".repeat(16)],
      canonicalGraphDigest: "e".repeat(64),
      contextDisposition: "unversioned-workspace-redacted",
      nativeSessionId: "component-session",
      nativeTurnId: "component-turn",
      nativeModelName: "component-model",
      resourceSpanCount: 1,
      spanNames: ["codex.turn", "codex.response"],
      parentLinked: true,
      doctorErrors: 0,
      uninstallDisposition: "committed",
      sessionStartCommandDurationMilliseconds: 125,
    },
  };
};

describe("complete Codex content-free projection", () => {
  it("retains only the closed bounded projection in the same result envelope", () => {
    const input = complete();
    const result = sanitizeFixtureResult(input, input.scenarioId);
    expect(result).toEqual(input);
    expect(Object.isFrozen(result.harnessObservation)).toBe(true);
    expect(result.harnessObservation).not.toHaveProperty("canonicalGraph");
    expect(result.harnessObservation).toHaveProperty("spanIds", [
      "c".repeat(16),
      "d".repeat(16),
    ]);
    expect(JSON.stringify(result)).not.toContain("agentscope.mapping");
  });
  it.each([
    "digest-missing",
    "digest-malformed",
    "ids-missing",
    "ids-short",
    "ids-extra",
    "ids-duplicate",
    "id-malformed",
    "context",
    "trace",
    "count",
    "name",
    "parent",
    "partial",
    "trace-partial",
  ])("refuses %s complete-observation projection", (field) => {
    const input = complete();
    const observation = input.harnessObservation;
    if (field === "digest-missing")
      Reflect.deleteProperty(observation, "canonicalGraphDigest");
    if (field === "digest-malformed")
      observation.canonicalGraphDigest = "E".repeat(64);
    if (field === "ids-missing") Reflect.deleteProperty(observation, "spanIds");
    if (field === "ids-short") observation.spanIds.pop();
    if (field === "ids-extra") observation.spanIds.push("f".repeat(16));
    if (field === "ids-duplicate")
      observation.spanIds[1] = observation.spanIds[0]!;
    if (field === "id-malformed") observation.spanIds[0] = "C".repeat(16);
    if (field === "context") observation.contextDisposition = "available";
    if (field === "trace") observation.traceId = "b".repeat(31);
    if (field === "count") observation.resourceSpanCount = 2;
    if (field === "name") observation.spanNames[1] = "other";
    if (field === "parent") observation.parentLinked = false;
    if (field === "partial") {
      observation.kind = "codex-tui-native";
      input.resultStatus = "partial";
      input.lifecycle = ["install", "configure", "hook", "execute"];
    }
    if (field === "trace-partial") {
      input.resultStatus = "partial";
      input.lifecycle = ["install", "configure", "hook", "execute"];
    }
    expect(() => sanitizeFixtureResult(input, input.scenarioId)).toThrow(
      "integration.operations.fixture-result",
    );
  });
  it.each(["canonicalGraph", "attributes", "timestamps", "context", "body"])(
    "refuses retained %s payload rather than silently dropping it",
    (field) => {
      const input = complete();
      Object.assign(input.harnessObservation, {
        [field]: { content: "PRIVATE_CANARY" },
      });
      expect(() => sanitizeFixtureResult(input, input.scenarioId)).toThrow(
        "integration.operations.fixture-result",
      );
    },
  );
});

describe("retained independent native facts", () => {
  it.each([
    "session-missing",
    "turn-missing",
    "model-missing",
    "session-empty",
    "turn-oversize",
    "model-oversize",
  ])("refuses %s in completed evidence", (field) => {
    const input = complete();
    const observed = input.harnessObservation;
    if (field === "session-missing")
      Reflect.deleteProperty(observed, "nativeSessionId");
    if (field === "turn-missing")
      Reflect.deleteProperty(observed, "nativeTurnId");
    if (field === "model-missing")
      Reflect.deleteProperty(observed, "nativeModelName");
    if (field === "session-empty") observed.nativeSessionId = "";
    if (field === "turn-oversize") observed.nativeTurnId = "t".repeat(257);
    if (field === "model-oversize") observed.nativeModelName = "m".repeat(257);
    expect(() => sanitizeFixtureResult(input, input.scenarioId)).toThrow(
      "integration.operations.fixture-result",
    );
  });
});

describe("retained Codex command duration", () => {
  it("retains the bounded Codex session-start command duration", () => {
    const codex = complete();
    expect(sanitizeFixtureResult(codex, codex.scenarioId)).toEqual(codex);
    for (const duration of [null, 1_001, 60_001]) {
      const observed = {
        ...codex,
        harnessObservation: {
          ...codex.harnessObservation,
          sessionStartCommandDurationMilliseconds: duration,
        },
      };
      expect(sanitizeFixtureResult(observed, codex.scenarioId)).toEqual(
        observed,
      );
    }
    for (const duration of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        sanitizeFixtureResult(
          {
            ...codex,
            harnessObservation: {
              ...codex.harnessObservation,
              sessionStartCommandDurationMilliseconds: duration,
            },
          },
          codex.scenarioId,
        ),
      ).toThrow("integration.operations.fixture-result");
    }
  });
});
