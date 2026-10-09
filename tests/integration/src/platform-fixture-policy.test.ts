/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import {
  MODEL_PROTOCOL_ROUTES,
  type ModelProtocolRoute,
} from "../../../packages/testkit/src/model-routes.js";
import {
  mockServerTrafficRow,
  snapshotMockServerTraffic,
} from "../mockserver-control.mjs";

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
describe("actual generic catalog traffic publication", () => {
  it("publishes the execute milestone after all four selected model routes", async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../platform-fixture.mjs"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../capability-manifest.json"),
        "utf8",
      ),
    ) as { scenarios: { scenarioId: string; modelRoutes: string[] }[] };
    const selected = manifest.scenarios.find(
      (entry) => entry.scenarioId === scenarioId,
    )!;
    expect(selected.modelRoutes).toHaveLength(4);
    const routes: readonly ModelProtocolRoute[] = MODEL_PROTOCOL_ROUTES.filter(
      (route) => selected.modelRoutes.includes(route.routeId),
    );
    expect(routes).toHaveLength(4);
    const start = source.indexOf("const trafficEvidence =");
    const end = source.indexOf(
      '\nif (substrateCertificationCase === "false-success")',
      start,
    );
    const lifecycleStart = source.indexOf("const recordLifecycle =");
    const lifecycleEnd = source.indexOf(
      "\nconst requestJson =",
      lifecycleStart,
    );
    const modelStart = source.indexOf("const runModels = async () => {");
    const modelEnd = source.indexOf("\nconst representative =", modelStart);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(lifecycleEnd).toBeGreaterThan(lifecycleStart);
    expect(modelEnd).toBeGreaterThan(modelStart);
    const traffic: unknown[] = [],
      lines: string[] = [];
    const models = runInNewContext(
      `(async () => { ${source.slice(start, end)} ${source.slice(lifecycleStart, lifecycleEnd)} ${source.slice(modelStart, modelEnd)} const result = await runModels(); recordLifecycle("execute"); return result; })()`,
      {
        Buffer,
        URL,
        basename,
        scenarioId,
        artifactPath: "CLI.tgz",
        integrationRunId: "0123456789abcdef",
        observedLifecycle: ["install", "configure", "hook"],
        FIXTURE_LIFECYCLE_PHASES: [
          "install",
          "configure",
          "hook",
          "execute",
          "export",
          "retrieve",
          "uninstall",
        ],
        certificationReadiness: null,
        partial: {},
        interactive: false,
        console: { log: (line: string) => lines.push(line) },
        scenario: selected,
        routeFixture: { routes },
        modelEndpoint: "http://mockserver:1080",
        mockTraffic: traffic,
        bootNow: () => 0,
        bootDeadline: 100,
        snapshotMockServerTraffic,
        recordMockTraffic: (
          ...arguments_: Parameters<typeof mockServerTrafficRow>
        ) => traffic.push(mockServerTrafficRow(...arguments_)),
        requestJson: (
          input: string | URL,
          _options: unknown,
          expected: number,
        ) => ({
          status: expected,
          json: () =>
            Promise.resolve(
              routes.find((route) => route.path === new URL(input).pathname)
                ?.responseBody,
            ),
        }),
      },
    ) as Promise<unknown[]>;
    expect(await models).toHaveLength(5);
    expect(lines).toHaveLength(2);
    const published = JSON.parse(
      Buffer.from(
        lines[1]!.slice("AGENTSCOPE_FIXTURE_RESULT=".length),
        "base64url",
      ).toString("utf8"),
    ) as {
      resultStatus: string;
      lifecycle: string[];
      mockServerTraffic: { entries: { path: string }[] };
    };
    expect(published.resultStatus).toBe("partial");
    expect(published.lifecycle).toEqual([
      "install",
      "configure",
      "hook",
      "execute",
    ]);
    expect(
      published.mockServerTraffic.entries.map((row) => row.path),
    ).toContain("/v1beta/models/fixture-model:generateContent");
    expect(
      published.mockServerTraffic.entries.every(
        (row) => !row.path.includes("?"),
      ),
    ).toBe(true);
  });
});
describe("ordinary upstream observations remain provisional", () => {
  it("uses unauthenticated upstream readiness and observes exact sent bodies without privileged retrieval", async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../platform-fixture.mjs"),
      "utf8",
    );
    expect(source).toContain("await observeMockServerCandidateTraffic({");
    const controlSource = readFileSync(
      resolve(import.meta.dirname, "../mockserver-control.mjs"),
      "utf8",
    );
    expect(controlSource).toContain(
      'fetch("http://mockserver:1080/mockserver/ready",',
    );
    expect(controlSource).toContain("16 - 5 - 5 - modelRequestCount");
    expect(source).not.toContain("ACTIVEXPECTATIONS");
    expect(source).not.toContain("type=REQUESTS");
    const start = source.indexOf("const runModels = async () => {");
    const end = source.indexOf("\nconst representative =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const sent: { url: URL; method: string; body: string; expected: number }[] =
      [];
    const run = runInNewContext(`${source.slice(start, end)}; runModels`, {
      URL,
      scenario,
      routeFixture: {
        routes: routeFixture.routes.map((route) => ({
          ...route,
          responseBody: { ok: true },
        })),
      },
      modelEndpoint: "http://mockserver:1080",
      mockTraffic: [],
      bootNow: () => 0,
      bootDeadline: 100,
      recordMockTraffic: () => undefined,
      requestJson: (
        input: string | URL,
        options: { method?: string; body?: string } = {},
        expected: number,
      ) => {
        sent.push({
          url: new URL(input),
          method: options.method ?? "GET",
          body: options.body ?? "",
          expected,
        });
        return { status: expected, json: () => Promise.resolve({ ok: true }) };
      },
    }) as () => Promise<unknown[]>;
    const observed = await run();
    expect(observed).toEqual(
      sent.map(({ url, method, body }) => ({
        method,
        path: url.pathname,
        body,
      })),
    );
    expect(sent.map(({ expected }) => expected)).toEqual([200, 200, 404]);
    expect(observed).toEqual([
      {
        method: "POST",
        path: "/v1/responses",
        body: JSON.stringify(routeFixture.routes[0]!.requestBody),
      },
      {
        method: "POST",
        path: "/v1/messages",
        body: JSON.stringify(routeFixture.routes[1]!.requestBody),
      },
      { method: "GET", path: "/agentscope-unmatched", body: "" },
    ]);
  });
});
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
