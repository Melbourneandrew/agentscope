const representativeEventKinds = [
  "hook",
  "canonical",
  "redaction",
  "git",
  "model",
  "tool",
  "destination",
];

const runModels = async ({
  modelEndpoint,
  requestJson,
  routeFixture,
  scenario,
  scenarioId,
}) => {
  const entries = [];
  for (const routeId of scenario.modelRoutes) {
    const route = routeFixture.routes.find(
      (candidate) => candidate.routeId === routeId,
    );
    if (!route) throw new Error("integration.fixture.model-route");
    const url = new URL(route.path, modelEndpoint);
    for (const [name, value] of Object.entries(route.query ?? {}))
      url.searchParams.set(name, value);
    const body = JSON.stringify(route.requestBody);
    const response = await requestJson(
      url,
      { method: route.method, headers: route.headers, body },
      200,
    );
    if (
      JSON.stringify(await response.json()) !==
      JSON.stringify(route.responseBody)
    )
      throw new Error("integration.fixture.model-response");
    entries.push({
      routeId,
      provider: route.provider,
      method: route.method,
      path: route.path,
      bodyBytes: Buffer.byteLength(body),
    });
  }
  const unmatchedPath = "/agentscope-unmatched";
  await requestJson(`${modelEndpoint}${unmatchedPath}`, {}, 404);
  entries.push({
    routeId: "unmatched",
    provider: "none",
    method: "GET",
    path: unmatchedPath,
    bodyBytes: 0,
  });
  const recorded = await requestJson(
    `${modelEndpoint}/mockserver/retrieve?type=REQUESTS`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    200,
  );
  const requests = await recorded.json();
  if (
    JSON.stringify(requests.map(({ method, path }) => ({ method, path }))) !==
    JSON.stringify(entries.map(({ method, path }) => ({ method, path })))
  )
    throw new Error("integration.fixture.model-recording");
  return { ledgerVersion: 1, scenarioId, entries };
};

const runDestinations = async ({
  ingestionEndpoint,
  requestJson,
  retrievalEndpoint,
  scenarioId,
}) => {
  const traceId = "0123456789abcdef0123456789abcdef";
  const representative = {
    traceId,
    branch: "main",
    model: "fixture-model",
    tool: "fixture_tool",
    redaction: "content-removed",
    events: representativeEventKinds,
  };
  const body = JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: [representative] }] }],
  });
  const authHeaders = {
    authorization: "Bearer DUMMY_DESTINATION_KEY",
    "content-type": "application/json",
  };
  for (const path of ["/v1/traces", "/api/public/ingestion"])
    await requestJson(
      `${ingestionEndpoint}${path}`,
      { method: "POST", headers: authHeaders, body },
      202,
    );
  for (const [fault, expectedStatus] of [
    [undefined, 401],
    ["rate", 429],
    ["unavailable", 503],
    ["malformed", 200],
  ]) {
    const headers =
      fault === undefined
        ? { "content-type": "application/json" }
        : { ...authHeaders, "x-agentscope-fault": fault };
    const response = await requestJson(
      `${ingestionEndpoint}/v1/traces`,
      { method: "POST", headers, body },
      expectedStatus,
    );
    if (fault === "malformed") {
      try {
        await response.json();
        throw new Error("integration.fixture.malformed");
      } catch (error) {
        if (error?.message === "integration.fixture.malformed") throw error;
      }
    }
  }
  await requestJson(
    `${ingestionEndpoint}/v1/traces`,
    {
      method: "POST",
      headers: authHeaders,
      body: "x".repeat(1024 * 1024 + 1),
    },
    413,
  );
  await requestJson(
    `${retrievalEndpoint}/seed`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(representative),
    },
    201,
  );
  const search = await requestJson(
    `${retrievalEndpoint}/search`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ branch: "main" }),
    },
    200,
  );
  if ((await search.json()).traces?.[0]?.traceId !== traceId)
    throw new Error("integration.fixture.search");
  const get = await requestJson(
    `${retrievalEndpoint}/trace/${traceId}`,
    { headers: authHeaders },
    200,
  );
  if ((await get.json()).traceId !== traceId)
    throw new Error("integration.fixture.get");
  await requestJson(
    `${retrievalEndpoint}/search`,
    {
      method: "POST",
      headers: { ...authHeaders, "x-agentscope-fault": "unavailable" },
      body: "{}",
    },
    503,
  );
  const [ingestionLedger, retrievalLedger] = await Promise.all([
    requestJson(`${ingestionEndpoint}/ledger`, {}, 200).then((response) =>
      response.json(),
    ),
    requestJson(`${retrievalEndpoint}/ledger`, {}, 200).then((response) =>
      response.json(),
    ),
  ]);
  return {
    ledgerVersion: 1,
    scenarioId,
    ingestion: ingestionLedger.entries,
    retrieval: retrievalLedger.entries,
  };
};

export const runPlatformAdapter = async (context) => {
  const [modelResult, destinationResult] = await Promise.allSettled([
    runModels(context).then((modelLedger) => {
      context.publishCheckpoint({
        eventKinds: representativeEventKinds,
        modelLedger,
      });
      return modelLedger;
    }),
    runDestinations(context).then((destinationLedger) => {
      context.publishCheckpoint({
        eventKinds: representativeEventKinds,
        destinationLedger,
      });
      return destinationLedger;
    }),
  ]);
  if (
    modelResult.status !== "fulfilled" ||
    destinationResult.status !== "fulfilled"
  )
    throw new Error("integration.fixture.adapter");
  const modelLedger = modelResult.value;
  const destinationLedger = destinationResult.value;
  return {
    eventKinds: representativeEventKinds,
    modelLedger,
    destinationLedger,
    assertions: [
      {
        assertionId: "harness-model-routes",
        evaluate: (value) =>
          value.modelLedger.entries.length ===
          context.scenario.modelRoutes.length + 1,
      },
      {
        assertionId: "destination-protocols",
        evaluate: (value) =>
          ["otlp-ingest", "langfuse-ingest"].every((operation) =>
            value.destinationLedger.ingestion.some(
              (entry) =>
                entry.operation === operation && entry.outcome === "accepted",
            ),
          ),
      },
      {
        assertionId: "destination-faults",
        evaluate: (value) =>
          [
            "auth-rejected",
            "rate-limited",
            "unavailable",
            "malformed-response",
          ].every((outcome) =>
            value.destinationLedger.ingestion.some(
              (entry) => entry.outcome === outcome,
            ),
          ) &&
          value.destinationLedger.retrieval.some(
            (entry) =>
              entry.operation === "search" && entry.outcome === "unavailable",
          ),
      },
    ],
  };
};
