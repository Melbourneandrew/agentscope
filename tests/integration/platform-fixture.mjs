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
import { runPlatformAdapter } from "./scenario-adapter.mjs";

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
  for (let attempt = 0; attempt < 60; attempt += 1) {
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
writeFileSync(join(agentscopeHome, "config.json"), '{"fixture":true}\n');
writeFileSync(join(harnessHome, "hook.json"), '{"fixture":true}\n');

const adapterResult = await runPlatformAdapter({
  ingestionEndpoint,
  modelEndpoint,
  requestJson,
  retrievalEndpoint,
  routeFixture,
  scenario,
  scenarioId,
});
const evidence = {
  evidenceVersion: 1,
  scenarioId,
  artifactFileName: basename(artifactPath),
  lifecycle: FIXTURE_LIFECYCLE_PHASES,
  eventKinds: adapterResult.eventKinds,
  modelLedger: adapterResult.modelLedger,
  destinationLedger: adapterResult.destinationLedger,
};
runFixtureAssertions(
  composeFixtureAssertions(COMMON_FIXTURE_ASSERTIONS, adapterResult.assertions),
  evidence,
);
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
