/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";

// These are deliberately private integration modules, not package APIs.
// @ts-expect-error no declaration file is published for this private module
import { translatePlatformObservations } from "../fixtures/process-platform-adapter.mjs";
// @ts-expect-error no declaration file is published for this private module
import * as processFixtureOracle from "../process-platform-oracle.mjs";
import { sanitizeFixtureResult } from "./operations.js";

const {
  assertProcessFixtureEvidence,
  captureProcessFixtureRawProjection,
  correlateProcessFixtureObservations,
  PROCESS_FIXTURE_STIMULUS,
} = processFixtureOracle;

const scenarioId = "fixture-process-smoke";
const routeFixture = {
  routes: [
    {
      routeId: "openai-responses",
      provider: "openai-responses",
      method: "POST",
      path: "/v1/responses",
      requestBody: { input: "fixture" },
    },
    {
      routeId: "anthropic-messages",
      provider: "anthropic-messages",
      method: "POST",
      path: "/v1/messages",
      requestBody: { messages: [] },
    },
  ],
};
const scenario = {
  scenarioId,
  modelRoutes: ["openai-responses", "anthropic-messages"],
};
const destinationBodyBytes = Buffer.byteLength(
  JSON.stringify({
    resourceSpans: [
      { scopeSpans: [{ spans: [PROCESS_FIXTURE_STIMULUS.representative] }] },
    ],
  }),
);
const ingestionEntries = [
  ["otlp-ingest", "POST", "/v1/traces", "accepted"],
  ["langfuse-ingest", "POST", "/api/public/ingestion", "accepted"],
  ["otlp-ingest", "POST", "/v1/traces", "auth-rejected"],
  ["otlp-ingest", "POST", "/v1/traces", "rate-limited"],
  ["otlp-ingest", "POST", "/v1/traces", "unavailable"],
  ["otlp-ingest", "POST", "/v1/traces", "malformed-response"],
  ["otlp-ingest", "POST", "/v1/traces", "request-too-large"],
].map(([operation, method, path, outcome]) => ({
  operation,
  method,
  path,
  bodyBytes:
    outcome === "request-too-large" ? 1024 * 1024 + 1 : destinationBodyBytes,
  outcome,
}));
const retrievalEntries = [
  {
    operation: "seed",
    method: "POST",
    path: "/seed",
    bodyBytes: Buffer.byteLength(
      JSON.stringify(PROCESS_FIXTURE_STIMULUS.representative),
    ),
    outcome: "accepted",
  },
  {
    operation: "search",
    method: "POST",
    path: "/search",
    bodyBytes: Buffer.byteLength(JSON.stringify({ branch: "main" })),
    outcome: "accepted",
  },
  {
    operation: "get",
    method: "GET",
    path: `/trace/${PROCESS_FIXTURE_STIMULUS.representative.traceId}`,
    bodyBytes: 0,
    outcome: "accepted",
  },
  {
    operation: "search",
    method: "POST",
    path: "/search",
    bodyBytes: 2,
    outcome: "unavailable",
  },
];

const input = () => ({
  scenarioId,
  modelRequests: [
    { method: "POST", path: "/v1/responses", ignoredNativeField: true },
    { method: "POST", path: "/v1/messages" },
    { method: "GET", path: "/agentscope-unmatched" },
  ],
  ingestionLedger: {
    ledgerVersion: 1,
    scenarioId,
    entries: ingestionEntries,
  },
  retrievalLedger: {
    ledgerVersion: 1,
    scenarioId,
    entries: retrievalEntries,
  },
  destinationObservation: {
    observationVersion: 1,
    scenarioId,
    eventKindSets: [
      PROCESS_FIXTURE_STIMULUS.eventKinds,
      PROCESS_FIXTURE_STIMULUS.eventKinds,
    ],
  },
});

const translate = () => translatePlatformObservations(input());
const correlated = () => {
  const raw = input();
  const rawProjection = captureProcessFixtureRawProjection(raw);
  return correlateProcessFixtureObservations(
    translatePlatformObservations(raw),
    {
      rawProjection,
      routeFixture,
      scenario,
    },
  );
};
const evidence = () => ({
  evidenceVersion: 1,
  resultStatus: "complete",
  scenarioId,
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
  ...correlated(),
});

describe("process fixture oracle separation", () => {
  it("translates data only, correlates in the test family, and crosses the retained evidence boundary", () => {
    const translated = translate();
    expect(Object.isFrozen(translated)).toBe(true);
    expect(Object.keys(translated).sort()).toEqual([
      "destinationLedger",
      "eventKindSets",
      "modelObservations",
    ]);
    expect(JSON.stringify(translated)).not.toContain("assertion");
    const result = evidence();
    expect(() =>
      assertProcessFixtureEvidence(result, { routeFixture, scenario }),
    ).not.toThrow();
    expect(sanitizeFixtureResult(result, scenarioId)).toEqual(result);
  });

  it("rejects expected values, callbacks, cross-run ledgers, and malformed entries", () => {
    const base = input();
    for (const changed of [
      { ...base, assertions: [] },
      { ...base, expected: {} },
      {
        ...base,
        ingestionLedger: { ...base.ingestionLedger, scenarioId: "other" },
      },
      { ...base, modelRequests: [{ method: "DELETE", path: "/x" }] },
      {
        ...base,
        destinationObservation: {
          ...base.destinationObservation,
          scenarioId: "other",
        },
      },
      {
        ...base,
        retrievalLedger: {
          ...base.retrievalLedger,
          entries: [
            {
              operation: "get",
              method: "GET",
              path: "/x",
              bodyBytes: 0,
              outcome: "accepted",
              expected: true,
            },
          ],
        },
      },
    ])
      expect(() => translatePlatformObservations(changed)).toThrow(
        /integration\.fixture\.adapter-/u,
      );
  });
});

describe("process fixture evidence correlation", () => {
  it("rejects missing, duplicate, reordered, extra, cross-run, and contradictory observations", () => {
    const raw = input();
    const rawProjection = captureProcessFixtureRawProjection(raw);
    const base = translatePlatformObservations(raw);
    const changes = [
      { ...base, modelObservations: [] },
      {
        ...base,
        modelObservations: [
          base.modelObservations[0],
          ...base.modelObservations,
        ],
      },
      {
        ...base,
        modelObservations: [...base.modelObservations].reverse(),
      },
      {
        ...base,
        destinationLedger: {
          ...base.destinationLedger,
          ingestion: [
            ...base.destinationLedger.ingestion,
            base.destinationLedger.ingestion[0],
          ],
        },
      },
      {
        ...base,
        destinationLedger: {
          ...base.destinationLedger,
          ingestion: base.destinationLedger.ingestion.slice(0, -1),
        },
      },
      {
        ...base,
        destinationLedger: {
          ...base.destinationLedger,
          retrieval: base.destinationLedger.retrieval.map(
            (entry: Record<string, unknown>, index: number) =>
              index === 0 ? { ...entry, outcome: "not-found" } : entry,
          ),
        },
      },
      {
        ...base,
        destinationLedger: {
          ...base.destinationLedger,
          ingestion: base.destinationLedger.ingestion.map(
            (entry: Record<string, unknown>, index: number) =>
              index === 0 ? { ...entry, bodyBytes: 0 } : entry,
          ),
        },
      },
      {
        ...base,
        eventKindSets: [PROCESS_FIXTURE_STIMULUS.eventKinds],
      },
    ];
    for (const changed of changes)
      expect(() =>
        correlateProcessFixtureObservations(changed, {
          rawProjection,
          routeFixture,
          scenario,
        }),
      ).toThrow(/integration\.fixture\.oracle-/u);

    const crossRun = evidence();
    crossRun.scenarioId = "cross-run";
    expect(() =>
      assertProcessFixtureEvidence(crossRun, { routeFixture, scenario }),
    ).toThrow(/integration\.fixture\.oracle-/u);
  });

  it("rejects a nonconforming adapter that replaces contradictory native records", () => {
    const raw = input();
    raw.modelRequests[0] = {
      method: "POST",
      path: "/contradictory-native-path",
    };
    const rawProjection = captureProcessFixtureRawProjection(raw);
    const forged = translate();
    expect(() =>
      correlateProcessFixtureObservations(forged, {
        rawProjection,
        routeFixture,
        scenario,
      }),
    ).toThrow("integration.fixture.oracle-adapter-fidelity");
  });
});
