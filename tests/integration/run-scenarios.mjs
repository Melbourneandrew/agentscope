import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

import {
  compileCapabilityManifest,
  createIsolationPlan,
  executeIsolationPlan,
  mapWithConcurrency,
  sanitizeFixtureResult,
  verifyManifestEvidence,
  verifyPreparedCandidate,
} from "./dist/index.js";
import { acquireIntegrationOperationLock } from "./operation-lock.mjs";

const execute = promisify(execFile);
const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = compileCapabilityManifest(
  readJson(resolve(integrationRoot, "capability-manifest.json")),
);
verifyManifestEvidence(manifest, integrationRoot);
const selection = readJson(resolve(artifactsRoot, "current-selection.json"));
const pointer = readJson(resolve(artifactsRoot, "current-candidate.json"));
const imageEvidence = readJson(resolve(artifactsRoot, "current-images.json"));
const modelRoutes = readJson(
  resolve(artifactsRoot, "current-model-routes.json"),
);
const testMode = process.env.AGENTSCOPE_INTEGRATION_TEST_MODE;
const boundedInteger = (name, fallback, maximum) => {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/u.test(value))
    throw new Error("integration.isolation.runtime-policy");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error("integration.isolation.runtime-policy");
  return parsed;
};
const scenarioConcurrency = boundedInteger(
  "AGENTSCOPE_INTEGRATION_CONCURRENCY",
  2,
  16,
);
const scenarioTimeoutMilliseconds = boundedInteger(
  "AGENTSCOPE_INTEGRATION_TIMEOUT_MS",
  5 * 60 * 1000,
  30 * 60 * 1000,
);
if (
  testMode !== undefined &&
  testMode !== "failure" &&
  testMode !== "interruption" &&
  testMode !== "sidecar-failure"
)
  throw new Error("integration.isolation.test-mode");
if (
  selection.selectionVersion !== 1 ||
  selection.manifestIdentity !== manifest.manifestIdentity ||
  !Array.isArray(selection.scenarioIds) ||
  imageEvidence.imageEvidenceVersion !== 1 ||
  imageEvidence.manifestIdentity !== manifest.manifestIdentity ||
  !Array.isArray(imageEvidence.images) ||
  modelRoutes.routeFixtureVersion !== 1 ||
  !Array.isArray(modelRoutes.routeIds) ||
  !Array.isArray(modelRoutes.routes) ||
  !Array.isArray(modelRoutes.mockServerInitialization)
)
  throw new Error("integration.isolation.inputs");
const candidateDirectory = resolve(
  artifactsRoot,
  "candidates",
  pointer.bundleIdentity,
);
const candidate = verifyPreparedCandidate(candidateDirectory);
if (
  pointer.pointerVersion !== 1 ||
  pointer.bundleIdentity !== candidate.bundleIdentity ||
  pointer.candidateRevision !== candidate.candidateRevision
)
  throw new Error("integration.isolation.inputs");

const docker = async (arguments_, options = {}) =>
  execute("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: scenarioTimeoutMilliseconds,
    ...options,
  });
const dockerWithSignal = (arguments_, signal, options = {}) =>
  docker(arguments_, { ...options, signal });
const ignoreMissing = async (arguments_, signal) => {
  try {
    await docker(arguments_, { signal, timeout: 30_000 });
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    if (!/(?:No such (?:container|image)|network .* not found)/u.test(output))
      throw error;
  }
};
const labelArguments = (plan) => [
  "--label",
  "com.agentscope.integration=true",
  "--label",
  `com.agentscope.integration.run=${plan.runId}`,
];
const tmpfsArguments = (plan) =>
  plan.tmpfsMounts.flatMap((mount) => [
    "--tmpfs",
    `${mount}:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000`,
  ]);
const confinementArguments = (plan) => [
  "--network",
  plan.networkName,
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "128",
  "--memory",
  "512m",
  "--user",
  "1000:1000",
  ...tmpfsArguments(plan),
];
const sidecarResourceArguments = ["--pids-limit", "128", "--memory", "512m"];

const stageBuildContext = (plan) => {
  const context = resolve(artifactsRoot, "contexts", plan.runId);
  rmSync(context, { force: true, recursive: true });
  mkdirSync(resolve(context, "prepared/candidates"), { recursive: true });
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === plan.scenarioId,
  );
  if (scenario === undefined) throw new Error("integration.isolation.context");
  const sources = [
    ["runner.mjs", resolve(integrationRoot, "runner.mjs")],
    [
      "destination-server.mjs",
      resolve(integrationRoot, "destination-server.mjs"),
    ],
    ["platform-fixture.mjs", resolve(integrationRoot, "platform-fixture.mjs")],
    [
      "scenario-adapter.mjs",
      resolve(integrationRoot, scenario.fixtureAdapter.path),
    ],
    [
      "testkit/platform-fixture.js",
      resolve(workspaceRoot, "packages/testkit/dist/platform-fixture.js"),
    ],
    [
      "capability-manifest.json",
      resolve(integrationRoot, "capability-manifest.json"),
    ],
    [
      "current-selection.json",
      resolve(artifactsRoot, "current-selection.json"),
    ],
    [
      "current-model-routes.json",
      resolve(artifactsRoot, "current-model-routes.json"),
    ],
    [
      "prepared/current-candidate.json",
      resolve(artifactsRoot, "current-candidate.json"),
    ],
  ];
  for (const [destination, source] of sources) {
    const status = lstatSync(source);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error("integration.isolation.context");
    const target = resolve(context, destination);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
  cpSync(
    candidateDirectory,
    resolve(context, "prepared/candidates", candidate.bundleIdentity),
    { recursive: true },
  );
  writeFileSync(
    resolve(context, "Dockerfile"),
    [
      "ARG BASE_IMAGE",
      "FROM ${BASE_IMAGE}",
      "WORKDIR /opt/agentscope",
      "COPY runner.mjs destination-server.mjs platform-fixture.mjs scenario-adapter.mjs capability-manifest.json current-selection.json current-model-routes.json ./",
      "COPY testkit ./testkit",
      "COPY prepared ./prepared",
      "USER node",
      'CMD ["node", "/opt/agentscope/runner.mjs"]',
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(context, "mockserver-initialization.json"),
    `${JSON.stringify(modelRoutes.mockServerInitialization, undefined, 2)}\n`,
  );
  writeFileSync(
    resolve(context, "MockServer.Dockerfile"),
    [
      "ARG MOCKSERVER_IMAGE",
      "FROM ${MOCKSERVER_IMAGE}",
      "COPY mockserver-initialization.json /config/expectations.json",
      "",
    ].join("\n"),
  );
  return context;
};

const assertContainer = async (plan, signal) => {
  const { stdout } = await dockerWithSignal(
    ["container", "inspect", plan.scenarioName],
    signal,
  );
  const [container] = JSON.parse(stdout);
  const tmpfs = Object.keys(container?.HostConfig?.Tmpfs ?? {}).sort();
  if (
    container?.HostConfig?.ReadonlyRootfs !== true ||
    container?.HostConfig?.NetworkMode !== plan.networkName ||
    !Array.isArray(container?.Mounts) ||
    container.Mounts.length !== 0 ||
    JSON.stringify(tmpfs) !== JSON.stringify([...plan.tmpfsMounts].sort())
  )
    throw new Error("integration.isolation.container");
};

const fixtureResults = new Map();
const activeMarkerFor = (runId) =>
  resolve(artifactsRoot, "active", `${runId}.json`);
const activateRun = (plan) => {
  const release = acquireIntegrationOperationLock(
    workspaceRoot,
    "integration.isolation.active",
  );
  try {
    const directory = resolve(artifactsRoot, "active");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      activeMarkerFor(plan.runId),
      `${JSON.stringify({ activeVersion: 1, runId: plan.runId, pid: process.pid })}\n`,
      { flag: "wx" },
    );
  } finally {
    release();
  }
};
const captureFixtureResult = (output, plan) => {
  const resultLine = output
    .split("\n")
    .filter((line) => line.startsWith("AGENTSCOPE_FIXTURE_RESULT="))
    .at(-1);
  if (resultLine === undefined) return false;
  if (resultLine.length > 1024 * 1024)
    throw new Error("integration.isolation.fixture-result");
  fixtureResults.set(
    plan.runId,
    sanitizeFixtureResult(
      JSON.parse(
        Buffer.from(
          resultLine.slice("AGENTSCOPE_FIXTURE_RESULT=".length),
          "base64url",
        ).toString("utf8"),
      ),
      plan.scenarioId,
    ),
  );
  return true;
};
const preparedImageFor = async (image, signal) => {
  const prepared = imageEvidence.images.find((entry) => entry.image === image);
  if (!prepared) throw new Error("integration.isolation.base-image");
  const { stdout } = await dockerWithSignal(
    ["image", "inspect", "--format", "{{.Id}}", image],
    signal,
  );
  if (stdout.trim().replace(":", "-") !== prepared.localImageDigest)
    throw new Error("integration.isolation.base-image");
};
const inspectImage = async (tag, signal) => {
  const { stdout } = await dockerWithSignal(
    ["image", "inspect", "--format", "{{.Id}}", tag],
    signal,
  );
  return stdout.trim().replace(":", "-");
};
const buildImage = async (plan, signal) => {
  await preparedImageFor(plan.baseImage, signal);
  const context = stageBuildContext(plan);
  await dockerWithSignal(
    [
      "build",
      "--network",
      "none",
      "--pull=false",
      ...labelArguments(plan),
      "--build-arg",
      `BASE_IMAGE=${plan.baseImage}`,
      "--tag",
      plan.imageTag,
      context,
    ],
    signal,
  );
  return inspectImage(plan.imageTag, signal);
};
const buildMockServerImage = async (plan, signal) => {
  await preparedImageFor(plan.mockServerImage, signal);
  const context = resolve(artifactsRoot, "contexts", plan.runId);
  await dockerWithSignal(
    [
      "build",
      "--network",
      "none",
      "--pull=false",
      ...labelArguments(plan),
      "--file",
      resolve(context, "MockServer.Dockerfile"),
      "--build-arg",
      `MOCKSERVER_IMAGE=${plan.mockServerImage}`,
      "--tag",
      plan.mockServerImageTag,
      context,
    ],
    signal,
  );
  return inspectImage(plan.mockServerImageTag, signal);
};
const createNetwork = async (plan, signal) => {
  await dockerWithSignal(
    [
      "network",
      "create",
      "--internal",
      ...labelArguments(plan),
      plan.networkName,
    ],
    signal,
  );
};
const startCollector = async (plan, signal) => {
  await dockerWithSignal(
    [
      "create",
      "--name",
      plan.collectorName,
      ...labelArguments(plan),
      "--network",
      plan.networkName,
      "--network-alias",
      "collector",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...sidecarResourceArguments,
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000",
      "--env",
      `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
      plan.imageTag,
      "node",
      "/opt/agentscope/destination-server.mjs",
      "ingestion",
    ],
    signal,
  );
  await dockerWithSignal(["start", plan.collectorName], signal);
};
const startRetrieval = async (plan, signal) => {
  await dockerWithSignal(
    [
      "create",
      "--name",
      plan.retrievalName,
      ...labelArguments(plan),
      "--network",
      plan.networkName,
      "--network-alias",
      "retrieval",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...sidecarResourceArguments,
      "--user",
      "1000:1000",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000",
      "--env",
      `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
      plan.imageTag,
      "node",
      "/opt/agentscope/destination-server.mjs",
      "retrieval",
    ],
    signal,
  );
  await dockerWithSignal(["start", plan.retrievalName], signal);
};
const startMockServer = async (plan, signal) => {
  await dockerWithSignal(
    [
      "create",
      "--name",
      plan.mockServerName,
      ...labelArguments(plan),
      "--network",
      plan.networkName,
      "--network-alias",
      "mockserver",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      ...sidecarResourceArguments,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      "--env",
      "MOCKSERVER_INITIALIZATION_JSON_PATH=/config/expectations.json",
      "--env",
      "MOCKSERVER_LOG_LEVEL=WARN",
      plan.mockServerImageTag,
    ],
    signal,
  );
  await dockerWithSignal(["start", plan.mockServerName], signal);
};
const runScenario = async (plan, signal) => {
  const testModeArguments =
    testMode === undefined
      ? []
      : ["--env", `AGENTSCOPE_INTEGRATION_TEST_MODE=${testMode}`];
  await dockerWithSignal(
    [
      "create",
      "--name",
      plan.scenarioName,
      ...labelArguments(plan),
      ...confinementArguments(plan),
      "--env",
      "HOME=/home/agentscope",
      "--env",
      "XDG_CONFIG_HOME=/harness-home",
      "--env",
      "HARNESS_HOME=/harness-home",
      "--env",
      "AGENTSCOPE_HOME=/agentscope-home",
      "--env",
      "AGENTSCOPE_WORKTREE=/worktree",
      "--env",
      "AGENTSCOPE_LEDGER=/ledger",
      "--env",
      "AGENTSCOPE_CANDIDATE_ROOT=/opt/agentscope/prepared",
      "--env",
      "AGENTSCOPE_COLLECTOR_URL=http://collector:4318",
      "--env",
      "AGENTSCOPE_INGESTION_URL=http://collector:4318",
      "--env",
      "AGENTSCOPE_RETRIEVAL_URL=http://retrieval:4319",
      "--env",
      "AGENTSCOPE_MODEL_SERVER_URL=http://mockserver:1080",
      "--env",
      `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
      ...testModeArguments,
      plan.imageTag,
    ],
    signal,
  );
  await assertContainer(plan, signal);
  if (testMode === "sidecar-failure")
    await dockerWithSignal(["stop", plan.collectorName], signal);
  try {
    const { stdout } = await dockerWithSignal(
      ["start", "--attach", plan.scenarioName],
      signal,
    );
    if (!captureFixtureResult(stdout, plan))
      throw new Error("integration.isolation.fixture-result");
  } catch (error) {
    captureFixtureResult(`${error?.stdout ?? ""}`, plan);
    throw error;
  }
};
const recordEvidence = async (evidence) => {
  const directory = resolve(artifactsRoot, "runs", evidence.runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "evidence.json"),
    `${JSON.stringify(evidence, undefined, 2)}\n`,
  );
  const result = fixtureResults.get(evidence.runId);
  if (
    evidence.outcome === "passed" &&
    (result === undefined || result.resultStatus !== "complete")
  )
    throw new Error("integration.isolation.fixture-result");
  if (result !== undefined) {
    writeFileSync(
      resolve(directory, "model-ledger.json"),
      `${JSON.stringify(result.modelLedger, undefined, 2)}\n`,
    );
    writeFileSync(
      resolve(directory, "destination-ledger.json"),
      `${JSON.stringify(result.destinationLedger, undefined, 2)}\n`,
    );
    writeFileSync(
      resolve(directory, "fixture-lifecycle.json"),
      `${JSON.stringify(
        {
          evidenceVersion: 1,
          resultStatus: result.resultStatus,
          scenarioId: result.scenarioId,
          artifactFileName: result.artifactFileName,
          lifecycle: result.lifecycle,
          eventKinds: result.eventKinds,
        },
        undefined,
        2,
      )}\n`,
    );
    fixtureResults.delete(evidence.runId);
  }
};
const createDriver = () => {
  let cleanupSignal;
  const boundedCleanupSignal = () => {
    cleanupSignal ??= AbortSignal.timeout(60_000);
    return cleanupSignal;
  };
  return {
    buildImage,
    buildMockServerImage,
    createNetwork,
    startCollector,
    startRetrieval,
    startMockServer,
    runScenario,
    recordEvidence,
    removeContainer: (name) =>
      ignoreMissing(["rm", "--force", name], boundedCleanupSignal()),
    removeNetwork: (name) =>
      ignoreMissing(["network", "rm", name], boundedCleanupSignal()),
    removeImage: (tag) =>
      ignoreMissing(["image", "rm", "--force", tag], boundedCleanupSignal()),
    removeContext: async (runId) => {
      if (!/^[a-f\d]{16}$/u.test(runId))
        throw new Error("integration.isolation.context");
      rmSync(resolve(artifactsRoot, "contexts", runId), {
        force: true,
        recursive: true,
      });
      rmSync(activeMarkerFor(runId), { force: true });
    },
  };
};

const scenarios = selection.scenarioIds.map((scenarioId) => {
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === scenarioId,
  );
  if (!scenario) throw new Error("integration.isolation.inputs");
  if (
    scenario.modelRoutes.some(
      (routeId) => !modelRoutes.routeIds.includes(routeId),
    )
  )
    throw new Error("integration.isolation.model-routes");
  return scenario;
});
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  const evidence = await mapWithConcurrency(
    scenarios,
    scenarioConcurrency,
    (scenario) => {
      const plan = createIsolationPlan({
        scenario,
        manifestIdentity: manifest.manifestIdentity,
        candidate,
        runToken: randomBytes(8).toString("hex"),
      });
      activateRun(plan);
      return executeIsolationPlan(
        plan,
        createDriver(),
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(scenarioTimeoutMilliseconds),
        ]),
      );
    },
  );
  console.log(JSON.stringify(evidence));
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
