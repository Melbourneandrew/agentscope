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
import { resolve } from "node:path";
import { promisify } from "node:util";

import {
  compileCapabilityManifest,
  createIsolationPlan,
  executeIsolationPlan,
  verifyPreparedCandidate,
} from "./dist/index.js";

const execute = promisify(execFile);
const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const manifest = compileCapabilityManifest(
  readJson(resolve(integrationRoot, "capability-manifest.json")),
);
const selection = readJson(resolve(artifactsRoot, "current-selection.json"));
const pointer = readJson(resolve(artifactsRoot, "current-candidate.json"));
const imageEvidence = readJson(resolve(artifactsRoot, "current-images.json"));
const modelRoutes = readJson(
  resolve(artifactsRoot, "current-model-routes.json"),
);
const testMode = process.env.AGENTSCOPE_INTEGRATION_TEST_MODE;
if (
  testMode !== undefined &&
  testMode !== "failure" &&
  testMode !== "interruption"
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
    ...options,
  });
const ignoreMissing = async (arguments_) => {
  try {
    await docker(arguments_);
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

const stageBuildContext = (plan) => {
  const context = resolve(artifactsRoot, "contexts", plan.runId);
  rmSync(context, { force: true, recursive: true });
  mkdirSync(resolve(context, "prepared/candidates"), { recursive: true });
  const sources = [
    ["runner.mjs", resolve(integrationRoot, "runner.mjs")],
    ["collector-server.mjs", resolve(integrationRoot, "collector/server.mjs")],
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
    cpSync(source, resolve(context, destination));
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
      "COPY runner.mjs collector-server.mjs capability-manifest.json current-selection.json current-model-routes.json ./",
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

const assertContainer = async (plan) => {
  const { stdout } = await docker(["container", "inspect", plan.scenarioName]);
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

const modelLedgers = new Map();
const preparedImageFor = async (image) => {
  const prepared = imageEvidence.images.find((entry) => entry.image === image);
  if (!prepared) throw new Error("integration.isolation.base-image");
  const { stdout } = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  if (stdout.trim().replace(":", "-") !== prepared.localImageDigest)
    throw new Error("integration.isolation.base-image");
};
const inspectImage = async (tag) => {
  const { stdout } = await docker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    tag,
  ]);
  return stdout.trim().replace(":", "-");
};
const buildImage = async (plan) => {
  await preparedImageFor(plan.baseImage);
  const context = stageBuildContext(plan);
  await docker([
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
  ]);
  return inspectImage(plan.imageTag);
};
const buildMockServerImage = async (plan) => {
  await preparedImageFor(plan.mockServerImage);
  const context = resolve(artifactsRoot, "contexts", plan.runId);
  await docker([
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
  ]);
  return inspectImage(plan.mockServerImageTag);
};
const createNetwork = async (plan) => {
  await docker([
    "network",
    "create",
    "--internal",
    ...labelArguments(plan),
    plan.networkName,
  ]);
};
const startCollector = async (plan) => {
  await docker([
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
    "--user",
    "1000:1000",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000",
    plan.imageTag,
    "node",
    "/opt/agentscope/collector-server.mjs",
  ]);
  await docker(["start", plan.collectorName]);
};
const startMockServer = async (plan) => {
  await docker([
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
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--env",
    "MOCKSERVER_INITIALIZATION_JSON_PATH=/config/expectations.json",
    "--env",
    "MOCKSERVER_LOG_LEVEL=WARN",
    plan.mockServerImageTag,
  ]);
  await docker(["start", plan.mockServerName]);
};
const runScenario = async (plan, signal) => {
  const testModeArguments =
    testMode === undefined
      ? []
      : ["--env", `AGENTSCOPE_INTEGRATION_TEST_MODE=${testMode}`];
  await docker([
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
    "AGENTSCOPE_MODEL_SERVER_URL=http://mockserver:1080",
    "--env",
    `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
    ...testModeArguments,
    plan.imageTag,
  ]);
  await assertContainer(plan);
  const { stdout } = await docker(["start", "--attach", plan.scenarioName], {
    signal,
  });
  const ledgerLine = stdout
    .split("\n")
    .find((line) => line.startsWith("AGENTSCOPE_MODEL_LEDGER="));
  if (!ledgerLine) throw new Error("integration.isolation.model-ledger");
  modelLedgers.set(
    plan.runId,
    JSON.parse(
      Buffer.from(
        ledgerLine.slice("AGENTSCOPE_MODEL_LEDGER=".length),
        "base64url",
      ).toString("utf8"),
    ),
  );
};
const recordEvidence = async (evidence) => {
  const directory = resolve(artifactsRoot, "runs", evidence.runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "evidence.json"),
    `${JSON.stringify(evidence, undefined, 2)}\n`,
  );
  if (evidence.outcome === "passed") {
    const ledger = modelLedgers.get(evidence.runId);
    if (
      ledger?.ledgerVersion !== 1 ||
      ledger.scenarioId !== evidence.scenarioId ||
      !Array.isArray(ledger.entries)
    )
      throw new Error("integration.isolation.model-ledger");
    writeFileSync(
      resolve(directory, "model-ledger.json"),
      `${JSON.stringify(ledger, undefined, 2)}\n`,
    );
    modelLedgers.delete(evidence.runId);
  }
};
const createDriver = () => ({
  buildImage,
  buildMockServerImage,
  createNetwork,
  startCollector,
  startMockServer,
  runScenario,
  recordEvidence,
  removeContainer: (name) => ignoreMissing(["rm", "--force", name]),
  removeNetwork: (name) => ignoreMissing(["network", "rm", name]),
  removeImage: (tag) => ignoreMissing(["image", "rm", "--force", tag]),
});

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
  const evidence = await Promise.all(
    scenarios.map((scenario) =>
      executeIsolationPlan(
        createIsolationPlan({
          scenario,
          manifestIdentity: manifest.manifestIdentity,
          candidate,
          runToken: randomBytes(8).toString("hex"),
        }),
        createDriver(),
        controller.signal,
      ),
    ),
  );
  console.log(JSON.stringify(evidence));
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
