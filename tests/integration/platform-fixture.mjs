import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  COMMON_FIXTURE_ASSERTIONS,
  composeFixtureAssertions,
  FIXTURE_LIFECYCLE_PHASES,
  runFixtureAssertions,
} from "./testkit/platform-fixture.js";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`integration.fixture.environment-${name}`);
  return value;
};
if (process.argv.length !== 4 || process.argv[2] !== "--artifact")
  throw new Error("integration.fixture.arguments");
const artifactPath = process.argv[3];
const status = lstatSync(artifactPath);
if (!status.isFile() || status.isSymbolicLink())
  throw new Error("integration.fixture.artifact");

const scenarioId = required("AGENTSCOPE_SCENARIO_ID");
const modelEndpoint = required("AGENTSCOPE_MODEL_SERVER_URL");
const ingestionEndpoint = required("AGENTSCOPE_INGESTION_URL");
const retrievalEndpoint = required("AGENTSCOPE_RETRIEVAL_URL");
const harnessHome = required("HARNESS_HOME");
const agentscopeHome = required("AGENTSCOPE_HOME");
const worktree = required("AGENTSCOPE_WORKTREE");
const ledgerHome = required("AGENTSCOPE_LEDGER");
const routeFixture = JSON.parse(
  readFileSync("/opt/agentscope/current-model-routes.json", "utf8"),
);
const representativeEventKinds = [
  "hook",
  "canonical",
  "redaction",
  "git",
  "model",
  "tool",
  "destination",
];
const manifest = JSON.parse(
  readFileSync("/opt/agentscope/capability-manifest.json", "utf8"),
);
const scenario = manifest.scenarios.find(
  (value) => value.scenarioId === scenarioId,
);
if (!scenario) throw new Error("integration.fixture.scenario");

const authHeaders = {
  authorization: "Bearer DUMMY_DESTINATION_KEY",
  "content-type": "application/json",
};
const requestJson = async (url, options, statusCode) => {
  const response = await fetch(url, options);
  if (response.status !== statusCode)
    throw new Error("integration.fixture.response");
  return response;
};
const waitFor = async (url, options) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return;
    } catch {
      // The isolated service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("integration.fixture.service");
};

const runModels = async () => {
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

const runDestinations = async () => {
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
  for (const path of ["/v1/traces", "/api/public/ingestion"])
    await requestJson(
      `${ingestionEndpoint}${path}`,
      { method: "POST", headers: authHeaders, body },
      202,
    );
  const faultCases = [
    [undefined, 401],
    ["rate", 429],
    ["unavailable", 503],
    ["malformed", 200],
  ];
  for (const [fault, expectedStatus] of faultCases) {
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
    fetch(`${ingestionEndpoint}/ledger`).then((response) => response.json()),
    fetch(`${retrievalEndpoint}/ledger`).then((response) => response.json()),
  ]);
  return {
    ledgerVersion: 1,
    scenarioId,
    ingestion: ingestionLedger.entries,
    retrieval: retrievalLedger.entries,
  };
};

for (const path of [harnessHome, agentscopeHome, worktree, ledgerHome])
  mkdirSync(path, { recursive: true });
await Promise.all([
  waitFor(`${modelEndpoint}/mockserver/retrieve?type=ACTIVE_EXPECTATIONS`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: "{}",
  }),
  waitFor(`${ingestionEndpoint}/health`),
  waitFor(`${retrievalEndpoint}/health`),
]);
writeFileSync(join(agentscopeHome, "installed.json"), '{"fixture":true}\n');
writeFileSync(join(agentscopeHome, "config.json"), '{"fixture":true}\n');
writeFileSync(join(harnessHome, "hook.json"), '{"fixture":true}\n');
const modelLedger = await runModels();
const destinationLedger = await runDestinations();
const evidence = {
  evidenceVersion: 1,
  scenarioId,
  artifactFileName: basename(artifactPath),
  lifecycle: FIXTURE_LIFECYCLE_PHASES,
  eventKinds: representativeEventKinds,
  modelLedger,
  destinationLedger,
};
const assertions = composeFixtureAssertions(
  COMMON_FIXTURE_ASSERTIONS,
  [
    {
      assertionId: "harness-model-routes",
      evaluate: (value) =>
        value.modelLedger.entries.length === scenario.modelRoutes.length + 1,
    },
  ],
  [
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
);
runFixtureAssertions(assertions, evidence);
writeFileSync(
  join(ledgerHome, "fixture-lifecycle.json"),
  `${JSON.stringify({ scenarioId, lifecycle: FIXTURE_LIFECYCLE_PHASES })}\n`,
);
rmSync(join(harnessHome, "hook.json"));
rmSync(join(agentscopeHome, "config.json"));
rmSync(join(agentscopeHome, "installed.json"));
console.log(
  `AGENTSCOPE_FIXTURE_RESULT=${Buffer.from(JSON.stringify(evidence)).toString("base64url")}`,
);
