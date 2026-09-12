/* eslint import-x/no-cycle: "off" -- private executable capability */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  cpSync,
  fstatSync,
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
  compileHarnessAdmissionCompletion,
  compileHarnessAdmissionSeed,
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
  BUILDKIT_IMAGE,
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
import {
  inspectPreparedHarnessMaterial,
  prepareHarnessMaterial,
  retirePreparedHarnessMaterial,
  stagePreparedHarnessMaterial,
} from "./harness-material.mjs";
import { acquireIntegrationOperationLock } from "./operation-lock.mjs";
import {
  compileCandidateInventory,
  compileImmutableCandidateHandoff,
  decodeInteractivePtyReceipt,
  decodeInstalledPtyFailureReceipt,
  decodeInstalledCliPtyReceipt,
  selectedRuntimeFiles,
  validateImmutableScenarioContainer,
} from "./immutable-candidate-authority.mjs";
import {
  integrationStageSignal,
  beginRealHarnessAdmission,
  compileRealHarnessSupportEvidence,
  completeRealHarnessAdmission,
  configureRealHarnessAdmissionSources,
  registerIntegrationFailureEvidence,
  registerIntegrationArtifactFile,
  registerIntegrationHeadlessReceipt,
  registerIntegrationPtyReceipt,
  registerIntegrationRunIds,
  registerSubstrateCertificationPredicate,
  registerSubstrateCertificationProjection,
  requireIntegrationFailureEvidence,
  remainingIntegrationOperationMilliseconds,
  requireDisposableOuterHostCapability,
  requireSubstrateCertificationCase,
  requireSubstrateCertificationReplay,
} from "./dist/controller.js";
import {
  leakedChildReadinessWasObserved,
  SUBSTRATE_CERTIFICATION_PREDICATES,
} from "./dist/substrate-certification.js";

const capability = requireDisposableOuterHostCapability();
const substrateCertificationCase = requireSubstrateCertificationCase();
const substrateCertificationReplay = requireSubstrateCertificationReplay();
const canonicalImagePlatform = `${IMAGE_PREPARATION_EXECUTION_POLICY.platform.os}/${IMAGE_PREPARATION_EXECUTION_POLICY.platform.architecture}`;

const execute = promisify(execFile);
const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const installedPtyFailures = new Map();
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
  testMode !== undefined &&
  (substrateCertificationCase !== undefined ||
    substrateCertificationReplay !== undefined)
)
  throw new Error("integration.certification.request");
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
const evidenceById = new Map(
  manifest.evidence.map((evidence) => [evidence.evidenceId, evidence]),
);
const preparedHarnessMaterials = new Map();
const admissionMaterialRecords = new WeakMap();
const admissionTerminalRecords = new WeakMap();
configureRealHarnessAdmissionSources(
  Object.freeze({
    authenticateMaterial: (authority) =>
      admissionMaterialRecords.get(authority),
    authenticateTerminal: (authority) =>
      admissionTerminalRecords.get(authority),
  }),
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

// The exact staged inventory and Dockerfile are reviewed as one authority.
// eslint-disable-next-line max-lines-per-function
const stageBuildContext = (plan) => {
  const context = resolve(artifactsRoot, "contexts", plan.runId);
  rmSync(context, { force: true, recursive: true });
  mkdirSync(resolve(context, "prepared/candidates"), { recursive: true });
  mkdirSync(resolve(context, "runtime"), { recursive: true });
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === plan.scenarioId,
  );
  if (scenario === undefined) throw new Error("integration.isolation.context");
  const evidence = evidenceById.get(scenario.harnessEvidenceId);
  if (evidence === undefined) throw new Error("integration.isolation.context");
  const harnessMaterial = preparedHarnessMaterials.get(
    scenario.harnessEvidenceId,
  );
  if (
    (evidence.material.kind !== "certification-fixture") !==
    (harnessMaterial !== undefined)
  )
    throw new Error("integration.isolation.context");
  const sources = [
    ["runner.mjs", resolve(integrationRoot, "runner.mjs")],
    [
      "immutable-candidate-authority.mjs",
      resolve(integrationRoot, "immutable-candidate-authority.mjs"),
    ],
    [
      "pty-installed-cli-driver.mjs",
      resolve(integrationRoot, "pty-installed-cli-driver.mjs"),
    ],
    [
      "retained-fixture-result.mjs",
      resolve(integrationRoot, "retained-fixture-result.mjs"),
    ],
    [
      "destination-server.mjs",
      resolve(integrationRoot, "destination-server.mjs"),
    ],
    [
      "scenario-process.mjs",
      resolve(integrationRoot, scenario.scenarioProcess.path),
      scenario.scenarioProcess.sha256,
    ],
    [
      "substrate-certification.js",
      resolve(integrationRoot, "dist/substrate-certification.js"),
    ],
    [
      "fixtures/substrate-negative-process.mjs",
      resolve(integrationRoot, "fixtures/substrate-negative-process.mjs"),
    ],
    [
      "scenario-oracle.mjs",
      resolve(integrationRoot, scenario.scenarioOracle.path),
      scenario.scenarioOracle.sha256,
    ],
    [
      "scenario-adapter.mjs",
      resolve(integrationRoot, scenario.fixtureAdapter.path),
      scenario.fixtureAdapter.sha256,
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
  for (const file of selectedRuntimeFiles) {
    if (sources.some(([destination]) => destination === file)) continue;
    sources.push([
      file,
      resolve(
        workspaceRoot,
        "packages/testkit/dist",
        file.slice("testkit/".length),
      ),
    ]);
  }
  for (const artifact of scenario.runtimeArtifacts) {
    sources.push([
      `runtime/${artifact.destination}`,
      resolve(
        artifact.source.kind === "integration"
          ? integrationRoot
          : workspaceRoot,
        artifact.source.path,
      ),
      artifact.sha256,
    ]);
  }
  for (const [destination, source, expectedDigest] of sources) {
    const status = lstatSync(source);
    if (!status.isFile() || status.isSymbolicLink())
      throw new Error("integration.isolation.context");
    const target = resolve(context, destination);
    mkdirSync(dirname(target), { recursive: true });
    const descriptor = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = fstatSync(descriptor);
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (
        !before.isFile() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.size !== bytes.byteLength ||
        (expectedDigest !== undefined &&
          createHash("sha256").update(bytes).digest("hex") !== expectedDigest)
      )
        throw new Error("integration.isolation.context");
      writeFileSync(target, bytes, {
        flag: "wx",
        mode: before.mode & 0o777,
      });
    } finally {
      closeSync(descriptor);
    }
  }
  cpSync(
    candidateDirectory,
    resolve(context, "prepared/candidates", candidate.bundleIdentity),
    { recursive: true },
  );
  if (harnessMaterial !== undefined) {
    const materialTarget = resolve(context, "harness-material");
    stagePreparedHarnessMaterial(harnessMaterial, materialTarget);
    const authority = inspectPreparedHarnessMaterial(harnessMaterial);
    if (authority.kind === "npm") {
      mkdirSync(resolve(context, "harness"), { recursive: true });
      const dependencies = Object.fromEntries(
        evidence.material.kind === "npm"
          ? evidence.material.packages.map(
              ({ installName, packageName, version }) => {
                const packageAuthority = authority.packages.find(
                  (entry) =>
                    entry.installName === installName &&
                    entry.packageName === packageName &&
                    entry.version === version,
                );
                if (packageAuthority === undefined)
                  throw new Error("integration.isolation.context");
                return [
                  installName,
                  `file:/opt/agentscope/harness-material/${packageAuthority.fileName}`,
                ];
              },
            )
          : [],
      );
      writeFileSync(
        resolve(context, "harness/package.json"),
        `${JSON.stringify({ name: "agentscope-harness-runtime", version: "1.0.0", private: true, dependencies })}\n`,
      );
    }
  }
  const harnessAuthority =
    harnessMaterial === undefined
      ? undefined
      : inspectPreparedHarnessMaterial(harnessMaterial);
  const harnessInstall =
    harnessAuthority === undefined
      ? []
      : harnessAuthority.kind === "npm"
        ? [
            "COPY harness-material ./harness-material",
            "COPY harness ./harness",
            'RUN --network=none ["/usr/local/bin/node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "install", "--prefix", "/opt/agentscope/harness", "--ignore-scripts", "--offline", "--audit=false", "--fund=false", "--package-lock=false", "--userconfig=/dev/null", "--globalconfig=/dev/null", "--cache=/tmp/agentscope-harness-npm-cache"]',
          ]
        : [
            `COPY --chmod=0755 harness-material/${harnessAuthority.binary.fileName} /usr/local/bin/${harnessAuthority.binary.executableName}`,
          ];
  writeFileSync(
    resolve(context, "Dockerfile"),
    [
      "ARG BASE_IMAGE",
      "FROM ${BASE_IMAGE}",
      "WORKDIR /opt/agentscope",
      "COPY runner.mjs immutable-candidate-authority.mjs pty-installed-cli-driver.mjs retained-fixture-result.mjs destination-server.mjs scenario-process.mjs scenario-oracle.mjs scenario-adapter.mjs substrate-certification.js capability-manifest.json current-selection.json current-model-routes.json ./",
      "COPY runtime ./runtime",
      "COPY fixtures ./fixtures",
      "COPY testkit ./testkit",
      "COPY prepared ./prepared",
      ...harnessInstall,
      `RUN ["/usr/local/bin/node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "install", "--prefix", "/opt/agentscope/installed", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "./prepared/candidates/${candidate.bundleIdentity}/files/${cliArtifact.fileName}"]`,
      "USER node",
      'CMD ["node", "/opt/agentscope/runner.mjs"]',
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(context, "mockserver-initialization.json"),
    `${JSON.stringify(
      scenario.modelRoutes.map((routeId) => {
        const index = modelRoutes.routeIds.indexOf(routeId);
        if (
          index < 0 ||
          modelRoutes.routeIds.lastIndexOf(routeId) !== index ||
          modelRoutes.mockServerInitialization[index] === undefined
        )
          throw new Error("integration.isolation.context");
        return modelRoutes.mockServerInitialization[index];
      }),
      undefined,
      2,
    )}\n`,
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
  immutableCandidate,
  // eslint-disable-next-line complexity,max-params
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
  const immutableCandidateMatches =
    immutableCandidate === undefined ||
    (container?.Image === immutableCandidate.imageId &&
      container?.Config?.User === "1000:1000" &&
      environment.includes(
        `AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${immutableCandidate.encoded}`,
      ) &&
      JSON.stringify(container?.HostConfig?.CapDrop) ===
        JSON.stringify(["ALL"]) &&
      Array.isArray(container?.HostConfig?.SecurityOpt) &&
      container.HostConfig.SecurityOpt.includes("no-new-privileges"));
  let imageConfigMatches = immutableCandidate === undefined;
  if (immutableCandidate !== undefined) {
    const inspected = await dockerWithSignal(
      ["image", "inspect", immutableCandidate.imageId],
      signal,
    );
    try {
      const records = JSON.parse(inspected.stdout);
      imageConfigMatches =
        Array.isArray(records) &&
        records.length === 1 &&
        records[0]?.Id === immutableCandidate.imageId &&
        createHash("sha256")
          .update(JSON.stringify(records[0]?.Config))
          .digest("hex") === immutableCandidate.imageConfigSha256;
      if (imageConfigMatches)
        validateImmutableScenarioContainer({
          container,
          handoff: immutableCandidate,
          image: records[0],
          networkName: plan.networkName,
          tmpfs,
        });
    } catch {
      imageConfigMatches = false;
    }
  }
  if (
    container?.HostConfig?.ReadonlyRootfs !== true ||
    container?.HostConfig?.NetworkMode !== plan.networkName ||
    container?.HostConfig?.Memory !== limits.memoryBytes ||
    container?.HostConfig?.PidsLimit !== limits.pidsLimit ||
    !Array.isArray(container?.Mounts) ||
    container.Mounts.length !== 0 ||
    JSON.stringify(tmpfsPaths) !== JSON.stringify(expectedPaths) ||
    !tmpfsMatches ||
    !requestLimitMatches ||
    !immutableCandidateMatches ||
    !imageConfigMatches
  )
    throw new Error("integration.isolation.container");
};

const createImmutableCandidateHandoff = async (plan, signal) => {
  const { stdout } = await dockerWithSignal(
    ["image", "inspect", plan.imageTag],
    signal,
  );
  let image;
  try {
    const records = JSON.parse(stdout);
    if (!Array.isArray(records) || records.length !== 1) throw new Error();
    [image] = records;
  } catch {
    throw new Error("integration.isolation.immutable-candidate");
  }
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(image?.Id) ||
    typeof image?.Config !== "object" ||
    image.Config === null
  )
    throw new Error("integration.isolation.immutable-candidate");
  return compileImmutableCandidateHandoff({
    candidate,
    image,
    plan: { runId: plan.runId, scenarioId: plan.scenarioId },
  });
};

const fixtureResults = new Map();
const scenarioOutcomes = new Map();
const observedCertificationRunIds = new Set();
const observeSubstrateCertificationPredicate = (runId, predicate) => {
  registerSubstrateCertificationPredicate(runId, predicate);
  observedCertificationRunIds.add(runId);
};
const fingerprintHeadlessRequest = (request) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex")}`;
const fingerprintSelectedPtyAuthority = (authority) =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(authority))
    .digest("hex")}`;
const diagnosticDigest = (value) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const admissionDigest = (value) =>
  `sha256-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const linuxBootMonotonicMilliseconds = () => {
  const source = readFileSync("/proc/uptime", "utf8");
  if (source.length > 128 || !/^\d+(?:\.\d+)?\s/u.test(source))
    throw new Error("integration.isolation.headless-clock");
  const value = Number(source.split(/\s/u, 1)[0]) * 1_000;
  if (!Number.isFinite(value) || value < 0)
    throw new Error("integration.isolation.headless-clock");
  return value;
};
const expectedHeadlessEnvironment = (plan, outerMonotonicDeadlineMs) => ({
  AGENTSCOPE_HOME: "/agentscope-home",
  AGENTSCOPE_CANDIDATE_ROOT: "/opt/agentscope/prepared",
  AGENTSCOPE_COLLECTOR_URL: "http://collector:4318",
  AGENTSCOPE_INGESTION_URL: "http://collector:4318",
  AGENTSCOPE_LEDGER: "/ledger",
  AGENTSCOPE_MODEL_SERVER_URL: "http://mockserver:1080",
  AGENTSCOPE_RETRIEVAL_URL: "http://retrieval:4319",
  AGENTSCOPE_SCENARIO_ID: plan.scenarioId,
  AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String(
    outerMonotonicDeadlineMs - 5_000,
  ),
  AGENTSCOPE_WORKTREE: "/worktree",
  HARNESS_HOME: "/harness-home",
  HOME: "/home/agentscope",
  LANG: "C.UTF-8",
  NO_COLOR: "1",
  PATH:
    evidenceById.get(
      manifest.scenarios.find(
        ({ scenarioId }) => scenarioId === plan.scenarioId,
      )?.harnessEvidenceId,
    )?.material.kind === "npm"
      ? "/opt/agentscope/harness/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
      : "/usr/local/bin:/usr/bin:/bin",
  XDG_CONFIG_HOME: "/harness-home",
  ...(testMode === undefined
    ? {}
    : { AGENTSCOPE_INTEGRATION_TEST_MODE: testMode }),
  ...(substrateCertificationCase === undefined
    ? {}
    : {
        AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE: substrateCertificationCase,
      }),
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
const expectedHeadlessRequest = (receipt, plan) => ({
  runId: plan.runId,
  executable: "/usr/local/bin/node",
  arguments: [
    "/opt/agentscope/scenario-process.mjs",
    "--artifact",
    `/opt/agentscope/prepared/candidates/${candidate.bundleIdentity}/files/${cliArtifact.fileName}`,
  ],
  cwd: "/opt/agentscope",
  environment: expectedHeadlessEnvironment(
    plan,
    receipt.outerMonotonicDeadlineMs,
  ),
  stdinBase64: "",
  stdoutLimitBytes: 1024 * 1024,
  stderrLimitBytes: 1024 * 1024,
  monotonicStartupDeadlineMs: Math.min(
    receipt.requestConstructedAtMs + 10_000,
    receipt.request.monotonicShutdownDeadlineMs - 5_000,
  ),
  monotonicExecutionDeadlineMs:
    receipt.request.monotonicShutdownDeadlineMs - 5_000,
  monotonicShutdownDeadlineMs:
    receipt.translationLocalAtMs +
    (receipt.outerMonotonicDeadlineMs - receipt.translationBootAtMs),
  terminationGraceMs: 1_000,
});
const serializedRequestMatches = (receipt, expected) =>
  JSON.stringify(receipt.request) === JSON.stringify(expected) &&
  receipt.returnedAtMs <= receipt.request.monotonicShutdownDeadlineMs &&
  receipt.requestFingerprint === fingerprintHeadlessRequest(receipt.request);
const expectedNegativeHeadlessRequest = (receipt, plan) => {
  const expected = expectedHeadlessRequest(receipt, plan);
  switch (substrateCertificationCase) {
    case "wrong-argv":
      return {
        ...expected,
        arguments: [...expected.arguments, "--unexpected"],
      };
    case "wrong-environment":
      return {
        ...expected,
        environment: { ...expected.environment, AGENTSCOPE_UNEXPECTED: "1" },
      };
    case "wrong-cwd":
      return { ...expected, cwd: "/tmp" };
    case "mixed-artifact-digest":
      return {
        ...expected,
        arguments: [
          "/opt/agentscope/scenario-process.mjs",
          "--artifact",
          `/opt/agentscope/prepared/candidates/${candidate.bundleIdentity}/files/${candidate.lockfile.fileName}`,
        ],
      };
    default:
      return undefined;
  }
};
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
        "killRequested",
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
        "termRequested",
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
    typeof receipt.termRequested !== "boolean" ||
    typeof receipt.killRequested !== "boolean"
  )
    throw new Error("integration.isolation.headless-receipt");
  const negativeExpected = expectedNegativeHeadlessRequest(receipt, plan);
  if (negativeExpected !== undefined) {
    if (!serializedRequestMatches(receipt, negativeExpected))
      throw new Error("integration.isolation.headless-receipt");
    observeSubstrateCertificationPredicate(
      plan.runId,
      SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase],
    );
    throw new Error(`integration.certification.${substrateCertificationCase}`);
  }
  if (
    !serializedRequestMatches(receipt, expectedHeadlessRequest(receipt, plan))
  )
    throw new Error("integration.isolation.headless-receipt");
  return Object.freeze(receipt);
};
// eslint-disable-next-line complexity -- exact closed receipt predicate
const interactivePtyProcessMatches = (processRequest, plan, receipt) => {
  const selectedScenario = manifest.scenarios.find(
    ({ scenarioId }) => scenarioId === plan.scenarioId,
  );
  if (selectedScenario === undefined) return false;
  const input = Buffer.from(selectedScenario.terminalInputBase64, "base64");
  const expectedRequest = {
    runId: plan.runId,
    executable: "/opt/agentscope/scenario-process.mjs",
    arguments: [
      "--artifact",
      `/opt/agentscope/prepared/candidates/${candidate.bundleIdentity}/files/${cliArtifact.fileName}`,
    ],
    cwd: "/opt/agentscope",
    environment: expectedHeadlessEnvironment(
      plan,
      receipt.outerMonotonicDeadlineMs,
    ),
    stdinBase64: input.toString("base64"),
    stdoutLimitBytes: 1024 * 1024,
    stderrLimitBytes: 1024 * 1024,
    monotonicStartupDeadlineMs: processRequest?.monotonicStartupDeadlineMs,
    monotonicExecutionDeadlineMs: processRequest?.monotonicExecutionDeadlineMs,
    monotonicShutdownDeadlineMs: processRequest?.monotonicShutdownDeadlineMs,
    terminationGraceMs: processRequest?.terminationGraceMs,
  };
  return (
    processRequest?.runId === plan.runId &&
    processRequest?.requestFingerprint ===
      fingerprintHeadlessRequest(expectedRequest) &&
    processRequest?.executable === "/opt/agentscope/scenario-process.mjs" &&
    JSON.stringify(processRequest?.arguments) ===
      JSON.stringify([
        "--artifact",
        `/opt/agentscope/prepared/candidates/${candidate.bundleIdentity}/files/${cliArtifact.fileName}`,
      ]) &&
    processRequest?.cwd === "/opt/agentscope" &&
    JSON.stringify(processRequest?.environment) ===
      JSON.stringify(
        expectedHeadlessEnvironment(plan, receipt.outerMonotonicDeadlineMs),
      ) &&
    processRequest?.inputBytes === input.length &&
    processRequest?.inputSha256 ===
      createHash("sha256").update(input).digest("hex") &&
    processRequest?.stdoutLimitBytes === 1024 * 1024 &&
    processRequest?.stderrLimitBytes === 1024 * 1024 &&
    processRequest?.monotonicStartupDeadlineMs ===
      Math.min(
        receipt.requestConstructedAtMs + 10_000,
        processRequest.monotonicShutdownDeadlineMs - 5_000,
      ) &&
    processRequest?.monotonicExecutionDeadlineMs ===
      processRequest.monotonicShutdownDeadlineMs - 5_000 &&
    processRequest?.terminationGraceMs === 1_000
  );
};
const interactivePtyEnvelopeMatches = (receipt, plan, expected) =>
  // eslint-disable-next-line complexity -- exact closed receipt predicate
  (() => {
    const selectedScenario = manifest.scenarios.find(
      ({ scenarioId }) => scenarioId === plan.scenarioId,
    );
    if (selectedScenario === undefined) return false;
    const input = Buffer.from(selectedScenario.terminalInputBase64, "base64");
    const initialInputBytes =
      input.length - selectedScenario.postCompletionInputByteLength;
    const expectedActions = [
      { action: "resize", geometry: { columns: 100, rows: 30 } },
      {
        action: "input",
        byteLength: initialInputBytes,
        inputSha256: createHash("sha256")
          .update(input.subarray(0, initialInputBytes))
          .digest("hex"),
      },
      ...(selectedScenario.waitForSemanticCompletionBeforeEof
        ? [
            { action: "wait-for-semantic-completion" },
            {
              action: "input",
              byteLength: selectedScenario.postCompletionInputByteLength,
              inputSha256: createHash("sha256")
                .update(input.subarray(initialInputBytes))
                .digest("hex"),
            },
          ]
        : []),
      ...(selectedScenario.waitForSemanticCompletionBeforeEof
        ? []
        : [{ action: "eof" }]),
    ];
    return (
      receipt?.receiptVersion === 1 &&
      receipt?.transport === "pty" &&
      receipt?.scenarioId === plan.scenarioId &&
      receipt?.runId === plan.runId &&
      receipt?.outerMonotonicDeadlineMs === expected.outerMonotonicDeadline &&
      linuxBootMonotonicMilliseconds() < expected.outerMonotonicDeadline &&
      receipt?.request?.completion?.kind === "semantic-marker" &&
      receipt?.request?.interaction?.trigger === "semantic-ready" &&
      JSON.stringify(receipt?.request?.interaction?.actions) ===
        JSON.stringify(expectedActions) &&
      JSON.stringify(receipt?.actions?.map(({ action }) => action)) ===
        JSON.stringify(expectedActions.map(({ action }) => action)) &&
      receipt?.isTTY === true &&
      receipt?.observedCanonicalMode === true
    );
  })();
const interactivePtyGeometryMatches = (receipt) =>
  JSON.stringify(receipt?.request?.initialGeometry) ===
    JSON.stringify({ columns: 80, rows: 24 }) &&
  JSON.stringify(receipt?.observedGeometry) ===
    JSON.stringify({ columns: 100, rows: 30 });
const interactivePtyArtifactAuthorityMatches = (receipt) =>
  receipt?.processRequestFingerprint ===
    receipt?.request?.process?.requestFingerprint &&
  receipt?.inputBytes === receipt?.request?.process?.inputBytes &&
  receipt?.inputSha256 === receipt?.request?.process?.inputSha256 &&
  receipt?.readinessObserved === true &&
  receipt?.request?.interpreter?.path === "/usr/local/bin/node" &&
  receipt?.request?.scriptSha256 ===
    createHash("sha256")
      .update(
        readFileSync(
          resolve(
            integrationRoot,
            manifest.scenarios.find(
              (scenario) => scenario.scenarioId === receipt.scenarioId,
            )?.scenarioProcess.path ?? "__invalid__",
          ),
        ),
      )
      .digest("hex");
const interactivePtyFingerprintMatches = (receipt) =>
  receipt?.requestFingerprint ===
  fingerprintSelectedPtyAuthority({
    processRequestFingerprint: receipt?.processRequestFingerprint,
    completion: receipt?.request?.completion,
    initialGeometry: receipt?.request?.initialGeometry,
    interaction: {
      actions: receipt?.request?.interaction?.actions,
      trigger: receipt?.request?.interaction?.trigger,
    },
    interpreter: receipt?.request?.interpreter,
    scriptSha256: receipt?.request?.scriptSha256,
    inputBytes: receipt?.inputBytes,
    inputSha256: receipt?.inputSha256,
  });
const interactivePtyTerminalMatches = (receipt) =>
  interactivePtyGeometryMatches(receipt) &&
  interactivePtyArtifactAuthorityMatches(receipt) &&
  interactivePtyFingerprintMatches(receipt) &&
  receipt?.returnedAtMs <=
    receipt?.request?.process?.monotonicShutdownDeadlineMs &&
  receipt?.finalSnapshot?.semanticState === "completed";
const captureInteractivePtyReceipt = (output, plan, expected) => {
  let receipt;
  try {
    receipt = decodeInteractivePtyReceipt(output);
  } catch {
    throw new Error("integration.isolation.pty-receipt");
  }
  const processRequest = receipt?.request?.process;
  if (
    !interactivePtyEnvelopeMatches(receipt, plan, expected) ||
    !interactivePtyProcessMatches(processRequest, plan, receipt) ||
    !interactivePtyTerminalMatches(receipt)
  )
    throw new Error("integration.isolation.pty-receipt");
  return Object.freeze(receipt);
};
const captureInstalledCliPtyReceipt = (output, plan) =>
  decodeInstalledCliPtyReceipt(output, {
    candidateBundleIdentity: candidate.bundleIdentity,
    candidateInventorySha256: compileCandidateInventory(candidate).sha256,
    runId: plan.runId,
    scenarioId: plan.scenarioId,
  });
const captureInstalledPtyFailure = (output, plan) => {
  const receipt = decodeInstalledPtyFailureReceipt(output);
  if (installedPtyFailures.has(plan.runId))
    throw new Error("integration.isolation.pty-failure-receipt");
  installedPtyFailures.set(plan.runId, receipt);
  return receipt;
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
    maximumBuildContextBytes: preparedHarnessMaterials.has(
      manifest.scenarios.find(
        ({ scenarioId }) => scenarioId === plan.scenarioId,
      )?.harnessEvidenceId,
    )
      ? IMAGE_PREPARATION_LIMITS.maximumHarnessBuildContextBytes
      : IMAGE_PREPARATION_LIMITS.defaultMaximumBuildContextBytes,
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
      ...(substrateCertificationCase === "public-egress" ? [] : ["--internal"]),
      ...labelArguments(plan),
      plan.networkName,
    ],
    signal,
    { mutationCapable: true },
  );
  const { stdout } = await dockerWithSignal(
    ["network", "inspect", plan.networkName],
    signal,
  );
  let network;
  try {
    const records = JSON.parse(stdout);
    if (!Array.isArray(records) || records.length !== 1) throw new Error();
    [network] = records;
  } catch {
    throw new Error("integration.isolation.network");
  }
  if (network?.Internal !== true) {
    if (substrateCertificationCase === "public-egress") {
      observeSubstrateCertificationPredicate(
        plan.runId,
        SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase],
      );
      throw new Error(
        `integration.certification.${substrateCertificationCase}`,
      );
    }
    throw new Error("integration.isolation.network");
  }
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
const createScenarioContainer = async (
  plan,
  signal,
  outerMonotonicDeadline,
  immutableCandidate,
) => {
  const testModeArguments =
    testMode === undefined
      ? []
      : ["--env", `AGENTSCOPE_INTEGRATION_TEST_MODE=${testMode}`];
  const certificationArguments =
    substrateCertificationCase === undefined
      ? []
      : [
          "--env",
          `AGENTSCOPE_SUBSTRATE_CERTIFICATION_CASE=${substrateCertificationCase}`,
        ];
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
      "--env",
      `AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${immutableCandidate.encoded}`,
      ...testModeArguments,
      ...certificationArguments,
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
    undefined,
    immutableCandidate,
  );
  if (testMode === "sidecar-failure")
    await dockerWithSignal(["stop", plan.collectorName], signal, {
      mutationCapable: true,
    });
};
const registerScenarioReceipt = (plan, receipt) => {
  if (plan.executionMode === "interactive")
    registerIntegrationPtyReceipt(receipt, performance.now());
  else registerIntegrationHeadlessReceipt(receipt, performance.now());
};
const scenarioReceiptSucceeded = (plan, receipt, installedPtyReceipt) => {
  const scenario = manifest.scenarios.find(
    ({ scenarioId }) => scenarioId === plan.scenarioId,
  );
  return (
    ((plan.executionMode === "headless" && receipt.outcome === "exited") ||
      (plan.executionMode === "interactive" &&
        receipt.outcome === "completed" &&
        receipt.finalSnapshot?.semanticState === "completed")) &&
    receipt.exitCode === 0 &&
    receipt.signal === null &&
    receipt.cleanup === "clean" &&
    receipt.residualProcessCount === 0 &&
    receipt.processJoined === true &&
    (plan.executionMode === "interactive" ||
      (receipt.stdinJoined === true &&
        receipt.stdoutJoined === true &&
        receipt.stderrJoined === true)) &&
    (plan.executionMode === "headless" ||
      ((scenario?.waitForSemanticCompletionBeforeEof === true
        ? receipt.eofByteWritten === false
        : receipt.eofByteWritten === true) &&
        receipt.terminalInputJoined === true &&
        receipt.terminalOutputJoined === true &&
        receipt.terminalTransportClosed === true)) &&
    installedPtyReceipt.outcome === "completed"
  );
};
const observeNegativeScenarioReceipt = (plan, receipt, fixtureCaptured) => {
  if (plan.executionMode !== "headless") return;
  const result = fixtureResults.get(plan.runId);
  let observed;
  switch (substrateCertificationCase) {
    case "missing-hook":
      observed =
        fixtureCaptured &&
        result?.resultStatus === "partial" &&
        JSON.stringify(result.lifecycle) ===
          JSON.stringify(["install", "configure"]);
      break;
    case "leaked-child":
      observed = leakedChildReadinessWasObserved({
        certificationReadiness: result?.certificationReadiness,
        fixtureCaptured,
        fixtureResultStatus: result?.resultStatus,
      });
      break;
    case "unbounded-output":
      observed =
        receipt.outcome === "output-limit" &&
        receipt.cleanup === "clean" &&
        receipt.residualProcessCount === 0;
      break;
    case "false-success":
      observed =
        receipt.outcome === "exited" &&
        receipt.exitCode === 0 &&
        fixtureCaptured &&
        result?.resultStatus === "partial";
      break;
    default:
      return;
  }
  if (!observed) throw new Error("integration.certification.predicate");
  observeSubstrateCertificationPredicate(
    plan.runId,
    SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase],
  );
  throw new Error(`integration.certification.${substrateCertificationCase}`);
};
const contentFreeChildFailureCode = (error) => {
  const source = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  const diagnostic =
    source.match(
      /integration\.runner\.interactive-diagnostic:((?:integration|testkit)\.[a-z0-9.-]{1,128})\b/u,
    )?.[1] ??
    source.match(/\b(?:integration|testkit)\.[a-z0-9.-]{1,128}\b/u)?.[0];
  return diagnostic ?? "integration.isolation.child-failure";
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
  const immutableCandidate = await createImmutableCandidateHandoff(
    plan,
    signal,
  );
  await createScenarioContainer(
    plan,
    signal,
    outerMonotonicDeadline,
    immutableCandidate,
  );
  try {
    const { stdout } = await dockerWithSignal(
      ["start", "--attach", plan.scenarioName],
      signal,
      { mutationCapable: true },
    );
    const receipt =
      plan.executionMode === "interactive"
        ? captureInteractivePtyReceipt(stdout, plan, {
            outerMonotonicDeadline,
          })
        : captureHeadlessReceipt(stdout, plan, {
            outerMonotonicDeadline,
          });
    const ptyReceipt = captureInstalledCliPtyReceipt(stdout, plan);
    const fixtureCaptured = captureFixtureResult(stdout, plan);
    observeNegativeScenarioReceipt(plan, receipt, fixtureCaptured);
    registerScenarioReceipt(plan, receipt);
    return {
      receipt,
      succeeded:
        scenarioReceiptSucceeded(plan, receipt, ptyReceipt) && fixtureCaptured,
    };
  } catch (error) {
    if (plan.executionMode === "interactive")
      process.stderr.write(
        `integration.isolation.interactive-diagnostic:${contentFreeChildFailureCode(error)}\n`,
      );
    const output = `${error?.stdout ?? ""}`;
    const fixtureCaptured = captureFixtureResult(output, plan);
    if (output.includes("AGENTSCOPE_PTY_FAILURE="))
      captureInstalledPtyFailure(output, plan);
    if (
      substrateCertificationCase === "leaked-child" &&
      leakedChildReadinessWasObserved({
        certificationReadiness: fixtureResults.get(plan.runId)
          ?.certificationReadiness,
        fixtureCaptured,
        fixtureResultStatus: fixtureResults.get(plan.runId)?.resultStatus,
      })
    ) {
      observeSubstrateCertificationPredicate(
        plan.runId,
        SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase],
      );
      throw new Error(
        `integration.certification.${substrateCertificationCase}`,
        { cause: error },
      );
    }
    if (
      output.includes("AGENTSCOPE_HEADLESS_RECEIPT=") ||
      output.includes("AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=")
    ) {
      const receipt =
        plan.executionMode === "interactive"
          ? captureInteractivePtyReceipt(output, plan, {
              outerMonotonicDeadline,
            })
          : captureHeadlessReceipt(output, plan, {
              outerMonotonicDeadline,
            });
      observeNegativeScenarioReceipt(plan, receipt, fixtureCaptured);
      registerScenarioReceipt(plan, receipt);
      return { receipt, succeeded: false };
    }
    throw error;
  }
};
// eslint-disable-next-line max-lines-per-function -- one atomic retained evidence settlement
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
    if (result.harnessObservation !== undefined)
      writeFileSync(
        resolve(directory, "harness-observation.json"),
        `${JSON.stringify(result.harnessObservation, undefined, 2)}\n`,
      );
    writeFileSync(
      resolve(directory, "fixture-lifecycle.json"),
      `${JSON.stringify(
        {
          evidenceVersion: 1,
          resultStatus: result.resultStatus,
          scenarioId: result.scenarioId,
          artifactFileName: result.artifactFileName,
          certificationReadiness: result.certificationReadiness,
          lifecycle: result.lifecycle,
          eventKinds: result.eventKinds,
        },
        undefined,
        2,
      )}\n`,
    );
    if (result.certificationReadiness === null)
      fixtureResults.delete(verifiedEvidence.runId);
  }
  const admission = admissionByRunId.get(verifiedEvidence.runId);
  if (admission !== undefined) {
    if (
      result === undefined ||
      result.resultStatus !== "complete" ||
      typeof verifiedEvidence.builtImageDigest !== "string"
    )
      throw new Error("integration.harness-scenario-admission.invalid");
    if (admission.authority !== undefined)
      throw new Error("integration.harness-scenario-admission.invalid");
    const material = Object.freeze({
      authorityVersion: 1,
      authorityKind: "authenticated-harness-material",
    });
    admissionMaterialRecords.set(
      material,
      compileHarnessAdmissionSeed({
        ...admission.seed,
        evidence: admission.evidence,
        materialIdentity: admission.materialIdentity,
        preparedImage: {
          ...admission.seed.preparedImage,
          scenarioImageDigest: verifiedEvidence.builtImageDigest,
        },
        scenario: admission.scenario,
      }),
    );
    admission.material = material;
    admission.authority = beginRealHarnessAdmission(material);
    const receipt =
      verifiedEvidence.executionMode === "interactive"
        ? verifiedEvidence.ptyTerminalReceipt
        : verifiedEvidence.headlessTerminalReceipt;
    const completion = compileHarnessAdmissionCompletion({
      cleanup: verifiedEvidence.cleanup,
      observation: {
        native: result,
        execution: {
          baseImageIdentity: verifiedEvidence.baseImageIdentity,
          builtImageDigest: verifiedEvidence.builtImageDigest,
          candidateBundleIdentity: verifiedEvidence.candidateBundleIdentity,
          executionMode: verifiedEvidence.executionMode,
          manifestIdentity: verifiedEvidence.manifestIdentity,
          mockServerImageIdentity: verifiedEvidence.mockServerImageIdentity,
          receipt,
          scenarioId: verifiedEvidence.scenarioId,
        },
      },
      outcome: verifiedEvidence.outcome,
      requestFingerprint: receipt?.requestFingerprint,
      runId: verifiedEvidence.runId,
      scenarioImageDigest: verifiedEvidence.builtImageDigest,
    });
    const terminal = Object.freeze({
      authorityVersion: 1,
      authorityKind: "authenticated-harness-terminal",
    });
    admissionTerminalRecords.set(terminal, {
      material: admission.material,
      completion,
    });
    completeRealHarnessAdmission(admission.authority, terminal);
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
    controllerFailureEvidenceVersion: 2,
    runId: plan.runId,
    certificationCase: substrateCertificationCase ?? null,
    certificationPredicate:
      substrateCertificationCase === undefined
        ? null
        : observedCertificationRunIds.has(plan.runId)
          ? SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase]
          : null,
    certificationReadiness:
      fixtureResults.get(plan.runId)?.certificationReadiness ?? null,
    scenarioOutcome: scenarioOutcomes.get(plan.runId) ?? "not-complete",
    controllerOutcome: "retired-failure",
    primaryFailure: failureCode(primaryError),
    cleanupFailure:
      cleanupError === undefined ? null : failureCode(cleanupError),
    installedPtyFailure: installedPtyFailures.get(plan.runId) ?? null,
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
  const buildkit = preparedImageEvidence.images.find(
    ({ image }) => image === BUILDKIT_IMAGE,
  );
  if (buildkit === undefined)
    throw new Error("integration.controller.failure-evidence");
  const record = {
    controllerFailureManifestVersion: 1,
    controllerAuthorityDigest:
      capability.binding.privateStorage.authorityDigest,
    certificationCase: substrateCertificationCase ?? null,
    preparedAuthorityDigests: {
      buildkitImage: diagnosticDigest({
        configDigest: buildkit.configDigest,
        image: buildkit.image,
      }),
      buildkitPlatform: diagnosticDigest(buildkit.platform),
      daemon: diagnosticDigest(preparedImageEvidence.dockerDaemon),
      images: diagnosticDigest(preparedImageEvidence.images),
      socket: diagnosticDigest(preparedImageEvidence.dockerSocket),
    },
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
const createDriver = (plan) => {
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
    removeNetwork: (name) => {
      if (substrateCertificationCase === "cleanup-failure") {
        observeSubstrateCertificationPredicate(
          plan.runId,
          SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase],
        );
        throw new Error(
          `integration.certification.${substrateCertificationCase}`,
        );
      }
      return ignoreMissing(["network", "rm", name], boundedRemovalSignal());
    },
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
verifyManifestEvidence(manifest, integrationRoot);
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
const admissionByRunId = new Map();
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
let pendingSupportEvidence;
let terminalEvidence;
try {
  for (const evidenceId of new Set(
    selectedScenarios.map(({ harnessEvidenceId }) => harnessEvidenceId),
  )) {
    const evidence = evidenceById.get(evidenceId);
    const scenario = selectedScenarios.find(
      (entry) => entry.harnessEvidenceId === evidenceId,
    );
    const plan = plans.find(
      (entry) => entry.scenarioId === scenario?.scenarioId,
    );
    if (evidence === undefined || plan === undefined)
      throw new Error("integration.harness-material.failed");
    if (evidence.material.kind !== "certification-fixture")
      preparedHarnessMaterials.set(
        evidenceId,
        await prepareHarnessMaterial({
          dockerClient: preparedDockerClient,
          evidenceId,
          material: evidence.material,
          maximumMilliseconds:
            remainingIntegrationOperationMilliseconds(300_000),
          privateRoot: capability.binding.privateStorage.root,
          runId: plan.runId,
          signal: integrationStageSignal(),
        }),
      );
  }
  for (const plan of plans) {
    const scenario = scenarios.find(
      ({ scenarioId }) => scenarioId === plan.scenarioId,
    );
    const evidence = evidenceById.get(scenario?.harnessEvidenceId);
    const preparedMaterial = preparedHarnessMaterials.get(
      scenario?.harnessEvidenceId,
    );
    if (scenario === undefined || evidence === undefined)
      throw new Error("integration.harness-scenario-admission.invalid");
    if (preparedMaterial === undefined) continue;
    const materialAuthority = inspectPreparedHarnessMaterial(preparedMaterial);
    const image = preparedIdentityFor(scenario.image);
    admissionByRunId.set(plan.runId, {
      evidence,
      materialIdentity: materialAuthority.materialIdentity,
      seed: {
        candidateDigest: candidate.bundleIdentity,
        destinationCombinationIdentity: admissionDigest({
          destinations: [...scenario.destinations].sort(),
          modelRoutes: [...scenario.modelRoutes].sort(),
        }),
        manifestIdentity: manifest.manifestIdentity,
        platformIdentity: admissionDigest(image.platform),
        preparedImage: {
          image: image.image,
          manifestDigest: image.manifestDigest,
          configDigest: image.configDigest,
          platformIdentity: admissionDigest(image.platform),
        },
        runId: plan.runId,
      },
      scenario,
    });
  }
  await activateRuns(plans);
  const evidence = await mapWithConcurrency(
    plans,
    scenarioConcurrency,
    (plan) =>
      executeIsolationPlan(
        plan,
        createDriver(plan),
        AbortSignal.any([
          controller.signal,
          integrationStageSignal(),
          AbortSignal.timeout(scenarioTimeoutMilliseconds),
        ]),
      ),
  );
  if (substrateCertificationCase !== undefined)
    throw new Error("integration.certification.unexpected-success");
  if (substrateCertificationReplay !== undefined) {
    registerSubstrateCertificationProjection({
      candidateBundleIdentity: candidate.bundleIdentity,
      manifestIdentity: manifest.manifestIdentity,
      selectedScenarioIds: [...selectedScenarioIds].sort(),
      scenarioResults: evidence
        .map(({ cleanup, outcome, scenarioId }) => ({
          cleanup: cleanup.outcome,
          outcome,
          scenarioId,
        }))
        .toSorted((left, right) =>
          left.scenarioId.localeCompare(right.scenarioId),
        ),
      selectionIdentity: `sha256:${createHash("sha256")
        .update(JSON.stringify(executorSelection))
        .digest("hex")}`,
    });
  }
  if (admissionByRunId.size > 0) {
    const authorities = [...admissionByRunId.values()].map(
      ({ authority }) => authority,
    );
    if (authorities.some((authority) => authority === undefined))
      throw new Error("integration.harness-admission.invalid");
    const supportEvidence = compileRealHarnessSupportEvidence(authorities);
    const serializedSupportEvidence = `${JSON.stringify(
      supportEvidence,
      undefined,
      2,
    )}\n`;
    if (Buffer.byteLength(serializedSupportEvidence) > 1_048_576)
      throw new Error("integration.harness-admission.invalid");
    pendingSupportEvidence = serializedSupportEvidence;
  }
  terminalEvidence = evidence;
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
    primaryError =
      substrateCertificationCase !== undefined &&
      plans.every(({ runId }) => observedCertificationRunIds.has(runId))
        ? new Error(`integration.certification.${substrateCertificationCase}`, {
            cause: error,
          })
        : error;
  }
} finally {
  for (const plan of plans)
    rmSync(activeMarkerFor(plan.runId), { force: true });
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
  let cleanupError;
  try {
    for (const material of preparedHarnessMaterials.values())
      retirePreparedHarnessMaterial(material);
  } catch (error) {
    cleanupError = error;
    primaryError ??= error;
  }
  if (preparedDockerClient !== undefined && !retirementRequired) {
    try {
      closePreparedDockerClient(preparedDockerClient);
    } catch (error) {
      cleanupError ??= error;
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
      for (const plan of plans) fixtureResults.delete(plan.runId);
    } catch {
      // The original controller failure remains primary. The workflow's
      // always-run exact verifier independently fails if evidence is absent.
    }
  }
}
if (primaryError !== undefined) throw primaryError;
if (pendingSupportEvidence !== undefined) {
  registerIntegrationArtifactFile("harness-support-evidence.json");
  writeFileSync(
    resolve(artifactsRoot, "harness-support-evidence.json"),
    pendingSupportEvidence,
    { flag: "wx", mode: 0o600 },
  );
}
console.log(JSON.stringify(terminalEvidence));
