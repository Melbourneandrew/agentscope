import {
  lstatSync,
  mkdirSync,
  readSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { FIXTURE_LIFECYCLE_PHASES } from "./testkit/platform-fixture.js";
import {
  assertProcessFixtureEvidence,
  captureProcessFixtureRawProjection,
  correlateProcessFixtureObservations,
  PROCESS_FIXTURE_STIMULUS,
} from "./process-platform-oracle.mjs";
import { translatePlatformObservations } from "./scenario-adapter.mjs";

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
const manifest = JSON.parse(
  readFileSync("/opt/agentscope/capability-manifest.json", "utf8"),
);
const scenario = manifest.scenarios.find(
  (value) => value.scenarioId === scenarioId,
);
if (!scenario) throw new Error("integration.fixture.scenario");
const interactive = scenario.executionMode === "interactive";
if (
  (interactive &&
    (scenario.outputContract !== "semantic-pty" ||
      process.stdin.isTTY !== true ||
      process.stdout.isTTY !== true ||
      process.stdout.columns !== 80 ||
      process.stdout.rows !== 24)) ||
  (!interactive &&
    (scenario.executionMode !== "headless" ||
      scenario.outputContract !== "jsonl" ||
      process.stdin.isTTY === true ||
      process.stdout.isTTY === true))
)
  throw new Error("integration.fixture.execution-mode");
if (interactive) {
  process.stdout.write("\u001b[?1049hAGENTSCOPE_PTY_READY\r\n");
  const geometryDeadline = performance.now() + 2_000;
  while (
    (process.stdout.columns !== 100 || process.stdout.rows !== 30) &&
    performance.now() < geometryDeadline
  )
    await new Promise((resolve) => setImmediate(resolve));
  if (process.stdout.columns !== 100 || process.stdout.rows !== 30)
    throw new Error("integration.fixture.interactive-geometry");
  const input = Buffer.alloc(4);
  let inputOffset = 0;
  while (inputOffset < input.length) {
    const bytesRead = readSync(
      0,
      input,
      inputOffset,
      input.length - inputOffset,
      null,
    );
    if (bytesRead < 1) throw new Error("integration.fixture.interactive-input");
    inputOffset += bytesRead;
  }
  if (input.toString("utf8") !== "run\n")
    throw new Error("integration.fixture.interactive-input");
}

const observedLifecycle = [];
let partial = {
  eventKinds: [],
  modelLedger: { ledgerVersion: 1, scenarioId, entries: [] },
  destinationLedger: {
    ledgerVersion: 1,
    scenarioId,
    ingestion: [],
    retrieval: [],
  },
};
const emitEvidence = (resultStatus) => {
  const evidence = {
    evidenceVersion: 1,
    resultStatus,
    scenarioId,
    artifactFileName: basename(artifactPath),
    lifecycle: [...observedLifecycle],
    ...partial,
  };
  if (!interactive)
    console.log(
      `AGENTSCOPE_FIXTURE_RESULT=${Buffer.from(JSON.stringify(evidence)).toString("base64url")}`,
    );
  return evidence;
};
emitEvidence("partial");
const recordLifecycle = (phase, publish = true) => {
  const expected = FIXTURE_LIFECYCLE_PHASES[observedLifecycle.length];
  if (phase !== expected)
    throw new Error("integration.fixture.lifecycle-order");
  observedLifecycle.push(phase);
  if (publish) emitEvidence("partial");
};

const requestJson = async (url, options, statusCode) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== statusCode)
    throw new Error("integration.fixture.response");
  return response;
};
const waitFor = async (url, options) => {
  const maximumAttempts =
    process.env.AGENTSCOPE_INTEGRATION_TEST_MODE === "sidecar-failure" ? 3 : 60;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The isolated service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("integration.fixture.service");
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
recordLifecycle("install");
writeFileSync(join(agentscopeHome, "config.json"), '{"fixture":true}\n');
recordLifecycle("configure");
writeFileSync(join(harnessHome, "hook.json"), '{"fixture":true}\n');
recordLifecycle("hook");

// This test-family module owns stimuli and expected results. The scenario
// adapter below receives only native observations and cannot author a pass.
const runModels = async () => {
  for (const routeId of scenario.modelRoutes) {
    const route = routeFixture.routes.find(
      (candidate) => candidate.routeId === routeId,
    );
    if (!route) throw new Error("integration.fixture.model-route");
    const url = new URL(route.path, modelEndpoint);
    for (const [name, value] of Object.entries(route.query ?? {}))
      url.searchParams.set(name, value);
    const response = await requestJson(
      url,
      {
        method: route.method,
        headers: route.headers,
        body: JSON.stringify(route.requestBody),
      },
      200,
    );
    if (
      JSON.stringify(await response.json()) !==
      JSON.stringify(route.responseBody)
    )
      throw new Error("integration.fixture.model-response");
  }
  await requestJson(`${modelEndpoint}/agentscope-unmatched`, {}, 404);
  return requestJson(
    `${modelEndpoint}/mockserver/retrieve?type=REQUESTS`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    200,
  ).then((response) => response.json());
};

const representative = PROCESS_FIXTURE_STIMULUS.representative;
const authHeaders = Object.freeze({
  authorization: "Bearer DUMMY_DESTINATION_KEY",
  "content-type": "application/json",
});
const runExports = async () => {
  const body = JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans: [representative] }] }],
  });
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
    { method: "POST", headers: authHeaders, body: "x".repeat(1024 * 1024 + 1) },
    413,
  );
  return Promise.all([
    requestJson(`${ingestionEndpoint}/ledger`, {}, 200).then((response) =>
      response.json(),
    ),
    requestJson(`${ingestionEndpoint}/observations`, {}, 200).then((response) =>
      response.json(),
    ),
  ]);
};

const runRetrieval = async () => {
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
  if ((await search.json()).traces?.[0]?.traceId !== representative.traceId)
    throw new Error("integration.fixture.search");
  const get = await requestJson(
    `${retrievalEndpoint}/trace/${representative.traceId}`,
    { headers: authHeaders },
    200,
  );
  if ((await get.json()).traceId !== representative.traceId)
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
  return requestJson(`${retrievalEndpoint}/ledger`, {}, 200).then((response) =>
    response.json(),
  );
};

const modelRequests = await runModels();
recordLifecycle("execute");
const [ingestionLedger, destinationObservation] = await runExports();
recordLifecycle("export");
const retrievalLedger = await runRetrieval();
recordLifecycle("retrieve");
const rawObservations = {
  scenarioId,
  modelRequests,
  ingestionLedger,
  retrievalLedger,
  destinationObservation,
};
const rawProjection = captureProcessFixtureRawProjection(rawObservations);
const observations = translatePlatformObservations(rawObservations);
partial = correlateProcessFixtureObservations(observations, {
  rawProjection,
  routeFixture,
  scenario,
});
emitEvidence("partial");

rmSync(join(harnessHome, "hook.json"));
rmSync(join(agentscopeHome, "config.json"));
rmSync(join(agentscopeHome, "installed.json"));
recordLifecycle("uninstall", false);
const evidence = {
  evidenceVersion: 1,
  resultStatus: "complete",
  scenarioId,
  artifactFileName: basename(artifactPath),
  lifecycle: [...observedLifecycle],
  ...partial,
};
assertProcessFixtureEvidence(evidence, {
  routeFixture,
  scenario,
});
writeFileSync(
  join(ledgerHome, "fixture-lifecycle.json"),
  `${JSON.stringify({ scenarioId, lifecycle: observedLifecycle })}\n`,
);
const encodedEvidence = Buffer.from(JSON.stringify(evidence)).toString(
  "base64url",
);
writeFileSync(
  join(ledgerHome, "fixture-result.json"),
  `${JSON.stringify({ evidenceVersion: 1, encodedEvidence, scenarioId })}\n`,
  { flag: "wx", mode: 0o600 },
);
if (interactive) {
  await new Promise((resolve, reject) => {
    process.stdout.write("AGENTSCOPE_PTY_COMPLETE\u001b[?1049l\r\n", (error) =>
      error === undefined || error === null ? resolve() : reject(error),
    );
  });
  process.stdin.destroy();
  process.exit(0);
} else console.log(`AGENTSCOPE_FIXTURE_RESULT=${encodedEvidence}`);
