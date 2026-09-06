/* eslint import-x/no-cycle: "off" -- private executable capability */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  cpSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  compileIsolationEvidence,
  compileCapabilityManifest,
  createIsolationPlan,
  executeIsolationPlan,
  ISOLATION_EXECUTOR_LIMITS,
  mapWithConcurrency,
  sanitizeFixtureResult,
  selectCapabilityScenarios,
  verifyManifestEvidence,
  verifyPreparedCandidate,
} from "./dist/index.js";
import {
  buildPreparedDockerImage,
  closePreparedDockerClient,
  createPreparedDockerClient,
  IMAGE_PREPARATION_EXECUTION_POLICY,
  IMAGE_PREPARATION_LIMITS,
  prepareDockerInvocation,
  handlePreparedDockerCleanupFailure,
  markPreparedDockerClientForOuterHostRetirement,
  preparedDockerClientDiagnostic,
  preparedDockerClientRequiresOuterHostRetirement,
  readPreparedImageEvidence,
  revalidatePreparedImageAdmission,
} from "./image-preparation.mjs";
import { acquireIntegrationOperationLock } from "./operation-lock.mjs";
import {
  integrationStageSignal,
  registerIntegrationFailureEvidence,
  registerIntegrationHeadlessReceipt,
  registerIntegrationRunIds,
  requireIntegrationFailureEvidence,
  remainingIntegrationOperationMilliseconds,
  requireDisposableOuterHostCapability,
} from "./dist/controller.js";

const capability = requireDisposableOuterHostCapability();
const canonicalImagePlatform = `${IMAGE_PREPARATION_EXECUTION_POLICY.platform.os}/${IMAGE_PREPARATION_EXECUTION_POLICY.platform.architecture}`;

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
let preparedImageEvidence;
try {
  preparedImageEvidence = readPreparedImageEvidence(
    resolve(artifactsRoot, "current-images.json"),
    manifest.manifestIdentity,
  );
} catch {
  throw new Error("integration.isolation.inputs");
}
if (
  testMode !== undefined &&
  testMode !== "failure" &&
  testMode !== "interruption" &&
  testMode !== "sidecar-failure"
)
  throw new Error("integration.isolation.test-mode");
if (
  selection.selectionVersion !== 2 ||
  selection.manifestIdentity !== manifest.manifestIdentity ||
  !["scenario", "harness", "tag", "shard", "full"].includes(
    selection.selectionMode,
  ) ||
  typeof selection.selector !== "object" ||
  selection.selector === null ||
  !Array.isArray(selection.scenarioIds) ||
  modelRoutes.routeFixtureVersion !== 1 ||
  !Array.isArray(modelRoutes.routeIds) ||
  !Array.isArray(modelRoutes.routes) ||
  !Array.isArray(modelRoutes.mockServerInitialization)
)
  throw new Error("integration.isolation.inputs");
let selectedScenarios;
try {
  selectedScenarios = selectCapabilityScenarios(manifest, selection.selector);
} catch {
  throw new Error("integration.isolation.inputs");
}
const selectedScenarioIds = selectedScenarios.map(
  ({ scenarioId }) => scenarioId,
);
if (
  JSON.stringify(selection.scenarioIds) !== JSON.stringify(selectedScenarioIds)
)
  throw new Error("integration.isolation.inputs");
const executorSelection = {
  selectionVersion: 2,
  manifestIdentity: manifest.manifestIdentity,
  mode: selection.selectionMode,
  selector: selection.selector,
  scenarioIds: selectedScenarioIds,
};
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
const cliArtifact = candidate.artifacts.find(
  ({ id }) => id === "agentscope-cli",
);
if (cliArtifact === undefined)
  throw new Error("integration.isolation.candidate-artifact");

let preparedDockerClient;
const docker = async (
  arguments_,
  { mutationCapable = false, ...options } = {},
) => {
  const invocation = await prepareDockerInvocation(
    preparedDockerClient,
    arguments_,
    options.signal,
  );
  try {
    return await execute(invocation.executable, invocation.arguments, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: remainingIntegrationOperationMilliseconds(
        scenarioTimeoutMilliseconds,
      ),
      ...options,
      cwd: integrationRoot,
      env: invocation.environment,
    });
  } catch (error) {
    if (mutationCapable)
      markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
    throw error;
  }
};
const dockerWithSignal = (arguments_, signal, options = {}) =>
  docker(arguments_, { ...options, signal });
const ignoreMissing = async (arguments_, signal) => {
  try {
    await docker(arguments_, {
      signal,
      timeout: remainingIntegrationOperationMilliseconds(30_000),
    });
  } catch (error) {
    handlePreparedDockerCleanupFailure(preparedDockerClient, error);
  }
};
const labelArguments = (plan) => [
  "--label",
  "com.agentscope.integration=true",
  "--label",
  `com.agentscope.integration.run=${plan.runId}`,
];
const tmpfsArguments = (limits, ownership = true) =>
  limits.tmpfs.flatMap(({ path, bytes }) => [
    "--tmpfs",
    `${path}:rw,noexec,nosuid,nodev,size=${bytes}${ownership ? ",uid=1000,gid=1000" : ""}`,
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
  String(ISOLATION_EXECUTOR_LIMITS.containers.scenario.pidsLimit),
  "--memory",
  String(ISOLATION_EXECUTOR_LIMITS.containers.scenario.memoryBytes),
  "--user",
  "1000:1000",
  ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers.scenario),
];
const sidecarResourceArguments = (limits) => [
  "--pids-limit",
  String(limits.pidsLimit),
  "--memory",
  String(limits.memoryBytes),
];

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
      "testkit/headless-supervisor.js",
      resolve(workspaceRoot, "packages/testkit/dist/headless-supervisor.js"),
    ],
    [
      "testkit/headless-supervisor-contract.js",
      resolve(
        workspaceRoot,
        "packages/testkit/dist/headless-supervisor-contract.js",
      ),
    ],
    [
      "testkit/headless-supervisor-kernel.js",
      resolve(
        workspaceRoot,
        "packages/testkit/dist/headless-supervisor-kernel.js",
      ),
    ],
    [
      "testkit/internal/headless-supervisor-backend.js",
      resolve(
        workspaceRoot,
        "packages/testkit/dist/internal/headless-supervisor-backend.js",
      ),
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

const assertContainer = async (
  plan,
  name,
  limits,
  signal,
  expectedRequestBytes,
) => {
  const { stdout } = await dockerWithSignal(
    ["container", "inspect", name],
    signal,
  );
  const [container] = JSON.parse(stdout);
  const tmpfs = container?.HostConfig?.Tmpfs ?? {};
  const tmpfsPaths = Object.keys(tmpfs).sort();
  const expectedPaths = limits.tmpfs.map(({ path }) => path).sort();
  const tmpfsMatches = limits.tmpfs.every(({ path, bytes }) => {
    const options = new Set(String(tmpfs[path] ?? "").split(","));
    return (
      options.has("rw") &&
      options.has("noexec") &&
      options.has("nosuid") &&
      options.has("nodev") &&
      options.has(`size=${bytes}`)
    );
  });
  const environment = Array.isArray(container?.Config?.Env)
    ? container.Config.Env
    : [];
  const requestLimitMatches =
    expectedRequestBytes === undefined ||
    environment.includes(
      `AGENTSCOPE_MAXIMUM_REQUEST_BYTES=${expectedRequestBytes}`,
    );
  if (
    container?.HostConfig?.ReadonlyRootfs !== true ||
    container?.HostConfig?.NetworkMode !== plan.networkName ||
    container?.HostConfig?.Memory !== limits.memoryBytes ||
    container?.HostConfig?.PidsLimit !== limits.pidsLimit ||
    !Array.isArray(container?.Mounts) ||
    container.Mounts.length !== 0 ||
    JSON.stringify(tmpfsPaths) !== JSON.stringify(expectedPaths) ||
    !tmpfsMatches ||
    !requestLimitMatches
  )
    throw new Error("integration.isolation.container");
};

const fixtureResults = new Map();
const scenarioOutcomes = new Map();
const fingerprintHeadlessRequest = (request) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex")}`;
const linuxBootMonotonicMilliseconds = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.isolation.headless-clock");
  const value = Number(source.split(/\s/u, 1)[0]) * 1_000;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("integration.isolation.headless-clock");
  return value;
};
const expectedHeadlessEnvironment = (plan) => ({
  AGENTSCOPE_HOME: "/agentscope-home",
  AGENTSCOPE_CANDIDATE_ROOT: "/opt/agentscope/prepared",
  AGENTSCOPE_COLLECTOR_URL: "http://collector:4318",
  AGENTSCOPE_INGESTION_URL: "http://collector:4318",
  AGENTSCOPE_LEDGER: "/ledger",
  AGENTSCOPE_MODEL_SERVER_URL: "http://mockserver:1080",
  AGENTSCOPE_RETRIEVAL_URL: "http://retrieval:4319",
  AGENTSCOPE_SCENARIO_ID: plan.scenarioId,
  AGENTSCOPE_WORKTREE: "/worktree",
  HARNESS_HOME: "/harness-home",
  HOME: "/home/agentscope",
  LANG: "C.UTF-8",
  NO_COLOR: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  XDG_CONFIG_HOME: "/harness-home",
  ...(testMode === undefined
    ? {}
    : { AGENTSCOPE_INTEGRATION_TEST_MODE: testMode }),
});
const activeMarkerFor = (runId) =>
  resolve(artifactsRoot, "active", `${runId}.json`);
const activateRuns = async (plans) => {
  const release = await acquireIntegrationOperationLock(
    workspaceRoot,
    "integration.isolation.active",
  );
  const activated = [];
  try {
    const directory = resolve(artifactsRoot, "active");
    mkdirSync(directory, { recursive: true });
    for (const plan of plans) {
      const marker = activeMarkerFor(plan.runId);
      writeFileSync(
        marker,
        `${JSON.stringify({ activeVersion: 1, runId: plan.runId, pid: process.pid })}\n`,
        { flag: "wx" },
      );
      activated.push(marker);
    }
  } catch (error) {
    for (const marker of activated) rmSync(marker, { force: true });
    throw error;
  } finally {
    await release();
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
const headlessRequestMatches = (receipt, plan) =>
  receipt.request?.runId === plan.runId &&
  receipt.request.executable === "/usr/local/bin/node" &&
  JSON.stringify(receipt.request.arguments) ===
    JSON.stringify([
      "/opt/agentscope/platform-fixture.mjs",
      "--artifact",
      `/opt/agentscope/prepared/candidates/${candidate.bundleIdentity}/files/${cliArtifact.fileName}`,
    ]) &&
  receipt.request.cwd === "/opt/agentscope" &&
  JSON.stringify(receipt.request.environment) ===
    JSON.stringify(expectedHeadlessEnvironment(plan)) &&
  receipt.request.stdinBase64 === "" &&
  receipt.request.stdoutLimitBytes === 1024 * 1024 &&
  receipt.request.stderrLimitBytes === 1024 * 1024 &&
  receipt.request.monotonicShutdownDeadlineMs ===
    receipt.translationLocalAtMs +
      (receipt.outerMonotonicDeadlineMs - receipt.translationBootAtMs) &&
  receipt.request.monotonicExecutionDeadlineMs ===
    receipt.request.monotonicShutdownDeadlineMs - 5_000 &&
  receipt.request.monotonicStartupDeadlineMs ===
    Math.min(
      receipt.requestConstructedAtMs + 10_000,
      receipt.request.monotonicShutdownDeadlineMs - 5_000,
    ) &&
  receipt.request.terminationGraceMs === 1_000 &&
  receipt.returnedAtMs <= receipt.request.monotonicShutdownDeadlineMs &&
  receipt.requestFingerprint === fingerprintHeadlessRequest(receipt.request);
const captureHeadlessReceipt = (output, plan, expected) => {
  const line = output
    .split("\n")
    .filter((candidate) => candidate.startsWith("AGENTSCOPE_HEADLESS_RECEIPT="))
    .at(-1);
  if (line === undefined || line.length > 16_384)
    throw new Error("integration.isolation.headless-receipt");
  let receipt;
  try {
    receipt = JSON.parse(
      Buffer.from(
        line.slice("AGENTSCOPE_HEADLESS_RECEIPT=".length),
        "base64url",
      ).toString("utf8"),
    );
  } catch {
    throw new Error("integration.isolation.headless-receipt");
  }
  if (
    Object.keys(receipt).sort().join(",") !==
      [
        "cleanup",
        "exitCode",
        "outcome",
        "outerMonotonicDeadlineMs",
        "processJoined",
        "request",
        "requestConstructedAtMs",
        "receiptVersion",
        "requestFingerprint",
        "residualProcessCount",
        "returnedAtMs",
        "runId",
        "signal",
        "stderrJoined",
        "stdinJoined",
        "stdoutJoined",
        "translationBootAtMs",
        "translationLocalAtMs",
      ]
        .sort()
        .join(",") ||
    receipt.receiptVersion !== 1 ||
    receipt.runId !== plan.runId ||
    receipt.outerMonotonicDeadlineMs !== expected.outerMonotonicDeadline ||
    linuxBootMonotonicMilliseconds() >= expected.outerMonotonicDeadline ||
    !Number.isFinite(receipt.translationBootAtMs) ||
    !Number.isFinite(receipt.translationLocalAtMs) ||
    !Number.isFinite(receipt.requestConstructedAtMs) ||
    !Number.isFinite(receipt.returnedAtMs) ||
    receipt.translationBootAtMs < 0 ||
    receipt.translationLocalAtMs < 0 ||
    receipt.requestConstructedAtMs < receipt.translationLocalAtMs ||
    !headlessRequestMatches(receipt, plan)
  )
    throw new Error("integration.isolation.headless-receipt");
  return Object.freeze(receipt);
};
const preparedImageFor = async (image, signal) => {
  if (
    !(await revalidatePreparedImageAdmission(preparedImageEvidence, image, {
      maximumPreparationMilliseconds: Math.min(
        scenarioTimeoutMilliseconds,
        30_000,
      ),
      signal,
    }))
  )
    throw new Error("integration.isolation.base-image");
};
const inspectDockerRuntimeIdentity = async (signal) => {
  const [{ stdout: versionOutput }, { stdout: infoOutput }] = await Promise.all(
    [
      dockerWithSignal(["version", "--format", "{{json .}}"], signal),
      dockerWithSignal(["info", "--format", "{{json .}}"], signal),
    ],
  );
  const versionRecord = JSON.parse(versionOutput);
  const infoRecord = JSON.parse(infoOutput);
  const defaultRuntime = infoRecord.DefaultRuntime;
  const components = Array.isArray(versionRecord?.Server?.Components)
    ? versionRecord.Server.Components
    : [];
  const runtimeComponent = components.find(
    (component) => component?.Name === defaultRuntime,
  );
  const containerdComponent = components.find(
    (component) => component?.Name === "containerd",
  );
  const product = versionRecord?.Server?.Platform?.Name || "Docker Engine";
  const operatingSystem = infoRecord.OperatingSystem;
  return {
    executor: "docker",
    clientVersion: versionRecord?.Client?.Version,
    engine: {
      kind: `${product} ${operatingSystem}`
        .toLowerCase()
        .includes("docker desktop")
        ? "docker-desktop"
        : "docker-engine",
      product,
      version: versionRecord?.Server?.Version,
      apiVersion: versionRecord?.Server?.ApiVersion,
      operatingSystem,
      osType: infoRecord.OSType,
      architecture: infoRecord.Architecture,
    },
    containerRuntime: {
      name: defaultRuntime,
      version: runtimeComponent?.Version,
    },
    containerdVersion: containerdComponent?.Version,
  };
};
const buildImage = async (plan, signal) => {
  await preparedImageFor(plan.baseImage, signal);
  const context = stageBuildContext(plan);
  return buildPreparedDockerImage(preparedDockerClient, {
    buildArguments: { BASE_IMAGE: plan.baseImage },
    context,
    dockerfile: "Dockerfile",
    labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": plan.runId,
    },
    maximumMilliseconds: Math.min(
      scenarioTimeoutMilliseconds,
      IMAGE_PREPARATION_LIMITS.maximumPreparationMilliseconds,
    ),
    signal,
    tag: plan.imageTag,
  });
};
const buildMockServerImage = async (plan, signal) => {
  await preparedImageFor(plan.mockServerImage, signal);
  const context = resolve(artifactsRoot, "contexts", plan.runId);
  return buildPreparedDockerImage(preparedDockerClient, {
    buildArguments: { MOCKSERVER_IMAGE: plan.mockServerImage },
    context,
    dockerfile: "MockServer.Dockerfile",
    labels: {
      "com.agentscope.integration": "true",
      "com.agentscope.integration.run": plan.runId,
    },
    maximumMilliseconds: Math.min(
      scenarioTimeoutMilliseconds,
      IMAGE_PREPARATION_LIMITS.maximumPreparationMilliseconds,
    ),
    signal,
    tag: plan.mockServerImageTag,
  });
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
    { mutationCapable: true },
  );
};
const startCollector = async (plan, signal) => {
  await dockerWithSignal(
    [
      "create",
      "--platform",
      canonicalImagePlatform,
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
      ...sidecarResourceArguments(
        ISOLATION_EXECUTOR_LIMITS.containers.collector,
      ),
      "--user",
      "1000:1000",
      ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers.collector),
      "--env",
      `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
      "--env",
      `AGENTSCOPE_MAXIMUM_REQUEST_BYTES=${ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes}`,
      plan.imageTag,
      "node",
      "/opt/agentscope/destination-server.mjs",
      "ingestion",
    ],
    signal,
    { mutationCapable: true },
  );
  await assertContainer(
    plan,
    plan.collectorName,
    ISOLATION_EXECUTOR_LIMITS.containers.collector,
    signal,
    ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes,
  );
  await dockerWithSignal(["start", plan.collectorName], signal, {
    mutationCapable: true,
  });
};
const startRetrieval = async (plan, signal) => {
  await dockerWithSignal(
    [
      "create",
      "--platform",
      canonicalImagePlatform,
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
      ...sidecarResourceArguments(
        ISOLATION_EXECUTOR_LIMITS.containers.retrieval,
      ),
      "--user",
      "1000:1000",
      ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers.retrieval),
      "--env",
      `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
      "--env",
      `AGENTSCOPE_MAXIMUM_REQUEST_BYTES=${ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes}`,
      plan.imageTag,
      "node",
      "/opt/agentscope/destination-server.mjs",
      "retrieval",
    ],
    signal,
    { mutationCapable: true },
  );
  await assertContainer(
    plan,
    plan.retrievalName,
    ISOLATION_EXECUTOR_LIMITS.containers.retrieval,
    signal,
    ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes,
  );
  await dockerWithSignal(["start", plan.retrievalName], signal, {
    mutationCapable: true,
  });
};
const startMockServer = async (plan, signal) => {
  await dockerWithSignal(
    [
      "create",
      "--platform",
      canonicalImagePlatform,
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
      ...sidecarResourceArguments(
        ISOLATION_EXECUTOR_LIMITS.containers.mockServer,
      ),
      ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers.mockServer, false),
      "--env",
      "MOCKSERVER_INITIALIZATION_JSON_PATH=/config/expectations.json",
      "--env",
      "MOCKSERVER_LOG_LEVEL=WARN",
      plan.mockServerImageTag,
    ],
    signal,
    { mutationCapable: true },
  );
  await assertContainer(
    plan,
    plan.mockServerName,
    ISOLATION_EXECUTOR_LIMITS.containers.mockServer,
    signal,
  );
  await dockerWithSignal(["start", plan.mockServerName], signal, {
    mutationCapable: true,
  });
};
const runScenario = async (plan, signal) => {
  const remainingOuterMilliseconds = Math.min(
    scenarioTimeoutMilliseconds,
    capability.binding.cleanupStartMonotonicMilliseconds - performance.now(),
  );
  if (remainingOuterMilliseconds < 40_000)
    throw new Error("integration.isolation.headless-authority");
  const outerMonotonicDeadline =
    linuxBootMonotonicMilliseconds() + remainingOuterMilliseconds - 10_000;
  const testModeArguments =
    testMode === undefined
      ? []
      : ["--env", `AGENTSCOPE_INTEGRATION_TEST_MODE=${testMode}`];
  await dockerWithSignal(
    [
      "create",
      "--platform",
      canonicalImagePlatform,
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
      "--env",
      `AGENTSCOPE_INTEGRATION_RUN_ID=${plan.runId}`,
      "--env",
      `AGENTSCOPE_HEADLESS_OUTER_MONOTONIC_DEADLINE_MS=${outerMonotonicDeadline}`,
      ...testModeArguments,
      plan.imageTag,
    ],
    signal,
    { mutationCapable: true },
  );
  await assertContainer(
    plan,
    plan.scenarioName,
    ISOLATION_EXECUTOR_LIMITS.containers.scenario,
    signal,
  );
  if (testMode === "sidecar-failure")
    await dockerWithSignal(["stop", plan.collectorName], signal, {
      mutationCapable: true,
    });
  try {
    const { stdout } = await dockerWithSignal(
      ["start", "--attach", plan.scenarioName],
      signal,
      { mutationCapable: true },
    );
    const receipt = captureHeadlessReceipt(stdout, plan, {
      outerMonotonicDeadline,
    });
    registerIntegrationHeadlessReceipt(receipt, performance.now());
    return {
      receipt,
      succeeded:
        receipt.outcome === "exited" &&
        receipt.exitCode === 0 &&
        receipt.signal === null &&
        receipt.cleanup === "clean" &&
        receipt.residualProcessCount === 0 &&
        receipt.processJoined === true &&
        receipt.stdinJoined === true &&
        receipt.stdoutJoined === true &&
        receipt.stderrJoined === true &&
        captureFixtureResult(stdout, plan),
    };
  } catch (error) {
    const output = `${error?.stdout ?? ""}`;
    captureFixtureResult(output, plan);
    if (output.includes("AGENTSCOPE_HEADLESS_RECEIPT=")) {
      const receipt = captureHeadlessReceipt(output, plan, {
        outerMonotonicDeadline,
      });
      registerIntegrationHeadlessReceipt(receipt, performance.now());
      return { receipt, succeeded: false };
    }
    throw error;
  }
};
const recordEvidence = async (evidence) => {
  const verifiedEvidence = compileIsolationEvidence(evidence, {
    baseImageIdentity: preparedIdentityFor(evidence.baseImage),
    mockServerImageIdentity: preparedIdentityFor(evidence.mockServerImage),
  });
  const directory = resolve(artifactsRoot, "runs", verifiedEvidence.runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "evidence.json"),
    `${JSON.stringify(verifiedEvidence, undefined, 2)}\n`,
  );
  scenarioOutcomes.set(verifiedEvidence.runId, verifiedEvidence.outcome);
  const diagnostic = preparedDockerClientDiagnostic(preparedDockerClient);
  if (diagnostic !== undefined)
    writeFileSync(
      resolve(directory, "diagnostic.json"),
      `${JSON.stringify(diagnostic, undefined, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  const result = fixtureResults.get(verifiedEvidence.runId);
  if (
    verifiedEvidence.outcome === "passed" &&
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
    fixtureResults.delete(verifiedEvidence.runId);
  }
};

const failureCode = (error) =>
  error instanceof Error && /^integration\.[a-z.-]{1,96}$/u.test(error.message)
    ? error.message
    : "integration.controller.failed";
const finalizeControllerFailureEvidence = (
  plan,
  primaryError,
  cleanupError,
) => {
  const directory = resolve(artifactsRoot, "runs", plan.runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const record = {
    controllerFailureEvidenceVersion: 1,
    runId: plan.runId,
    scenarioOutcome: scenarioOutcomes.get(plan.runId) ?? "not-complete",
    controllerOutcome: "retired-failure",
    primaryFailure: failureCode(primaryError),
    cleanupFailure:
      cleanupError === undefined ? null : failureCode(cleanupError),
    privateCleanup:
      preparedDockerClientDiagnostic(preparedDockerClient) ?? null,
  };
  const serialized = `${JSON.stringify(record, undefined, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 16_384)
    throw new Error("integration.controller.failure-evidence");
  const target = resolve(directory, "controller-failure.json");
  const temporary = resolve(
    directory,
    `.controller-failure.${process.pid}.tmp`,
  );
  let descriptor;
  let directoryDescriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
    rmSync(temporary);
    directoryDescriptor = openSync(directory, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
    const status = lstatSync(target);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size !== Buffer.byteLength(serialized, "utf8") ||
      (status.mode & 0o7777) !== 0o600
    )
      throw new Error("integration.controller.failure-evidence");
    const identity = Object.freeze({
      dev: status.dev,
      digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
      ino: status.ino,
      runId: plan.runId,
      size: status.size,
    });
    registerIntegrationFailureEvidence(identity);
    return identity;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error("integration.controller.failure-evidence", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
};
const publishControllerFailureManifest = (identities) => {
  const record = {
    controllerFailureManifestVersion: 1,
    controllerAuthorityDigest:
      capability.binding.privateStorage.authorityDigest,
    runIds: identities.map(({ runId }) => runId).sort(),
    failureEvidence: [...identities].sort((left, right) =>
      left.runId.localeCompare(right.runId),
    ),
  };
  const serialized = `${JSON.stringify(record, undefined, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 65_536)
    throw new Error("integration.controller.failure-evidence");
  const target = resolve(artifactsRoot, "controller-failure-manifest.json");
  const temporary = resolve(
    artifactsRoot,
    `.controller-failure-manifest.${process.pid}.tmp`,
  );
  let descriptor;
  let directoryDescriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    writeFileSync(descriptor, serialized);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
    rmSync(temporary);
    directoryDescriptor = openSync(artifactsRoot, constants.O_RDONLY);
    fsyncSync(directoryDescriptor);
    const status = lstatSync(target);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size !== Buffer.byteLength(serialized, "utf8") ||
      (status.mode & 0o7777) !== 0o600
    )
      throw new Error("integration.controller.failure-evidence");
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error("integration.controller.failure-evidence", {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
};
const countDockerResources = async (kind, plan, signal) => {
  const { stdout } = await dockerWithSignal(
    [
      kind,
      "ls",
      "--quiet",
      "--filter",
      "label=com.agentscope.integration=true",
      "--filter",
      `label=com.agentscope.integration.run=${plan.runId}`,
      ...(kind === "container" ? ["--all"] : []),
    ],
    signal,
    { timeout: ISOLATION_EXECUTOR_LIMITS.cleanup.proofMilliseconds },
  );
  return stdout.trim() === "" ? 0 : stdout.trim().split("\n").length;
};
const createDriver = () => {
  let removalSignal;
  let runtimeIdentity;
  const boundedRemovalSignal = () => {
    removalSignal ??= AbortSignal.timeout(
      ISOLATION_EXECUTOR_LIMITS.cleanup.removalMilliseconds,
    );
    return removalSignal;
  };
  return {
    inspectExecutionPolicy: async (_plan, signal) => {
      runtimeIdentity ??= inspectDockerRuntimeIdentity(signal);
      return {
        policyVersion: 1,
        runtimeInspection: {
          outcome: "complete",
          identity: await runtimeIdentity,
        },
        selection: executorSelection,
        maximumParallelScenarios: scenarioConcurrency,
        scenarioTimeoutMilliseconds,
        cleanupTimeouts: ISOLATION_EXECUTOR_LIMITS.cleanup,
        containers: ISOLATION_EXECUTOR_LIMITS.containers,
        requests: ISOLATION_EXECUTOR_LIMITS.requests,
      };
    },
    buildImage,
    buildMockServerImage,
    createNetwork,
    startCollector,
    startRetrieval,
    startMockServer,
    runScenario,
    recordEvidence,
    removeContainer: (name) =>
      ignoreMissing(["rm", "--force", name], boundedRemovalSignal()),
    removeNetwork: (name) =>
      ignoreMissing(["network", "rm", name], boundedRemovalSignal()),
    removeImage: (tag) =>
      ignoreMissing(["image", "rm", "--force", tag], boundedRemovalSignal()),
    removeContext: async (runId) => {
      if (!/^[a-f\d]{16}$/u.test(runId))
        throw new Error("integration.isolation.context");
      rmSync(resolve(artifactsRoot, "contexts", runId), {
        force: true,
        recursive: true,
      });
      rmSync(activeMarkerFor(runId), { force: true });
    },
    inspectCleanup: async (plan) => {
      const signal = AbortSignal.timeout(
        ISOLATION_EXECUTOR_LIMITS.cleanup.proofMilliseconds,
      );
      const [containers, networks, images, volumes] = await Promise.all([
        countDockerResources("container", plan, signal),
        countDockerResources("network", plan, signal),
        countDockerResources("image", plan, signal),
        countDockerResources("volume", plan, signal),
      ]);
      return {
        containers,
        networks,
        images,
        volumes,
        buildContexts: existsSync(
          resolve(artifactsRoot, "contexts", plan.runId),
        )
          ? 1
          : 0,
        activeRunMarkers: existsSync(activeMarkerFor(plan.runId)) ? 1 : 0,
      };
    },
  };
};

const scenarios = selectedScenarios.map((scenario) => {
  if (
    scenario.modelRoutes.some(
      (routeId) => !modelRoutes.routeIds.includes(routeId),
    )
  )
    throw new Error("integration.isolation.model-routes");
  return scenario;
});
const preparedIdentityFor = (image) => {
  const prepared = preparedImageEvidence.images.find(
    (candidate) => candidate.image === image,
  );
  if (prepared === undefined) throw new Error("integration.isolation.inputs");
  return {
    image: prepared.image,
    platform: prepared.platform,
    manifestDigest: prepared.manifestDigest,
    configDigest: prepared.configDigest,
  };
};
const plans = scenarios.map((scenario) =>
  createIsolationPlan({
    scenario,
    manifestIdentity: manifest.manifestIdentity,
    candidate,
    runToken: randomBytes(8).toString("hex"),
    baseImageIdentity: preparedIdentityFor(scenario.image),
    mockServerImageIdentity: preparedIdentityFor(scenario.mockServerImage),
    selection: executorSelection,
    maximumParallelScenarios: scenarioConcurrency,
    scenarioTimeoutMilliseconds,
  }),
);
registerIntegrationRunIds(plans.map(({ runId }) => runId));
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
preparedDockerClient = createPreparedDockerClient(preparedImageEvidence, {
  dockerEnvironment: capability.binding.dockerEnvironment,
  dockerExecutable: capability.binding.dockerExecutable,
});
let retirementRequired = false;
let primaryError;
try {
  await activateRuns(plans);
  const evidence = await mapWithConcurrency(
    plans,
    scenarioConcurrency,
    (plan) =>
      executeIsolationPlan(
        plan,
        createDriver(),
        AbortSignal.any([
          controller.signal,
          integrationStageSignal(),
          AbortSignal.timeout(scenarioTimeoutMilliseconds),
        ]),
      ),
  );
  console.log(JSON.stringify(evidence));
} catch (error) {
  if (
    preparedDockerClient !== undefined &&
    preparedDockerClientRequiresOuterHostRetirement(preparedDockerClient)
  ) {
    retirementRequired = true;
    primaryError = new Error("integration.controller.unsettled-operation", {
      cause: error,
    });
  } else {
    primaryError = error;
  }
} finally {
  for (const plan of plans)
    rmSync(activeMarkerFor(plan.runId), { force: true });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  let cleanupError;
  if (preparedDockerClient !== undefined && !retirementRequired) {
    try {
      closePreparedDockerClient(preparedDockerClient);
    } catch (error) {
      cleanupError = error;
      primaryError ??= error;
    }
  }
  if (primaryError !== undefined) {
    try {
      requireIntegrationFailureEvidence(plans.map(({ runId }) => runId));
      const identities = plans.map((plan) =>
        finalizeControllerFailureEvidence(plan, primaryError, cleanupError),
      );
      publishControllerFailureManifest(identities);
    } catch {
      // The original controller failure remains primary. The workflow's
      // always-run exact verifier independently fails if evidence is absent.
    }
  }
}
if (primaryError !== undefined) throw primaryError;
