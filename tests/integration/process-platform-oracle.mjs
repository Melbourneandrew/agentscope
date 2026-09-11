const requiredLifecycle = Object.freeze([
  "install",
  "configure",
  "hook",
  "execute",
  "export",
  "retrieve",
  "uninstall",
]);
const requiredEventKinds = Object.freeze([
  "hook",
  "canonical",
  "redaction",
  "git",
  "model",
  "tool",
  "destination",
]);

const representative = Object.freeze({
  traceId: "0123456789abcdef0123456789abcdef",
  branch: "main",
  model: "fixture-model",
  tool: "fixture_tool",
  redaction: "content-removed",
  events: requiredEventKinds,
});

export const PROCESS_FIXTURE_STIMULUS = Object.freeze({
  representative,
  eventKinds: requiredEventKinds,
});

const assert = (condition, code) => {
  if (!condition) throw new Error(`integration.fixture.oracle-${code}`);
};

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value, keys) =>
  isRecord(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const freeze = (value) => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

const snapshotDestinationLedger = (ledger, scenarioId) => {
  assert(
    exactKeys(ledger, ["ledgerVersion", "scenarioId", "entries"]) &&
      ledger.ledgerVersion === 1 &&
      ledger.scenarioId === scenarioId &&
      Array.isArray(ledger.entries) &&
      ledger.entries.length <= 256,
    "raw-destination-ledger",
  );
  return ledger.entries.map((entry) => {
    assert(
      exactKeys(entry, ["operation", "method", "path", "bodyBytes", "outcome"]),
      "raw-destination-entry",
    );
    return { ...entry };
  });
};

// The test family snapshots its own exact permitted projection before calling
// the checksum-bound scenario adapter. The adapter never receives this frozen
// authority, so replacement or omission cannot become oracle-satisfying data.
export const captureProcessFixtureRawProjection = (input) => {
  assert(
    exactKeys(input, [
      "scenarioId",
      "modelRequests",
      "ingestionLedger",
      "retrievalLedger",
      "destinationObservation",
    ]) &&
      typeof input.scenarioId === "string" &&
      Array.isArray(input.modelRequests) &&
      input.modelRequests.length > 0 &&
      input.modelRequests.length <= 256,
    "raw-observation",
  );
  const modelObservations = input.modelRequests.map((entry) => {
    assert(
      isRecord(entry) &&
        typeof entry.method === "string" &&
        typeof entry.path === "string",
      "raw-model-observation",
    );
    return { method: entry.method, path: entry.path };
  });
  const destinationObservation = input.destinationObservation;
  assert(
    exactKeys(destinationObservation, [
      "observationVersion",
      "scenarioId",
      "eventKindSets",
    ]) &&
      destinationObservation.observationVersion === 1 &&
      destinationObservation.scenarioId === input.scenarioId &&
      Array.isArray(destinationObservation.eventKindSets) &&
      destinationObservation.eventKindSets.length <= 256,
    "raw-event-observation",
  );
  const eventKindSets = destinationObservation.eventKindSets.map(
    (eventKinds) => {
      assert(
        Array.isArray(eventKinds) &&
          eventKinds.length <= 32 &&
          eventKinds.every((eventKind) => typeof eventKind === "string"),
        "raw-event-observation",
      );
      return [...eventKinds];
    },
  );
  return freeze({
    modelObservations,
    destinationLedger: {
      ledgerVersion: 1,
      scenarioId: input.scenarioId,
      ingestion: snapshotDestinationLedger(
        input.ingestionLedger,
        input.scenarioId,
      ),
      retrieval: snapshotDestinationLedger(
        input.retrievalLedger,
        input.scenarioId,
      ),
    },
    eventKindSets,
  });
};

const expectedModelEntries = (routeFixture, scenario) => [
  ...scenario.modelRoutes.map((routeId) => {
    const matches = routeFixture.routes.filter(
      (candidate) => candidate.routeId === routeId,
    );
    if (
      matches.length !== 1 ||
      typeof matches[0].provider !== "string" ||
      typeof matches[0].method !== "string" ||
      typeof matches[0].path !== "string"
    )
      throw new Error("integration.fixture.oracle-authority");
    return {
      routeId,
      provider: matches[0].provider,
      method: matches[0].method,
      path: matches[0].path,
      bodyBytes: Buffer.byteLength(JSON.stringify(matches[0].requestBody)),
    };
  }),
  {
    routeId: "unmatched",
    provider: "none",
    method: "GET",
    path: "/agentscope-unmatched",
    bodyBytes: 0,
  },
];

const destinationBodyBytes = Buffer.byteLength(
  JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: [representative] }] }],
  }),
);
const expectedIngestion = Object.freeze([
  ["otlp-ingest", "POST", "/v1/traces", destinationBodyBytes, "accepted"],
  [
    "langfuse-ingest",
    "POST",
    "/api/public/ingestion",
    destinationBodyBytes,
    "accepted",
  ],
  ["otlp-ingest", "POST", "/v1/traces", destinationBodyBytes, "auth-rejected"],
  ["otlp-ingest", "POST", "/v1/traces", destinationBodyBytes, "rate-limited"],
  ["otlp-ingest", "POST", "/v1/traces", destinationBodyBytes, "unavailable"],
  [
    "otlp-ingest",
    "POST",
    "/v1/traces",
    destinationBodyBytes,
    "malformed-response",
  ],
  ["otlp-ingest", "POST", "/v1/traces", 1024 * 1024 + 1, "request-too-large"],
]);

const expectedRetrieval = Object.freeze([
  [
    "seed",
    "POST",
    "/seed",
    Buffer.byteLength(JSON.stringify(representative)),
    "accepted",
  ],
  [
    "search",
    "POST",
    "/search",
    Buffer.byteLength(JSON.stringify({ branch: "main" })),
    "accepted",
  ],
  ["get", "GET", `/trace/${representative.traceId}`, 0, "accepted"],
  ["search", "POST", "/search", 2, "unavailable"],
]);

const destinationProjection = (entries) =>
  entries.map(({ operation, method, path, bodyBytes, outcome }) => [
    operation,
    method,
    path,
    bodyBytes,
    outcome,
  ]);

const assertAuthority = (routeFixture, scenario) => {
  if (
    !Array.isArray(routeFixture?.routes) ||
    !Array.isArray(scenario?.modelRoutes) ||
    typeof scenario?.scenarioId !== "string"
  )
    throw new Error("integration.fixture.oracle-authority");
};

export const correlateProcessFixtureObservations = (
  observations,
  { rawProjection, routeFixture, scenario },
) => {
  assertAuthority(routeFixture, scenario);
  assert(
    Object.isFrozen(rawProjection) &&
      JSON.stringify(observations) === JSON.stringify(rawProjection),
    "adapter-fidelity",
  );
  const modelEntries = expectedModelEntries(routeFixture, scenario);
  assert(
    JSON.stringify(observations?.modelObservations) ===
      JSON.stringify(
        modelEntries.map(({ method, path }) => ({ method, path })),
      ),
    "model-observation",
  );
  assert(
    JSON.stringify(
      destinationProjection(observations?.destinationLedger?.ingestion ?? []),
    ) === JSON.stringify(expectedIngestion),
    "destination-ingestion",
  );
  assert(
    JSON.stringify(
      destinationProjection(observations?.destinationLedger?.retrieval ?? []),
    ) === JSON.stringify(expectedRetrieval),
    "destination-retrieval",
  );
  assert(
    JSON.stringify(observations?.eventKindSets) ===
      JSON.stringify([requiredEventKinds, requiredEventKinds]),
    "events",
  );
  const correlatedModelEntries = modelEntries.map((entry, index) =>
    Object.freeze({
      ...entry,
      method: rawProjection.modelObservations[index].method,
      path: rawProjection.modelObservations[index].path,
    }),
  );
  return Object.freeze({
    eventKinds: Object.freeze([...rawProjection.eventKindSets[0]]),
    modelLedger: Object.freeze({
      ledgerVersion: 1,
      scenarioId: scenario.scenarioId,
      entries: Object.freeze(correlatedModelEntries),
    }),
    destinationLedger: rawProjection.destinationLedger,
  });
};

export const assertProcessFixtureEvidence = (
  evidence,
  { routeFixture, scenario },
) => {
  assertAuthority(routeFixture, scenario);
  const modelEntries = expectedModelEntries(routeFixture, scenario);
  assert(evidence?.evidenceVersion === 1, "evidence-version");
  assert(evidence?.resultStatus === "complete", "result-status");
  assert(evidence?.scenarioId === scenario.scenarioId, "scenario");
  assert(
    JSON.stringify(evidence?.lifecycle) === JSON.stringify(requiredLifecycle),
    "lifecycle",
  );
  assert(
    JSON.stringify(evidence?.eventKinds) === JSON.stringify(requiredEventKinds),
    "events",
  );
  assert(evidence?.modelLedger?.ledgerVersion === 1, "model-version");
  assert(
    evidence?.modelLedger?.scenarioId === scenario.scenarioId,
    "model-scenario",
  );
  assert(
    JSON.stringify(evidence?.modelLedger?.entries) ===
      JSON.stringify(modelEntries),
    "model-observation",
  );
  assert(
    evidence?.destinationLedger?.ledgerVersion === 1,
    "destination-version",
  );
  assert(
    evidence?.destinationLedger?.scenarioId === scenario.scenarioId,
    "destination-scenario",
  );
  assert(
    JSON.stringify(
      destinationProjection(evidence?.destinationLedger?.ingestion ?? []),
    ) === JSON.stringify(expectedIngestion),
    "destination-ingestion",
  );
  assert(
    JSON.stringify(
      destinationProjection(evidence?.destinationLedger?.retrieval ?? []),
    ) === JSON.stringify(expectedRetrieval),
    "destination-retrieval",
  );
};
