/* eslint import-x/no-cycle: "off" -- private executable capability */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
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
  markPreparedDockerClientForOuterHostRetirement,
  preparedDockerClientRequiresOuterHostRetirement,
  readPreparedImageEvidence,
  revalidatePreparedImageAdmission,
} from "./image-preparation.mjs";
import { acquireIntegrationOperationLock } from "./operation-lock.mjs";
import {
  integrationStageSignal,
  registerIntegrationRunIds,
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
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    if (!/(?:No such (?:container|image)|network .* not found)/u.test(output)) {
      markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
      throw error;
    }
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
    if (!captureFixtureResult(stdout, plan))
      throw new Error("integration.isolation.fixture-result");
  } catch (error) {
    captureFixtureResult(`${error?.stdout ?? ""}`, plan);
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
    throw new Error("integration.controller.unsettled-operation", {
      cause: error,
    });
  }
  throw error;
} finally {
  for (const plan of plans)
    rmSync(activeMarkerFor(plan.runId), { force: true });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  if (preparedDockerClient !== undefined && !retirementRequired)
    closePreparedDockerClient(preparedDockerClient);
}
