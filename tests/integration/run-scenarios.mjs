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
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify, types } from "node:util";
import { deriveIdentityBundle } from "@agentscope/protocol";

import {
  compileIsolationEvidence,
  compileCapabilityManifest,
  compileHarnessAdmissionCompletion,
  compileHarnessAdmissionSeed,
  compileInteractivePtyActions,
  createIsolationPlan,
  executeIsolationPlan,
  ISOLATION_EXECUTOR_LIMITS,
  mapWithConcurrency,
  observeSelectedWriterOtlp,
  sanitizeFixtureResult,
  scenarioContainerTerminalWitness,
  SCENARIO_HOME,
  scenarioTmpfsIsExecutable,
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
  registerPreparedDockerControlVolume,
  registerPreparedDockerNetwork,
  revalidatePreparedImageAdmission,
  retirePreparedDockerNetwork,
  retirePreparedDockerControlVolume,
  retirePreparedDockerImage,
} from "./image-preparation.mjs";
import {
  inspectPreparedHarnessMaterial,
  prepareHarnessMaterial,
  retirePreparedHarnessMaterial,
  stagePreparedHarnessMaterial,
} from "./harness-material.mjs";
import { acquireIntegrationOperationLock } from "./operation-lock.mjs";
import { writeExactRegularFile } from "./exact-file.mjs";
import { collectorCa } from "./collector-ca.mjs";
import { codexResearchDependencies } from "./codex-pty-research.mjs";
import { createCodexFailureResearchRecord } from "./codex-trace-child-diagnostics.mjs";
import { prepareMockServerService } from "./mockserver-material/prepare-supplier.mjs";
import {
  assertMockServerFinalLedger,
  createMockServerControlMaterial,
  openMockServerControl,
  projectMockServerRequests,
  readMockServerFinalLedger,
  snapshotMockServerTraffic,
  verifyMockServerControlBoundary,
} from "./mockserver-control.mjs";
import {
  compileImmutableCandidateHandoff,
  decodeInteractiveFailureExitCode,
  decodeInteractivePtyReceipt,
  extractInteractiveChildDiagnostic,
  interactivePtyEnvelopeDeadlineMatches,
  interactivePtyEnvelopeRejectionCode,
  interactivePtyExecutionReserveMilliseconds,
  interactivePtyObservedActionsMatch,
  interactivePtyArtifactReadinessMatches,
  interactivePtyArtifactRejectionCode,
  interactivePtyReceiptAuthorityMatches,
  selectInteractiveExecutionFailurePredicate,
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

// PUBLICLY KNOWN NON-AUTHORITATIVE TEST FIXTURE, not a secret or authority.
// Never copy these literals into candidate/runtime material or retained output.
const collectorTlsCertificate =
  "-----BEGIN CERTIFICATE-----\nMIIDWTCCAkGgAwIBAgIJALhPtwb/YwcyMA0GCSqGSIb3DQEBCwUAMC8xLTArBgNV\nBAMMJEFnZW50c2NvcGUgTk9OLUFVVEhPUklUQVRJVkUgVEVTVCBDQTAeFw0yNjEw\nMDgyMjUxMzdaFw00NjEwMDMyMjUxMzdaMBQxEjAQBgNVBAMMCWNvbGxlY3RvcjCC\nASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAOI9QoaxF6zrv+z08vhCl4Wm\nBZ6FRhU6ueRm0wxs0VMMnkfoL48Xoaxsr2Imnw0g0YkHwuXbCwjcfV9KnMrXShE/\nf/FQpx+4NQiT65qGwY8tFI+RRdzL60LVCXo8g6Qn3Csz7lGxSsXY+Lqk4pkHMBE0\njv2NBbHTyj1fM62E4duDVucBqMMEZB4Woti7LB7z85ms7WmqMtXcqSNEVWp+IKkQ\nk+52HM/zzsBiPAs0I1QzUDGcZGHrQFmGxmasZDQJ6U2GFhG92BiR8PBzY6MieE2x\nz+b8APe1XXQmo+1Mn4C/gBwFz5yQdyKuXn2yn11QECqY65hkVATkpw2+rV/ihUMC\nAwEAAaOBkjCBjzAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUE\nDDAKBggrBgEFBQcDATAaBgNVHREEEzARggljb2xsZWN0b3KHBH8AAAEwHQYDVR0O\nBBYEFCdZewpLX6ENldAi/+zeXIhxN6fnMB8GA1UdIwQYMBaAFBaQOqAoApslxCmZ\n8ZmT8eHoLTM+MA0GCSqGSIb3DQEBCwUAA4IBAQBO063j/ZT4jn6E5qlgspURADjY\nT0Gu1W+frEMcsP9MOcOmIt15bqDyoTDA6jJrtyDx7t7PIUI0+hPziWgdOTwG9QvJ\nMcURlJ7+eHqkC871vM8Y1FphRknWYoatDOacqlfG7uHRBeob77UnirJRqcjr3AUF\n9RXWYelaTP9/diuftwB8c7bPJlLFesZKEEjRZOix2YMAPRzFEkx2b2hPTL+5Dd5r\nu5+TcaRywxJi0eK12OxTnkOoqEk7ap2fY+qAjS+hnLabRqJt+O9jK2lHK12i67qV\njGcoL7rCQqywLR8fTrxiJr992WzELbGLCTyfJUPU9AKaTFi4lbYuDAfYBmTS\n-----END CERTIFICATE-----\n";
const collectorTlsKey =
  "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDiPUKGsRes67/s\n9PL4QpeFpgWehUYVOrnkZtMMbNFTDJ5H6C+PF6GsbK9iJp8NINGJB8Ll2wsI3H1f\nSpzK10oRP3/xUKcfuDUIk+uahsGPLRSPkUXcy+tC1Ql6PIOkJ9wrM+5RsUrF2Pi6\npOKZBzARNI79jQWx08o9XzOthOHbg1bnAajDBGQeFqLYuywe8/OZrO1pqjLV3Kkj\nRFVqfiCpEJPudhzP887AYjwLNCNUM1AxnGRh60BZhsZmrGQ0CelNhhYRvdgYkfDw\nc2OjInhNsc/m/AD3tV10JqPtTJ+Av4AcBc+ckHcirl59sp9dUBAqmOuYZFQE5KcN\nvq1f4oVDAgMBAAECggEAcStxrszBaheXryGstLEi+JDe+Lf0IcR5np4s7mc0opWK\nS7ACslKA5i6L4M4u+7Mx/ZjrTm2u7GTXNiatne3puA0KpBzTLNPJe5v63BaSlltX\nkKV7zAIZkhndHs9Mjn397YKRsT29iJCLg1ndm+zzh3fCG2VCtvyZiu+neyIglNwC\naBSywTix9penTf9LKagrZyYDax9/qr2XGFeG2fElvi3ybvDyJy9zzh/v8HyfZv1G\n3vhPvuKqJ9ywWmqx6e8O46Coss3FF4tZUBMjCBfsPFRXnMSKhuOOhNAkGvjMV2RO\nVnDilLK1HGuTw4Ma/X8oaTGUuyJ6fCLD7m3M4jxIsQKBgQD4EWyrJxNCuV+pCYCU\nA07x/oG85Dvi9gn/6APeYw2BA44Sunqm82eYHNfJ7VVn3Y2GK/D+U3fNQ6QN8Dv3\nsEN1q0TfUBxS8TzbBKJWBbR6JE8TI72gkui+0oobDOhP2g1WXbY3td433rpc+T6V\n2aO1eamFmpInQGYBElX6iBsiiQKBgQDpeSecwXPVtQJVLzgmExtXnnP4265eyZjA\nWK3F1USBcmUda+YmK5+8XrcGw5ovt8zLuvnJcGkmNddJXz8Lo96/JAjos9oyuF01\nQUwi+ncubTmhsjIRPzbbXcEqvzJk39QsTIR7qNbrWYgZy237OCTov5Wyp2fh/Aej\ny0bgLmTmawKBgQCWJ03kp2lUKQrLMbI/ZWVCu2/iWzAYqB7TZKf603AYGIPFuFSH\ne6vH+iVv15WrogKJJU3hU7qfZ4ME4NYbjfi3X+z3UvFiDx1r4Pk2IovkpteqWSbt\n7B6vapcn2n8/3lfWYDDstcwFe27I2iFU6QDb1wGSmkY/Ng7INUYPuJTcKQKBgQCh\nGg6xZfOuFVbkvM57x1dooFfZ8oxhr64Nm6NdDYpV4D/Ri3CmChgQ/TJCIpq0LpnM\nQtq1mzGTQjep02VHfO3o6s6S8/euY/U9GC+XO0kd6hSIdNODfyE1QX5XJtN5M9HO\nN4Z7ZcfXYlI9qlfbr6QYTorXWhieoTAMX+oqKxlIvQKBgBwGaB6Pb5VPsD0VufCy\n4dstz6JGo5+TenHxqW6fTTAXoWMxHb4eAAOjPicmz1ONHJwpL2WHlpqQ0XlPSICl\nvM52c7YcOeXm2KkugEcpg6y3Z6IrChLtjy4yzQG+PB4ymHCGR+tJHSmaURr+UVB8\njySh/x0sD0+Wfhi8e3/kCH1r\n-----END PRIVATE KEY-----\n";
const execute = promisify(execFile);
const integrationRoot = import.meta.dirname;
const workspaceRoot = resolve(integrationRoot, "../..");
const artifactsRoot = resolve(workspaceRoot, "artifacts/integration");
const installedPtyFailures = new Map();
const codexResearchDiagnostics = new Map();
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
const mockServerControls = new Map();
const mockServerBuiltImages = new Map();
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
  { mutationCapable = false, terminal = false, ...options } = {},
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
        terminal,
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
      terminal: true,
      timeout: remainingIntegrationOperationMilliseconds(30_000, true),
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
    `${path}:rw,${scenarioTmpfsIsExecutable(path) ? "exec" : "noexec"},nosuid,nodev,size=${bytes}${ownership ? ",uid=1000,gid=1000" : ""}`,
  ]);
const isNativeTraceScenario = (plan) =>
  ["codex-tui-trace-smoke", "claude-interactive-trace-smoke"].includes(
    plan.scenarioId,
  );
const isGateCapableMockServer = (scenario) =>
  scenario.modelRoutes.length === 1 &&
  ((scenario.scenarioId === "codex-tui-trace-smoke" &&
    scenario.modelRoutes[0] === "codex-tui-responses") ||
    (scenario.scenarioId === "claude-interactive-trace-smoke" &&
      scenario.modelRoutes[0] === "anthropic-messages"));
const confinementArguments = (plan) => [
  "--network",
  plan.networkName,
  "--read-only",
  "--cap-drop",
  "ALL",
  ...(isNativeTraceScenario(plan)
    ? [
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "KILL",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETUID",
      ]
    : []),
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  String(ISOLATION_EXECUTOR_LIMITS.containers.scenario.pidsLimit),
  "--memory",
  String(ISOLATION_EXECUTOR_LIMITS.containers.scenario.memoryBytes),
  "--user",
  isNativeTraceScenario(plan) ? "0:0" : "1000:1000",
  ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers.scenario),
];
const sidecarResourceArguments = (limits) => [
  "--pids-limit",
  String(limits.pidsLimit),
  "--memory",
  String(limits.memoryBytes),
];

const stageEsmPackageBoundary = (context) => {
  const packageBoundaryPath = resolve(context, "dist/package.json");
  const packageBoundaryBytes = Buffer.from('{"type":"module"}\n');
  writeExactRegularFile(packageBoundaryPath, packageBoundaryBytes, 0o644);
};

const scenarioContextRefusals = new Map();
const contextRefusalSlots = new Set([
  "scenario-missing",
  "evidence-missing",
  "material-association",
  "source-not-regular",
  "source-identity",
  "source-digest",
  "package-association",
]);
const refuseScenarioContext = (plan, slot) => {
  if (
    !scenarioContextRefusals.has(plan.runId) &&
    /^[a-f0-9]{16}$/u.test(plan.runId) &&
    /^[a-z0-9][a-z0-9-]{0,127}$/u.test(plan.scenarioId) &&
    contextRefusalSlots.has(slot)
  )
    scenarioContextRefusals.set(
      plan.runId,
      Object.freeze({ runId: plan.runId, scenarioId: plan.scenarioId, slot }),
    );
  throw new Error("integration.isolation.context");
};
const publishScenarioContextRefusals = () => {
  for (const record of scenarioContextRefusals.values()) {
    try {
      const output = `integration.isolation.context-diagnostic:${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(output) <= 512) process.stderr.write(output);
    } catch {
      // Optional untrusted observation cannot replace the original failure.
    }
  }
};

// The exact staged inventory and Dockerfile are reviewed as one authority.
// eslint-disable-next-line max-lines-per-function -- exact staged scenario authority
const stageBuildContext = (plan) => {
  const runContexts = resolve(artifactsRoot, "contexts", plan.runId);
  const context = resolve(runContexts, "scenario");
  rmSync(runContexts, { force: true, recursive: true });
  mkdirSync(resolve(context, "prepared/candidates"), { recursive: true });
  mkdirSync(resolve(context, "runtime"), { recursive: true });
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === plan.scenarioId,
  );
  if (scenario === undefined) refuseScenarioContext(plan, "scenario-missing");
  const evidence = evidenceById.get(scenario.harnessEvidenceId);
  if (evidence === undefined) refuseScenarioContext(plan, "evidence-missing");
  const gateCapableMockServer = isGateCapableMockServer(scenario);
  const harnessMaterial = preparedHarnessMaterials.get(
    scenario.harnessEvidenceId,
  );
  if (
    (evidence.material.kind !== "certification-fixture") !==
    (harnessMaterial !== undefined)
  )
    refuseScenarioContext(plan, "material-association");
  const sources = [
    ...[
      "runner.mjs",
      "immutable-candidate-authority.mjs",
      "retained-fixture-result.mjs",
      "destination-server.mjs",
      "codex-pty-research.mjs",
      "codex-trace-child-diagnostics.mjs",
      "selected-runtime-files.mjs",
      "mockserver-control.mjs",
      "mockserver-final-ledger.mjs",
    ].map((name) => [name, resolve(integrationRoot, name)]),
    [
      "scenario-process.mjs",
      resolve(integrationRoot, scenario.scenarioProcess.path),
      scenario.scenarioProcess.sha256,
    ],
    [
      "substrate-certification.js",
      resolve(integrationRoot, "dist/substrate-certification.js"),
    ],
    ...[
      "dist/canonical.js",
      "dist/interactive-pty-actions.js",
      "fixtures/substrate-negative-process.mjs",
    ].map((name) => [name, resolve(integrationRoot, name)]),
    ...[
      ["scenario-oracle.mjs", scenario.scenarioOracle],
      ["scenario-adapter.mjs", scenario.fixtureAdapter],
    ].map(([name, source]) => [
      name,
      resolve(integrationRoot, source.path),
      source.sha256,
    ]),
    [
      "testkit/platform-fixture.js",
      resolve(workspaceRoot, "packages/testkit/dist/platform-fixture.js"),
    ],
    [
      "capability-manifest.json",
      resolve(integrationRoot, "capability-manifest.json"),
    ],
    ...[
      ["current-selection.json", "current-selection.json"],
      ["current-model-routes.json", "current-model-routes.json"],
      ["prepared/current-candidate.json", "current-candidate.json"],
    ].map(([target, name]) => [target, resolve(artifactsRoot, name)]),
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
      refuseScenarioContext(plan, "source-not-regular");
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
        before.size !== bytes.byteLength
      )
        refuseScenarioContext(plan, "source-identity");
      if (
        expectedDigest !== undefined &&
        createHash("sha256").update(bytes).digest("hex") !== expectedDigest
      )
        refuseScenarioContext(plan, "source-digest");
      writeFileSync(target, bytes, {
        flag: "wx",
        mode: before.mode & 0o777,
      });
    } finally {
      closeSync(descriptor);
    }
  }
  if (gateCapableMockServer)
    writeExactRegularFile(
      resolve(context, "collector-ca.pem"),
      Buffer.from(collectorCa, "utf8"),
      0o444,
    );
  stageEsmPackageBoundary(context);
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
                  refuseScenarioContext(plan, "package-association");
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
      writeExactRegularFile(
        resolve(context, "harness/npm-globalconfig"),
        Buffer.alloc(0),
        0o600,
      );
      writeExactRegularFile(
        resolve(context, "harness/npm-userconfig"),
        Buffer.alloc(0),
        0o600,
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
            'RUN --network=none ["/usr/local/bin/node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "install", "--prefix", "/opt/agentscope/harness", "--ignore-scripts", "--offline", "--audit=false", "--fund=false", "--package-lock=false", "--userconfig=/opt/agentscope/harness/npm-userconfig", "--globalconfig=/opt/agentscope/harness/npm-globalconfig", "--cache=/tmp/agentscope-harness-npm-cache"]',
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
      "COPY runner.mjs immutable-candidate-authority.mjs codex-pty-research.mjs codex-trace-child-diagnostics.mjs selected-runtime-files.mjs mockserver-control.mjs mockserver-final-ledger.mjs retained-fixture-result.mjs destination-server.mjs scenario-process.mjs scenario-oracle.mjs scenario-adapter.mjs substrate-certification.js capability-manifest.json current-selection.json current-model-routes.json ./",
      ...(gateCapableMockServer
        ? [
            "COPY --chmod=0555 runtime/codex-candidate-dropper.mjs ./codex-candidate-dropper.mjs",
            "COPY --chmod=0444 collector-ca.pem ./collector-ca.pem",
          ]
        : []),
      "COPY runtime ./runtime",
      ...(scenario.scenarioId === "claude-interactive-trace-smoke"
        ? [
            "COPY runtime/claude-code-lifecycle.mjs ./claude-code-lifecycle.mjs",
            "COPY scenario-oracle.mjs ./claude-code-platform-oracle.mjs",
          ]
        : []),
      "COPY fixtures ./fixtures",
      "COPY dist ./dist",
      "COPY testkit ./testkit",
      "COPY prepared ./prepared",
      ...harnessInstall,
      `RUN ["/usr/local/bin/node", "/usr/local/lib/node_modules/npm/bin/npm-cli.js", "install", "--prefix", "/opt/agentscope/installed", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "./prepared/candidates/${candidate.bundleIdentity}/files/${cliArtifact.fileName}"]`,
      "USER node",
      'CMD ["node", "/opt/agentscope/runner.mjs"]',
      "",
    ].join("\n"),
  );
  return Object.freeze({
    context,
    requiresHarnessBuildContextBound: harnessMaterial !== undefined,
  });
};

const prepareMockServerControl = (plan) => {
  if (mockServerControls.has(plan.runId))
    throw new Error("integration.isolation.context");
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === plan.scenarioId,
  );
  if (scenario === undefined) throw new Error("integration.isolation.context");
  const gateCapableMockServer = isGateCapableMockServer(scenario);
  const material = createMockServerControlMaterial(plan.runId);
  const expectations = Buffer.from(
    `${JSON.stringify(
      gateCapableMockServer
        ? []
        : scenario.modelRoutes.map((routeId) => {
            const index = modelRoutes.routeIds.indexOf(routeId);
            if (
              index < 0 ||
              modelRoutes.routeIds.lastIndexOf(routeId) !== index ||
              modelRoutes.mockServerInitialization[index] === undefined
            )
              throw new Error("integration.isolation.context");
            return modelRoutes.mockServerInitialization[index];
          }),
    )}\n`,
  );
  mockServerControls.set(plan.runId, { material, expectations });
};

const assertContainer = async (
  plan,
  name,
  limits,
  signal,
  expectedRequestBytes,
  immutableCandidate,
  // eslint-disable-next-line complexity,max-params,max-lines-per-function -- closed per-field diagnosis preserves container proof
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
    const executable = scenarioTmpfsIsExecutable(path);
    return (
      options.has("rw") &&
      options.has(executable ? "exec" : "noexec") &&
      !options.has(executable ? "noexec" : "exec") &&
      options.has("nosuid") &&
      options.has("nodev") &&
      options.has(`size=${bytes}`)
    );
  });
  const environment = Array.isArray(container?.Config?.Env)
    ? container.Config.Env
    : [];
  const expectedControlVolume =
    name === plan.scenarioName || name === plan.mockServerName
      ? controlVolumeIdentities.get(plan.runId)
      : undefined;
  const expectedControlMount =
    expectedControlVolume === undefined
      ? container?.Mounts?.length === 0
      : container?.Mounts?.length === 1 &&
        container.Mounts[0]?.Type === "volume" &&
        container.Mounts[0]?.Name === expectedControlVolume.name &&
        container.Mounts[0]?.Source === expectedControlVolume.mountpoint &&
        container.Mounts[0]?.Destination === "/control" &&
        container.Mounts[0]?.RW === true;
  const requestLimitMatches =
    expectedRequestBytes === undefined ||
    environment.includes(
      `AGENTSCOPE_MAXIMUM_REQUEST_BYTES=${expectedRequestBytes}`,
    );
  const candidateImageIdMatches =
    immutableCandidate === undefined ||
    container?.Image === immutableCandidate.imageId;
  const candidateUserMatches =
    immutableCandidate === undefined ||
    container?.Config?.User ===
      (isNativeTraceScenario(plan) ? "0:0" : "1000:1000");
  const candidateEnvironmentMatches =
    immutableCandidate === undefined ||
    environment.includes(
      `AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${immutableCandidate.encoded}`,
    );
  const candidateCapDropMatches =
    immutableCandidate === undefined ||
    JSON.stringify(container?.HostConfig?.CapDrop) === JSON.stringify(["ALL"]);
  const candidateCapAddMatches =
    immutableCandidate === undefined ||
    JSON.stringify(container?.HostConfig?.CapAdd ?? []) ===
      JSON.stringify(
        isNativeTraceScenario(plan)
          ? [
              "CAP_CHOWN",
              "CAP_DAC_OVERRIDE",
              "CAP_KILL",
              "CAP_SETGID",
              "CAP_SETUID",
            ]
          : [],
      );
  const candidateSecurityMatches =
    immutableCandidate === undefined ||
    (Array.isArray(container?.HostConfig?.SecurityOpt) &&
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
          controlVolume: expectedControlVolume,
          handoff: immutableCandidate,
          image: records[0],
          networkName: plan.networkName,
          tmpfs,
        });
    } catch {
      imageConfigMatches = false;
    }
  }
  const failedAssertion = [
    ["id", /^[a-f0-9]{64}$/u.test(container?.Id ?? "")],
    ["name", container?.Name === `/${name}`],
    [
      "labels",
      container?.Config?.Labels?.["com.agentscope.integration"] === "true" &&
        container?.Config?.Labels?.["com.agentscope.integration.run"] ===
          plan.runId,
    ],
    ["readonly", container?.HostConfig?.ReadonlyRootfs === true],
    ["network", container?.HostConfig?.NetworkMode === plan.networkName],
    ["memory", container?.HostConfig?.Memory === limits.memoryBytes],
    ["pids", container?.HostConfig?.PidsLimit === limits.pidsLimit],
    ["mount-inventory", Array.isArray(container?.Mounts)],
    ["control-mount", expectedControlMount],
    [
      "tmpfs-paths",
      JSON.stringify(tmpfsPaths) === JSON.stringify(expectedPaths),
    ],
    ["tmpfs-options", tmpfsMatches],
    ["request-limit", requestLimitMatches],
    ["candidate-image-id", candidateImageIdMatches],
    ["candidate-user", candidateUserMatches],
    ["candidate-environment", candidateEnvironmentMatches],
    ["candidate-cap-drop", candidateCapDropMatches],
    ["candidate-cap-add", candidateCapAddMatches],
    ["candidate-security", candidateSecurityMatches],
    ["candidate-image", imageConfigMatches],
  ].find(([, matches]) => !matches)?.[0];
  if (failedAssertion !== undefined)
    throw new Error(`integration.isolation.container.${failedAssertion}`);
  return container.Id;
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
const fixtureTrafficObservations = new Map();
const scenarioContainerIdentities = new Map();
const mockServerContainerIdentities = new Map();
const controlVolumeIdentities = new Map();
const mockServerJoinDeadlines = new Map();
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
  AGENTSCOPE_INTEGRATION_RUN_ID: plan.runId,
  AGENTSCOPE_LEDGER: "/ledger",
  AGENTSCOPE_MODEL_SERVER_URL: "http://mockserver:1080",
  AGENTSCOPE_RETRIEVAL_URL: "http://retrieval:4319",
  AGENTSCOPE_SCENARIO_ID: plan.scenarioId,
  AGENTSCOPE_SCENARIO_BOOT_DEADLINE_MS: String(
    outerMonotonicDeadlineMs - 5_000,
  ),
  AGENTSCOPE_WORKTREE: "/worktree",
  HARNESS_HOME: "/harness-home",
  HOME: SCENARIO_HOME,
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
  ...(plan.executionMode === "interactive" ? { TERM: "xterm-256color" } : {}),
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
  const decoded = JSON.parse(
    Buffer.from(
      resultLine.slice("AGENTSCOPE_FIXTURE_RESULT=".length),
      "base64url",
    ).toString("utf8"),
  );
  const traffic = snapshotMockServerTraffic(
    decoded.mockServerTraffic,
    plan.runId,
  );
  delete decoded.mockServerTraffic;
  fixtureTrafficObservations.set(plan.runId, traffic);
  fixtureResults.set(
    plan.runId,
    sanitizeFixtureResult(decoded, plan.scenarioId),
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
  const challenge =
    (selectedScenario.nativeReadiness?.kind === "challenge-process-topology" ||
      selectedScenario.nativeReadiness?.kind === "challenge-marker" ||
      selectedScenario.nativeReadiness?.kind ===
        "codex-challenge-idle-prompt") &&
    (receipt?.request?.readiness?.kind === "challenge-process-topology" ||
      receipt?.request?.readiness?.kind === "challenge-marker" ||
      receipt?.request?.readiness?.kind === "challenge-styled-text") &&
    /^[a-f0-9]{64}$/u.test(receipt.request.readiness.challenge ?? "")
      ? receipt.request.readiness.challenge
      : undefined;
  if (
    (selectedScenario.nativeReadiness?.kind === "challenge-process-topology" ||
      selectedScenario.nativeReadiness?.kind === "challenge-marker" ||
      selectedScenario.nativeReadiness?.kind ===
        "codex-challenge-idle-prompt") &&
    challenge === undefined
  )
    return false;
  const input = Buffer.concat([
    ...(challenge === undefined ? [] : [Buffer.from(`${challenge}\n`)]),
    Buffer.from(selectedScenario.terminalInputBase64, "base64"),
  ]);
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
      processRequest.monotonicShutdownDeadlineMs -
        interactivePtyExecutionReserveMilliseconds(plan.scenarioId) &&
    processRequest?.terminationGraceMs === 1_000
  );
};
const interactivePtyEnvelopeMatches = (receipt, plan, expected, failed) =>
  (() => {
    const selectedScenario = manifest.scenarios.find(
      ({ scenarioId }) => scenarioId === plan.scenarioId,
    );
    if (selectedScenario === undefined) return false;
    const challenge = receipt?.request?.readiness?.challenge;
    const input = Buffer.concat([
      ...((selectedScenario.nativeReadiness?.kind ===
        "challenge-process-topology" ||
        selectedScenario.nativeReadiness?.kind === "challenge-marker" ||
        selectedScenario.nativeReadiness?.kind ===
          "codex-challenge-idle-prompt") &&
      typeof challenge === "string"
        ? [Buffer.from(`${challenge}\n`)]
        : []),
      Buffer.from(selectedScenario.terminalInputBase64, "base64"),
    ]);
    const expectedActions = compileInteractivePtyActions(
      selectedScenario,
      input,
    );
    const expectedReadiness =
      (selectedScenario.nativeReadiness?.kind ===
        "challenge-process-topology" ||
        selectedScenario.nativeReadiness?.kind === "challenge-marker") &&
      typeof challenge === "string" &&
      /^[a-f0-9]{64}$/u.test(challenge)
        ? {
            kind: selectedScenario.nativeReadiness.kind,
            challenge,
          }
        : selectedScenario.nativeReadiness?.kind ===
              "codex-challenge-idle-prompt" &&
            typeof challenge === "string" &&
            /^[a-f0-9]{64}$/u.test(challenge)
          ? {
              kind: "challenge-styled-text",
              challenge,
              text: "›",
              requiredText: "Ask Codex to do anything",
              postSubmissionResponseText: `AGENTSCOPE_CODEX_RESPONSE:${challenge}`,
              requiredTerminalProtocol: "csi-u-flags-7-query-v1",
              bold: true,
              dim: false,
            }
          : selectedScenario.nativeReadiness?.kind === "semantic-marker"
            ? { kind: "semantic-marker" }
            : selectedScenario.nativeReadiness?.kind === "codex-idle-prompt" &&
                selectedScenario.harnessEvidenceId === "codex-0-149-1"
              ? {
                  kind: "styled-text-after-completion",
                  text: "›",
                  bold: true,
                  dim: false,
                }
              : null;
    const requiresCanonicalEof = expectedActions.some(
      ({ action }) => action === "eof",
    );
    const rejection = interactivePtyEnvelopeRejectionCode({
      identity: () =>
        receipt?.receiptVersion === 1 &&
        receipt?.transport === "pty" &&
        receipt?.scenarioId === plan.scenarioId &&
        receipt?.runId === plan.runId,
      deadline: () =>
        interactivePtyEnvelopeDeadlineMatches(
          receipt?.outerMonotonicDeadlineMs,
          expected.outerMonotonicDeadline,
          linuxBootMonotonicMilliseconds(),
          failed,
        ),
      completion: () =>
        receipt?.request?.completion?.kind === "semantic-marker",
      readiness: () =>
        expectedReadiness !== null &&
        JSON.stringify(receipt?.request?.readiness) ===
          JSON.stringify(expectedReadiness),
      trigger: () =>
        receipt?.request?.interaction?.trigger ===
        (selectedScenario.nativeReadiness?.kind ===
          "challenge-process-topology" ||
        selectedScenario.nativeReadiness?.kind === "challenge-marker" ||
        selectedScenario.nativeReadiness?.kind === "codex-challenge-idle-prompt"
          ? "immediate"
          : "semantic-ready"),
      "requested-actions": () =>
        JSON.stringify(receipt?.request?.interaction?.actions) ===
        JSON.stringify(expectedActions),
      "observed-actions": () =>
        interactivePtyObservedActionsMatch(
          receipt?.actions,
          expectedActions,
          failed,
        ),
      "terminal-action": () =>
        receipt?.eofByteWritten ===
        !selectedScenario.waitForSemanticCompletionBeforeTerminalAction,
      tty: () => receipt?.isTTY === true,
      "canonical-mode": () =>
        typeof receipt?.observedCanonicalMode === "boolean" &&
        (!requiresCanonicalEof || receipt.observedCanonicalMode === true),
    });
    return rejection === null;
  })();
const interactivePtyGeometryMatches = (receipt) =>
  JSON.stringify(receipt?.request?.initialGeometry) ===
    JSON.stringify({ columns: 80, rows: 24 }) &&
  JSON.stringify(receipt?.observedGeometry) ===
    JSON.stringify({ columns: 100, rows: 30 });
const interactivePtyArtifactAuthorityMatches = (receipt, failed) => {
  const rejection = interactivePtyArtifactRejectionCode({
    "process-fingerprint": () =>
      receipt?.processRequestFingerprint ===
      receipt?.request?.process?.requestFingerprint,
    "input-bytes": () =>
      receipt?.inputBytes === receipt?.request?.process?.inputBytes,
    "input-digest": () =>
      receipt?.inputSha256 === receipt?.request?.process?.inputSha256,
    readiness: () => interactivePtyArtifactReadinessMatches(receipt, failed),
    interpreter: () =>
      receipt?.request?.interpreter?.path === "/usr/local/bin/node",
    "script-digest": () =>
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
        .digest("hex"),
  });
  return rejection === null;
};
const interactivePtyFingerprintMatches = (receipt) =>
  receipt?.requestFingerprint ===
  fingerprintSelectedPtyAuthority({
    processRequestFingerprint: receipt?.processRequestFingerprint,
    completion: receipt?.request?.completion,
    readiness: receipt?.request?.readiness,
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
const captureInteractivePtyReceipt = (
  output,
  plan,
  expected,
  failed = false,
) => {
  let receipt;
  try {
    receipt = decodeInteractivePtyReceipt(output);
  } catch {
    throw new Error("integration.isolation.pty-receipt");
  }
  const processRequest = receipt?.request?.process;
  let checks;
  try {
    checks = {
      envelope: interactivePtyEnvelopeMatches(receipt, plan, expected, failed),
      process: interactivePtyProcessMatches(processRequest, plan, receipt),
      geometry: interactivePtyGeometryMatches(receipt),
      artifact: interactivePtyArtifactAuthorityMatches(receipt, failed),
      fingerprint: interactivePtyFingerprintMatches(receipt),
    };
  } catch {
    throw new Error("integration.isolation.pty-receipt");
  }
  let matches;
  try {
    matches = interactivePtyReceiptAuthorityMatches(receipt, checks, failed);
  } catch {
    throw new Error("integration.isolation.pty-receipt");
  }
  if (!matches) {
    throw new Error("integration.isolation.pty-receipt");
  }
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
  requireSettledMockServerClients();
  await preparedImageFor(plan.baseImage, signal);
  const { context, requiresHarnessBuildContextBound } = stageBuildContext(plan);
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
    maximumBuildContextBytes: requiresHarnessBuildContextBound
      ? IMAGE_PREPARATION_LIMITS.maximumHarnessBuildContextBytes
      : IMAGE_PREPARATION_LIMITS.defaultMaximumBuildContextBytes,
    signal,
    tag: plan.imageTag,
  });
};
const prepareMockServerImage = async (plan, signal) => {
  requireSettledMockServerClients();
  await preparedImageFor(plan.mockServerImage, signal);
  const control = mockServerControls.get(plan.runId);
  if (control === undefined || mockServerBuiltImages.has(plan.runId))
    throw new Error("integration.isolation.context");
  try {
    const client = createPreparedDockerClient(preparedImageEvidence, {
      dockerEnvironment: capability.binding.dockerEnvironment,
      dockerExecutable: capability.binding.dockerExecutable,
    });
    const owned = { client, imageId: undefined };
    mockServerBuiltImages.set(plan.runId, owned);
    const built = await prepareMockServerService(
      {
        dockerClient: client,
        privateRoot: capability.binding.privateStorage.root,
        runId: plan.runId,
        deadline:
          performance.now() +
          remainingIntegrationOperationMilliseconds(
            Math.min(
              scenarioTimeoutMilliseconds,
              IMAGE_PREPARATION_LIMITS.maximumPreparationMilliseconds,
            ),
          ),
        signal,
      },
      {
        ...control.material,
        expectations: control.expectations,
        tag: plan.mockServerImageTag,
      },
    );
    owned.imageId = built.imageId.replace("sha256-", "sha256:");
    return built.imageId;
  } catch (error) {
    // A failed service prefix may have created an image without returning its
    // exact identity. Preserve all owned clients; do not guess safe retirement.
    markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
    throw error;
  }
};
const buildMockServerImage = async (plan, signal) => {
  const imageId = mockServerBuiltImages.get(plan.runId)?.imageId;
  if (imageId === undefined) throw new Error("integration.isolation.context");
  const { stdout } = await dockerWithSignal(
    ["image", "inspect", plan.mockServerImageTag],
    signal,
  );
  const records = JSON.parse(stdout);
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    records[0]?.Id !== imageId ||
    records[0]?.Config?.Labels?.["com.agentscope.integration.run"] !==
      plan.runId
  )
    throw new Error("integration.isolation.image-digest");
  return imageId.replace("sha256:", "sha256-");
};
const mockServerRetirementSignal = (deadline) => {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error("integration.images.deadline");
  return AbortSignal.timeout(remaining);
};
const requireSettledMockServerClients = () => {
  if (
    [...mockServerBuiltImages.values()].some(({ client }) =>
      preparedDockerClientRequiresOuterHostRetirement(client),
    )
  )
    markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
  if (preparedDockerClientRequiresOuterHostRetirement(preparedDockerClient))
    throw new Error("integration.controller.unsettled-operation");
};
const retireMockServerImage = async (plan, signal, deadline) => {
  requireSettledMockServerClients();
  const owned = mockServerBuiltImages.get(plan.runId);
  if (owned === undefined) return;
  try {
    const closeReserve = IMAGE_PREPARATION_LIMITS.maximumTeardownMilliseconds;
    if (owned.imageId !== undefined)
      await retirePreparedDockerImage(owned.client, {
        deadline: deadline - closeReserve,
        imageId: owned.imageId.replace("sha256:", "sha256-"),
        signal,
        tag: plan.mockServerImageTag,
      });
    if (performance.now() + closeReserve >= deadline)
      throw new Error("integration.images.deadline");
    closePreparedDockerClient(owned.client);
    mockServerBuiltImages.delete(plan.runId);
  } catch (error) {
    markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
    throw error;
  }
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
  const internal = await registerPreparedDockerNetwork(preparedDockerClient, {
    deadline:
      performance.now() + remainingIntegrationOperationMilliseconds(30_000),
    name: plan.networkName,
    runId: plan.runId,
    signal,
  });
  if (!internal) {
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
const inspectControlVolume = async (name, signal) => {
  const { stdout } = await dockerWithSignal(
    ["volume", "inspect", name],
    signal,
  );
  const records = JSON.parse(stdout);
  if (!Array.isArray(records) || records.length !== 1)
    throw new Error("integration.isolation.control-volume");
  return records[0];
};
const exactControlVolumePresent = async (name, signal) => {
  const { stdout } = await dockerWithSignal(
    ["volume", "ls", "--quiet", "--filter", `name=${name}`],
    signal,
  );
  const names = stdout.trim() === "" ? [] : stdout.trim().split("\n");
  if (
    names.length > 256 ||
    names.some((value) => !/^[a-z0-9][a-z0-9_.-]{0,255}$/u.test(value)) ||
    names.filter((value) => value === name).length > 1
  )
    throw new Error("integration.isolation.control-volume");
  return names.includes(name);
};
const createControlVolume = async (plan, signal) => {
  const name = plan.controlVolumeName;
  if (
    name !== `agentscope-int-${plan.runId}-control` ||
    controlVolumeIdentities.has(plan.runId)
  )
    throw new Error("integration.isolation.control-volume");
  if (await exactControlVolumePresent(name, signal))
    throw new Error("integration.isolation.control-volume");
  await dockerWithSignal(
    ["volume", "create", "--driver", "local", ...labelArguments(plan), name],
    signal,
    { mutationCapable: true },
  );
  try {
    const volume = await registerPreparedDockerControlVolume(
      preparedDockerClient,
      {
        deadline:
          performance.now() + remainingIntegrationOperationMilliseconds(30_000),
        name,
        runId: plan.runId,
        signal,
      },
    );
    controlVolumeIdentities.set(plan.runId, {
      name,
      createdAt: volume.createdAt,
      mountpoint: volume.mountpoint,
    });
  } catch (error) {
    markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
    throw error;
  }
};
const assertControlVolumeCurrent = async (plan, signal) => {
  const expected = controlVolumeIdentities.get(plan.runId);
  if (expected?.name !== plan.controlVolumeName)
    throw new Error("integration.isolation.control-volume");
  try {
    const current = await inspectControlVolume(expected.name, signal);
    if (
      current?.Name !== expected.name ||
      current?.CreatedAt !== expected.createdAt ||
      current?.Mountpoint !== expected.mountpoint ||
      current?.Labels?.["com.agentscope.integration.run"] !== plan.runId
    )
      throw new Error("integration.isolation.control-volume");
  } catch (error) {
    markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
    throw error;
  }
};
const startDestinationSidecar = async (plan, signal, mode) => {
  if (mode !== "ingestion" && mode !== "retrieval")
    throw new Error("integration.isolation.context");
  const kind = mode === "ingestion" ? "collector" : "retrieval";
  const secureCollector = mode === "ingestion" && isNativeTraceScenario(plan);
  try {
    await dockerWithSignal(
      [
        "create",
        "--platform",
        canonicalImagePlatform,
        "--name",
        plan[`${kind}Name`],
        ...labelArguments(plan),
        "--network",
        plan.networkName,
        "--network-alias",
        kind,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        ...sidecarResourceArguments(ISOLATION_EXECUTOR_LIMITS.containers[kind]),
        "--user",
        "1000:1000",
        ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers[kind]),
        "--env",
        `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
        "--env",
        `AGENTSCOPE_MAXIMUM_REQUEST_BYTES=${ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes}`,
        ...(secureCollector
          ? [
              "--env",
              `AGENTSCOPE_COLLECTOR_TLS_CERT=${collectorTlsCertificate}`,
              "--env",
              `AGENTSCOPE_COLLECTOR_TLS_KEY=${collectorTlsKey}`,
            ]
          : []),
        plan.imageTag,
        "node",
        "/opt/agentscope/destination-server.mjs",
        mode,
      ],
      signal,
      { mutationCapable: true },
    );
  } catch (error) {
    // Native exec errors can carry argv: collapse only this test-key boundary.
    // dockerWithSignal already preserves uncertain mutation/retirement state.
    if (secureCollector)
      // eslint-disable-next-line preserve-caught-error -- native argv contains the public test leaf key; no raw cause crosses diagnostics
      throw new Error("integration.isolation.collector-create");
    throw error;
  }
  const containerId = await assertContainer(
    plan,
    plan[`${kind}Name`],
    ISOLATION_EXECUTOR_LIMITS.containers[kind],
    signal,
    ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes,
  );
  if (secureCollector)
    scenarioContainerIdentities.set(plan.collectorName, containerId);
  await dockerWithSignal(["start", plan[`${kind}Name`]], signal, {
    mutationCapable: true,
  });
};
const startCollector = (plan, signal) =>
  startDestinationSidecar(plan, signal, "ingestion");
const startRetrieval = (plan, signal) =>
  startDestinationSidecar(plan, signal, "retrieval");
const decodeCollectorSnapshot = (output, plan) => {
  const refuse = () => new Error("integration.isolation.collector-terminal");
  let observation;
  try {
    observation = JSON.parse(output.stdout);
  } catch {
    throw refuse();
  }
  if (
    observation?.observationVersion !== 2 ||
    JSON.stringify(Object.keys(observation).sort()) !==
      JSON.stringify([
        "aggregateBytes",
        "batches",
        "observationVersion",
        "scenarioId",
      ]) ||
    observation.scenarioId !== plan.scenarioId ||
    !Array.isArray(observation.batches) ||
    observation.batches.length === 0 ||
    observation.batches.length > 8 ||
    !Number.isSafeInteger(observation.aggregateBytes) ||
    observation.aggregateBytes <= 0 ||
    observation.aggregateBytes > 8 * 1024 * 1024
  )
    throw refuse();
  const batches = observation.batches.map((value) => {
    if (typeof value !== "string" || value.length > 1398104) throw refuse();
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || bytes.length > 1024 * 1024)
      throw refuse();
    return bytes;
  });
  if (
    batches.reduce((bytes, batch) => bytes + batch.length, 0) !==
    observation.aggregateBytes
  )
    throw refuse();
  return batches;
};
const joinCollectorObservations = async (plan, signal, deadline) => {
  const refuse = () => new Error("integration.isolation.collector-terminal");
  const containerId = scenarioContainerIdentities.get(plan.collectorName);
  if (!/^[a-f0-9]{64}$/u.test(containerId ?? "")) throw refuse();
  const remaining = Math.floor(deadline - linuxBootMonotonicMilliseconds());
  if (remaining <= 0) throw refuse();
  const joinSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
  const current = await assertContainer(
    plan,
    plan.collectorName,
    ISOLATION_EXECUTOR_LIMITS.containers.collector,
    joinSignal,
    ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes,
  );
  if (current !== containerId) throw refuse();
  let output;
  try {
    output = await dockerWithSignal(
      [
        "exec",
        containerId,
        "/usr/local/bin/node",
        "--input-type=module",
        "-e",
        'import {get} from "node:https"; import {readFileSync} from "node:fs"; const request=get("https://127.0.0.1:4318/observations",{ca:readFileSync("/opt/agentscope/collector-ca.pem"),agent:false},response=>{let bytes=0;const chunks=[];response.on("data",chunk=>{bytes+=chunk.length;if(bytes>12*1024*1024)request.destroy();else chunks.push(chunk);});response.once("end",()=>{if(response.statusCode!==200)process.exitCode=1;else process.stdout.write(Buffer.concat(chunks));});response.once("error",()=>{process.exitCode=1;});});request.once("error",()=>{process.exitCode=1;});',
      ],
      joinSignal,
      { terminal: true, maxBuffer: 12 * 1024 * 1024 },
    );
  } catch {
    // Native exec errors can contain original received bytes; never propagate
    // output or cause through the controller's diagnostic error boundary.
    throw refuse();
  }
  const batches = decodeCollectorSnapshot(output, plan);
  const waited = await dockerWithSignal(
    ["container", "wait", containerId],
    joinSignal,
    { terminal: true },
  );
  const inspected = JSON.parse(
    (
      await dockerWithSignal(
        ["container", "inspect", containerId],
        joinSignal,
        {
          terminal: true,
        },
      )
    ).stdout,
  );
  const terminal =
    Array.isArray(inspected) && inspected.length === 1
      ? inspected[0]
      : undefined;
  if (
    waited.stdout !== "0\n" ||
    terminal?.Id !== containerId ||
    terminal.Name !== `/${plan.collectorName}` ||
    terminal.Config?.Labels?.["com.agentscope.integration.run"] !==
      plan.runId ||
    terminal.State?.Status !== "exited" ||
    terminal.State.Running !== false ||
    terminal.State.OOMKilled !== false ||
    terminal.State.Paused !== false ||
    terminal.State.Restarting !== false ||
    terminal.State.Dead !== false ||
    terminal.State.ExitCode !== 0 ||
    terminal.State.Pid !== 0 ||
    terminal.State.Error !== ""
  )
    throw refuse();
  return batches;
};
const mockServerNetworkObservation = (server, network) => {
  const own = (value, key) =>
    value !== null && typeof value === "object" && !types.isProxy(value)
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;
  const state = own(server, "State");
  const status = own(state, "Status");
  const exit = own(state, "ExitCode");
  const networks = own(own(server, "NetworkSettings"), "Networks");
  const count =
    networks && typeof networks === "object" && !types.isProxy(networks)
      ? Reflect.ownKeys(networks).length
      : undefined;
  const boolean = (value) => (typeof value === "boolean" ? value : null);
  const ip = own(network, "IPAddress");
  return {
    diagnosticVersion: 1,
    trust: "untrusted-diagnostic",
    stage: "mockserver-network-refusal",
    status: [
      "created",
      "running",
      "exited",
      "dead",
      "paused",
      "restarting",
      "removing",
    ].includes(status)
      ? status
      : "unknown",
    running: boolean(own(state, "Running")),
    oomKilled: boolean(own(state, "OOMKilled")),
    exitCode: Number.isInteger(exit) && exit >= 0 && exit <= 255 ? exit : null,
    networkCount: Number.isInteger(count) && count <= 16 ? count : null,
    ipPresent: typeof ip === "string" && /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(ip),
  };
};
const mockServerStartupObservation = (output) => {
  if (typeof output !== "object" || output === null || types.isProxy(output))
    return "unknown";
  const streams = ["stdout", "stderr"].map((key) =>
    Object.getOwnPropertyDescriptor(output, key),
  );
  if (
    streams.some(
      (value) =>
        value !== undefined &&
        (!Object.hasOwn(value, "value") || typeof value.value !== "string"),
    )
  )
    return "unknown";
  const values = streams.map((value) => value?.value ?? "");
  if (
    values.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0) > 65536
  )
    return "unknown";
  const phases = ["entry", "directory", "private-key", "jwks", "java-entry"];
  let count = 0;
  for (const line of values.join("\n").split("\n")) {
    if (!line.startsWith("[agentscope-mockserver:")) continue;
    if (line !== `[agentscope-mockserver:v1 phase=${phases[count]}]`)
      return "unknown";
    count += 1;
  }
  return phases[count - 1] ?? "unknown";
};
const startMockServer = async (plan, signal) => {
  await assertControlVolumeCurrent(plan, signal);
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
      "--user",
      "0:0",
      "--mount",
      `type=volume,source=${plan.controlVolumeName},target=/control`,
      ...sidecarResourceArguments(
        ISOLATION_EXECUTOR_LIMITS.containers.mockServer,
      ),
      ...tmpfsArguments(ISOLATION_EXECUTOR_LIMITS.containers.mockServer, false),
      ...[
        "MOCKSERVER_INITIALIZATION_JSON_PATH=/config/expectations.json",
        "MOCKSERVER_LOG_LEVEL=WARN",
        "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_REQUIRED=true",
        "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_JWK_SOURCE=/control/private/control-jwks.json",
        `MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_EXPECTED_AUDIENCE=agentscope:${plan.runId}`,
        `MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_MATCHING_CLAIMS=runId=${plan.runId}`,
        "MOCKSERVER_CONTROL_PLANE_JWT_AUTHENTICATION_REQUIRED_CLAIMS=runId",
        "MOCKSERVER_PERSIST_RECORDED_REQUESTS_TO_DISK=true",
        "MOCKSERVER_PERSISTED_RECORDED_REQUESTS_PATH=/control/private/requests.json",
      ].flatMap((value) => ["--env", value]),
      mockServerBuiltImages.get(plan.runId)?.imageId,
    ],
    signal,
    { mutationCapable: true },
  );
  const containerId = await assertContainer(
    plan,
    plan.mockServerName,
    ISOLATION_EXECUTOR_LIMITS.containers.mockServer,
    signal,
  );
  await dockerWithSignal(["start", plan.mockServerName], signal, {
    mutationCapable: true,
  });
  const inspected = JSON.parse(
    (await dockerWithSignal(["container", "inspect", containerId], signal))
      .stdout,
  );
  const server =
    Array.isArray(inspected) && inspected.length === 1
      ? inspected[0]
      : undefined;
  if (server?.Image !== mockServerBuiltImages.get(plan.runId)?.imageId)
    throw new Error("integration.isolation.mockserver-image");
  const network = server.NetworkSettings?.Networks?.[plan.networkName];
  if (
    !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(network?.IPAddress ?? "") ||
    Object.keys(server.NetworkSettings.Networks).length !== 1
  ) {
    let startupPhase = "unknown";
    try {
      startupPhase = mockServerStartupObservation(
        await dockerWithSignal(["logs", "--tail", "64", containerId], signal, {
          maxBuffer: 65536,
        }),
      );
    } catch {
      // A failed optional read cannot replace or weaken the original refusal.
    }
    try {
      console.error(
        "integration.isolation.mockserver-network-diagnostic:" +
          JSON.stringify({
            ...mockServerNetworkObservation(server, network),
            startupPhase,
          }),
      );
    } catch {
      // Optional content-free projection never replaces the original refusal.
    }
    throw new Error("integration.isolation.mockserver-network");
  }
  mockServerControls.get(plan.runId).host = network.IPAddress;
  mockServerContainerIdentities.set(plan.runId, containerId);
};
const codexCollectorExpectation = (plan, native) => {
  const scenario = manifest.scenarios.find(
    (entry) => entry.scenarioId === plan.scenarioId,
  );
  const selected = manifest.evidence.find(
    (entry) => entry.evidenceId === scenario?.harnessEvidenceId,
  );
  if (
    selected?.harnessId !== "codex" ||
    selected.representativeVersion !== "0.149.1"
  )
    throw new Error("integration.isolation.collector-native");
  const turnIdentity = `codex:${native.nativeTurnId}`;
  const identity = deriveIdentityBundle({
    harnessRegistryId: "codex",
    operationIdScope: "session-global",
    session: { kind: "boundary-scoped" },
    boundary: {
      kind: "hook-invocation",
      id: turnIdentity,
      generation: 0,
      positionKind: "sequence",
      exclusiveEndPosition: 1,
    },
    operations: [
      {
        logicalKey: "codex-turn",
        locator: { kind: "native-operation", nativeId: turnIdentity },
      },
      {
        logicalKey: "codex-llm",
        parentLogicalKey: "codex-turn",
        locator: {
          kind: "native-operation",
          nativeId: `${turnIdentity}:llm`,
        },
      },
    ],
  });
  return {
    harness: { name: "codex", version: selected.representativeVersion },
    sessionId: native.nativeSessionId,
    modelName: native.nativeModelName,
    identity: {
      traceId: identity.traceId,
      spanIds: [identity.spans["codex-turn"], identity.spans["codex-llm"]],
    },
    unavailableContext: [
      ...[
        "agentscope.git.worktree",
        "agentscope.git.repository_root",
        "vcs.ref.head.name",
        "vcs.ref.head.revision",
        "vcs.ref.type",
      ].map((field) => ({
        field,
        source: "git",
        state: "unavailable",
        reason: "resolution-failed",
      })),
      {
        field: "agentscope.workspace.directory",
        source: "hook-payload",
        state: "redacted",
        reason: "policy-redacted",
      },
    ],
  };
};
const completeCodexCollectorFixture = (plan, batches) => {
  const fixture = fixtureResults.get(plan.runId);
  const native = fixture?.harnessObservation;
  if (
    fixture?.resultStatus !== "partial" ||
    native?.kind !== "codex-tui-native"
  )
    throw new Error("integration.isolation.collector-native");
  // This selected turn emits one complete canonical unit. Extra batches are
  // not silently discarded or promoted to a proof of unrelated sessions.
  if (batches.length !== 1)
    throw new Error("integration.isolation.collector-native");
  const expected = codexCollectorExpectation(plan, native);
  const observed = observeSelectedWriterOtlp(
    batches[0],
    ["DUMMY_PUBLIC_KEY", "DUMMY_SECRET_KEY", "/worktree"],
    expected,
  );
  const spans = observed.graph.resourceSpans[0].scopeSpans[0].spans;
  const root = spans.find((span) => span.parentSpanId === undefined);
  const model = spans.find((span) => span.parentSpanId === root?.spanId);
  if (
    spans.length !== 2 ||
    root?.name !== "codex.turn" ||
    model?.name !== "codex.response" ||
    root.spanId !== expected.identity.spanIds[0] ||
    model.spanId !== expected.identity.spanIds[1]
  )
    throw new Error("integration.isolation.collector-native");
  fixtureResults.set(
    plan.runId,
    sanitizeFixtureResult(
      {
        ...fixture,
        resultStatus: "complete",
        lifecycle: [
          "install",
          "configure",
          "hook",
          "execute",
          "export",
          "retrieve",
          "uninstall",
        ],
        eventKinds: ["hook", "model", "destination"],
        harnessObservation: {
          observationVersion: 1,
          kind: "codex-tui-trace",
          canonicalGraphDigest: observed.transport.graphSha256,
          spanIds: [root.spanId, model.spanId],
          contextDisposition: "unversioned-workspace-redacted",
          nativeSessionId: native.nativeSessionId,
          nativeTurnId: native.nativeTurnId,
          nativeModelName: native.nativeModelName,
          ...(native.nativeTranscriptRange === undefined
            ? {}
            : { nativeTranscriptRange: native.nativeTranscriptRange }),
          modelRequestBodySha256: native.modelRequestBodySha256,
          traceId: expected.identity.traceId,
          resourceSpanCount: observed.graph.resourceSpans.length,
          spanNames: [root.name, model.name],
          parentLinked: model.parentSpanId === root.spanId,
          doctorErrors: native.doctorErrors,
          uninstallDisposition: native.uninstallDisposition,
          sessionStartCommandDurationMilliseconds:
            native.sessionStartCommandDurationMilliseconds,
        },
        destinationLedger: {
          ledgerVersion: 1,
          scenarioId: plan.scenarioId,
          ingestion: [
            {
              operation: "otlp",
              method: "POST",
              path: "/api/public/otel/v1/traces",
              bodyBytes: batches[0].byteLength,
              outcome: "accepted",
            },
          ],
          retrieval: [],
        },
      },
      plan.scenarioId,
    ),
  );
};
const claudeCollectorExpectation = (plan, native) => ({
  harness: {
    name: "claude-code",
    version: evidenceById.get(
      manifest.scenarios.find((entry) => entry.scenarioId === plan.scenarioId)
        ?.harnessEvidenceId,
    )?.representativeVersion,
  },
  sessionId: native.nativeSessionId,
  // The public Claude mapper does not emit a model for these hook graphs.
  // An optional actual native transcript model remains independent evidence.
  unavailableContext: [
    ...[
      "agentscope.git.worktree",
      "agentscope.git.repository_root",
      "vcs.ref.head.name",
      "vcs.ref.head.revision",
      "vcs.ref.type",
    ].map((field) => ({
      field,
      source: "git",
      state: "unavailable",
      reason: "resolution-failed",
    })),
    {
      field: "agentscope.workspace.directory",
      source: "hook-payload",
      state: "redacted",
      reason: "policy-redacted",
    },
  ],
});
const completeClaudeCollectorFixture = (plan, batches, ledger) => {
  const fixture = fixtureResults.get(plan.runId);
  const native = fixture?.harnessObservation;
  const primary = ledger.filter(
    (row) =>
      row.role === "data-plane" &&
      row.method === "POST" &&
      row.path === "/v1/messages",
  );
  if (
    fixture?.resultStatus !== "partial" ||
    native?.kind !== "claude-code-native" ||
    batches.length !== 4 ||
    primary.length !== 2 ||
    primary.some(
      (row, index) => row.bodySha256 !== native.modelRequestBodySha256[index],
    )
  )
    throw new Error("integration.isolation.collector-native");
  const hookObservations = batches.map((bytes, index) => {
    const observed = observeSelectedWriterOtlp(
      bytes,
      ["DUMMY_PUBLIC_KEY", "DUMMY_SECRET_KEY", "/worktree"],
      claudeCollectorExpectation(plan, native),
    );
    const spans = observed.graph.resourceSpans[0].scopeSpans[0].spans;
    const root = spans.find((span) => span.parentSpanId === undefined);
    const child = spans.find((span) => span.parentSpanId === root?.spanId);
    const fields = (span) =>
      new Map(
        (span?.attributes ?? []).map(({ key, value }) => [
          key,
          value.stringValue,
        ]),
      );
    const eventName = ["SessionStart", "PreToolUse", "PostToolUse", "Stop"][
      index
    ];
    if (
      fields(root).get("openinference.span.kind") !== "AGENT" ||
      (index === 0
        ? spans.length !== 1 || root?.name !== "claude.SessionStart"
        : spans.length !== 2 ||
          root?.name !== "claude.hook-invocation" ||
          child?.parentSpanId !== root.spanId ||
          child.traceId !== root.traceId ||
          fields(child).get("openinference.span.kind") !==
            (index === 3 ? "LLM" : "TOOL") ||
          child.name !== (index === 3 ? "claude.Stop" : "Read") ||
          (index !== 3 &&
            (fields(child).get("tool.id") !== native.nativeToolUseId ||
              fields(child).get("input.mime_type") !== "application/json")) ||
          (index === 1 &&
            fields(child).get("output.mime_type") !== undefined) ||
          (index === 2 &&
            fields(child).get("output.mime_type") !== "application/json"))
    )
      throw new Error("integration.isolation.collector-native");
    // Graphs are ephemeral. Only reviewed content-free identities/digests and
    // categorical checks leave this oracle through the existing result shape.
    return {
      eventName,
      traceId: root.traceId,
      spanIds: index === 0 ? [root.spanId] : [root.spanId, child.spanId],
      canonicalGraphDigest: observed.transport.graphSha256,
      contextDisposition: "unversioned-workspace-redacted",
    };
  });
  if (new Set(hookObservations.map((row) => row.traceId)).size !== 4)
    throw new Error("integration.isolation.collector-native");
  fixtureResults.set(
    plan.runId,
    sanitizeFixtureResult(
      {
        ...fixture,
        resultStatus: "complete",
        lifecycle: [
          "install",
          "configure",
          "hook",
          "execute",
          "export",
          "retrieve",
          "uninstall",
        ],
        eventKinds: ["hook", "model", "destination"],
        harnessObservation: {
          ...native,
          kind: "claude-code-trace",
          hookObservations,
        },
        destinationLedger: {
          ledgerVersion: 1,
          scenarioId: plan.scenarioId,
          ingestion: batches.map((bytes) => ({
            operation: "otlp",
            method: "POST",
            path: "/api/public/otel/v1/traces",
            bodyBytes: bytes.byteLength,
            outcome: "accepted",
          })),
          retrieval: [],
        },
      },
      plan.scenarioId,
    ),
  );
};
// eslint-disable-next-line complexity -- exact closed container terminal witness
const joinMockServer = async (plan, signal) => {
  const containerId = mockServerContainerIdentities.get(plan.runId);
  const deadline = mockServerJoinDeadlines.get(plan.runId);
  if (!/^[a-f0-9]{64}$/u.test(containerId ?? "") || !Number.isFinite(deadline))
    throw new Error("integration.isolation.mockserver-terminal");
  const remaining = Math.floor(deadline - linuxBootMonotonicMilliseconds());
  if (remaining <= 0)
    throw new Error("integration.isolation.mockserver-terminal");
  const joinSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
  await assertControlVolumeCurrent(plan, joinSignal);
  const authority = mockServerControls.get(plan.runId);
  const control = openMockServerControl({
    runId: plan.runId,
    host: authority?.host,
    deadline,
    now: linuxBootMonotonicMilliseconds,
    material: authority?.material,
  });
  await verifyMockServerControlBoundary(control);
  if ((await control.stop()).status !== 200)
    throw new Error("integration.isolation.mockserver-terminal");
  const waited = await dockerWithSignal(
    ["container", "wait", containerId],
    joinSignal,
    { terminal: true },
  );
  const inspected = await dockerWithSignal(
    ["container", "inspect", containerId],
    joinSignal,
    { terminal: true },
  );
  let records;
  try {
    records = JSON.parse(inspected.stdout);
  } catch {
    throw new Error("integration.isolation.mockserver-terminal");
  }
  const container =
    Array.isArray(records) && records.length === 1 ? records[0] : undefined;
  const state = container?.State;
  const labels = container?.Config?.Labels;
  if (
    waited.stdout !== "0\n" ||
    container?.Id !== containerId ||
    container?.Name !== `/${plan.mockServerName}` ||
    labels?.["com.agentscope.integration"] !== "true" ||
    labels?.["com.agentscope.integration.run"] !== plan.runId ||
    state?.Status !== "exited" ||
    state?.Running !== false ||
    state?.Paused !== false ||
    state?.Restarting !== false ||
    state?.OOMKilled !== false ||
    state?.Dead !== false ||
    state?.Pid !== 0 ||
    state?.ExitCode !== 0 ||
    state?.Error !== "" ||
    typeof state?.FinishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
      state.FinishedAt,
    )
  )
    throw new Error("integration.isolation.mockserver-terminal");
  const ledgerDirectory = resolve(
    artifactsRoot,
    "contexts",
    plan.runId,
    "final-ledger",
  );
  mkdirSync(ledgerDirectory, { mode: 0o700 });
  for (const name of ["requests.json", "requests.complete"])
    await dockerWithSignal(
      [
        "cp",
        `${containerId}:/control/private/${name}`,
        resolve(ledgerDirectory, name),
      ],
      joinSignal,
      { terminal: true, mutationCapable: true },
    );
  const ledger = projectMockServerRequests(
    readMockServerFinalLedger({
      directory: ledgerDirectory,
      deadline,
      now: linuxBootMonotonicMilliseconds,
    }),
  );
  assertMockServerFinalLedger(
    ledger,
    fixtureResults.get(plan.runId),
    modelRoutes,
    manifest.scenarios.find((entry) => entry.scenarioId === plan.scenarioId),
    {
      traffic: {
        runId: plan.runId,
        entries: [
          ...(fixtureTrafficObservations.get(plan.runId)?.entries ?? []),
          ...control.snapshot().entries,
        ],
      },
      runId: plan.runId,
    },
  );
  if (plan.scenarioId === "codex-tui-trace-smoke") {
    const batches = await joinCollectorObservations(plan, joinSignal, deadline);
    completeCodexCollectorFixture(plan, batches);
  }
  if (plan.scenarioId === "claude-interactive-trace-smoke") {
    const batches = await joinCollectorObservations(plan, joinSignal, deadline);
    completeClaudeCollectorFixture(plan, batches, ledger);
  }
};
const createScenarioContainer = async (
  plan,
  signal,
  outerMonotonicDeadline,
  immutableCandidate,
) => {
  if (plan.controlVolumeName !== null)
    await assertControlVolumeCurrent(plan, signal);
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
      ...(plan.controlVolumeName === null
        ? []
        : [
            "--mount",
            `type=volume,source=${plan.controlVolumeName},target=/control`,
          ]),
      ...[
        `HOME=${SCENARIO_HOME}`,
        "XDG_CONFIG_HOME=/harness-home",
        "HARNESS_HOME=/harness-home",
        "AGENTSCOPE_HOME=/agentscope-home",
        "AGENTSCOPE_WORKTREE=/worktree",
        "AGENTSCOPE_LEDGER=/ledger",
        "AGENTSCOPE_CANDIDATE_ROOT=/opt/agentscope/prepared",
        "AGENTSCOPE_COLLECTOR_URL=http://collector:4318",
        "AGENTSCOPE_INGESTION_URL=http://collector:4318",
        "AGENTSCOPE_RETRIEVAL_URL=http://retrieval:4319",
        "AGENTSCOPE_MODEL_SERVER_URL=http://mockserver:1080",
        `AGENTSCOPE_SCENARIO_ID=${plan.scenarioId}`,
        `AGENTSCOPE_INTEGRATION_RUN_ID=${plan.runId}`,
        `AGENTSCOPE_HEADLESS_OUTER_MONOTONIC_DEADLINE_MS=${outerMonotonicDeadline}`,
        `AGENTSCOPE_IMMUTABLE_CANDIDATE_AUTHORITY=${immutableCandidate.encoded}`,
      ].flatMap((value) => ["--env", value]),
      ...testModeArguments,
      ...certificationArguments,
      plan.imageTag,
    ],
    signal,
    { mutationCapable: true },
  );
  const containerId = await assertContainer(
    plan,
    plan.scenarioName,
    ISOLATION_EXECUTOR_LIMITS.containers.scenario,
    signal,
    undefined,
    immutableCandidate,
  );
  if (scenarioContainerIdentities.has(plan.runId))
    throw new Error("integration.isolation.container");
  scenarioContainerIdentities.set(plan.runId, containerId);
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
const scenarioReceiptSucceeded = (plan, receipt) => {
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
      (receipt.eofByteWritten === (plan.terminalAction === "eof") &&
        receipt.terminalInputJoined === true &&
        receipt.terminalOutputJoined === true &&
        receipt.terminalTransportClosed === true))
  );
};
const interactiveReceiptFailurePredicate = (plan, receipt, fixtureCaptured) => {
  if (receipt.outcome !== "completed") return "completion-state";
  if (receipt.finalSnapshot?.semanticState !== "completed")
    return "completion-state";
  if (receipt.exitCode !== 0) return "exit-code";
  if (receipt.signal !== null) return "signal";
  if (receipt.cleanup !== "clean") return "cleanup";
  if (receipt.residualProcessCount !== 0) return "residual-process";
  if (receipt.processJoined !== true) return "process-join";
  if (receipt.eofByteWritten !== (plan.terminalAction === "eof"))
    return "eof-action";
  if (receipt.terminalInputJoined !== true) return "terminal-input-join";
  if (receipt.terminalOutputJoined !== true) return "terminal-output-join";
  if (receipt.terminalTransportClosed !== true) return "transport-close";
  if (!fixtureCaptured) return "fixture-result";
  return undefined;
};
const recordInteractiveReceiptFailure = (
  plan,
  receipt,
  fixtureCaptured,
  fallback = "receipt-rejected",
) => {
  if (
    plan.executionMode !== "interactive" ||
    installedPtyFailures.has(plan.runId)
  )
    return;
  installedPtyFailures.set(plan.runId, {
    receiptVersion: 1,
    phase: "pty-receipt",
    predicate:
      (receipt === undefined
        ? undefined
        : interactiveReceiptFailurePredicate(plan, receipt, fixtureCaptured)) ??
      fallback,
  });
};
const recordInteractiveExecutionFailure = (
  plan,
  error,
  output,
  retainedDiagnostic,
) => {
  if (plan.executionMode !== "interactive") return;
  const predicate = selectInteractiveExecutionFailurePredicate(
    contentFreeChildFailureCode(error, output),
    retainedDiagnostic,
    plan.scenarioId,
  );
  installedPtyFailures.set(plan.runId, {
    receiptVersion: 1,
    phase: "pty-execution",
    predicate,
  });
  return predicate;
};
const retainCodexResearchDiagnostic = (plan, output, receipt, error) => {
  if (plan.scenarioId !== "codex-tui-trace-smoke") return;
  codexResearchDiagnostics.set(
    plan.runId,
    createCodexFailureResearchRecord(
      plan,
      output,
      receipt,
      error,
      codexResearchDependencies,
    ),
  );
};
const captureFailedScenarioReceipt = (
  output,
  plan,
  outerMonotonicDeadline,
  fixtureCaptured,
) => {
  const receipt =
    plan.executionMode === "interactive"
      ? captureInteractivePtyReceipt(
          output,
          plan,
          { outerMonotonicDeadline },
          true,
        )
      : captureHeadlessReceipt(output, plan, { outerMonotonicDeadline });
  observeNegativeScenarioReceipt(plan, receipt, fixtureCaptured);
  registerScenarioReceipt(plan, receipt);
  recordInteractiveReceiptFailure(plan, receipt, fixtureCaptured);
  return receipt;
};
const captureAvailableFailedScenarioReceipt = (
  output,
  plan,
  outerMonotonicDeadline,
  fixtureCaptured,
) =>
  output.includes("AGENTSCOPE_HEADLESS_RECEIPT=") ||
  output.includes("AGENTSCOPE_INTERACTIVE_PTY_RECEIPT=")
    ? captureFailedScenarioReceipt(
        output,
        plan,
        outerMonotonicDeadline,
        fixtureCaptured,
      )
    : undefined;
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
const contentFreeChildFailureCode = (error, output) => {
  const source = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  const diagnostic =
    extractInteractiveChildDiagnostic(output) ??
    source.match(
      /integration\.runner\.interactive-diagnostic:((?:integration|testkit)\.[a-z0-9.-]{1,128})\b/u,
    )?.[1] ??
    source.match(/\b(?:integration|testkit)\.[a-z0-9.-]{1,128}\b/u)?.[0];
  return diagnostic ?? "integration.isolation.child-failure";
};
const proveFailedAttachSettled = async (error, plan, signal) => {
  if (signal.aborted) return false;
  const containerId = scenarioContainerIdentities.get(plan.runId);
  if (!/^[a-f0-9]{64}$/u.test(containerId ?? "")) return false;
  let waited;
  try {
    waited = await dockerWithSignal(["container", "wait", containerId], signal);
  } catch {
    return false;
  }
  let inspected;
  try {
    inspected = await dockerWithSignal(
      ["container", "inspect", containerId],
      signal,
    );
  } catch {
    return false;
  }
  let records;
  try {
    records = JSON.parse(inspected.stdout);
  } catch {
    return false;
  }
  try {
    const container =
      Array.isArray(records) && records.length === 1 ? records[0] : undefined;
    const proved = scenarioContainerTerminalWitness({
      attach: error,
      container,
      containerId,
      runId: plan.runId,
      scenarioName: plan.scenarioName,
      waitOutput: waited.stdout,
    });
    return proved;
  } catch {
    return false;
  }
};
const runScenario = async (plan, signal, scenarioDeadline) => {
  const remainingOuterMilliseconds = Math.min(
    scenarioDeadline - performance.now(),
    capability.binding.cleanupStartMonotonicMilliseconds - performance.now(),
  );
  if (remainingOuterMilliseconds < 40_000)
    throw new Error("integration.isolation.headless-authority");
  const outerMonotonicDeadline =
    linuxBootMonotonicMilliseconds() + remainingOuterMilliseconds - 10_000;
  mockServerJoinDeadlines.set(plan.runId, outerMonotonicDeadline + 10_000);
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
  let stdout;
  try {
    ({ stdout } = await dockerWithSignal(
      ["start", "--attach", plan.scenarioName],
      signal,
    ));
  } catch (error) {
    let terminalMutationProved = false;
    try {
      terminalMutationProved = await proveFailedAttachSettled(
        error,
        plan,
        signal,
      );
      if (!terminalMutationProved)
        throw new Error("integration.isolation.child-failure", {
          cause: error,
        });
      const output = `${error?.stdout ?? ""}`;
      const fixtureCaptured = captureFixtureResult(output, plan);
      const receipt = captureAvailableFailedScenarioReceipt(
        output,
        plan,
        outerMonotonicDeadline,
        fixtureCaptured,
      );
      retainCodexResearchDiagnostic(plan, output, receipt, error);
      const retainedDiagnostic =
        plan.executionMode === "interactive" &&
        receipt !== undefined &&
        receipt.exitCode === error?.code
          ? decodeInteractiveFailureExitCode(receipt.exitCode, plan.scenarioId)
          : undefined;
      recordInteractiveExecutionFailure(
        plan,
        error,
        output,
        retainedDiagnostic,
      );
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
      if (receipt !== undefined) return { receipt, succeeded: false };
      throw error;
    } catch (handledError) {
      if (!terminalMutationProved)
        markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
      throw handledError;
    }
  }
  const receipt =
    plan.executionMode === "interactive"
      ? captureInteractivePtyReceipt(stdout, plan, {
          outerMonotonicDeadline,
        })
      : captureHeadlessReceipt(stdout, plan, {
          outerMonotonicDeadline,
        });
  const fixtureCaptured = captureFixtureResult(stdout, plan);
  observeNegativeScenarioReceipt(plan, receipt, fixtureCaptured);
  registerScenarioReceipt(plan, receipt);
  if (plan.executionMode === "interactive") {
    const predicate = interactiveReceiptFailurePredicate(
      plan,
      receipt,
      fixtureCaptured,
    );
    if (predicate !== undefined)
      installedPtyFailures.set(plan.runId, {
        receiptVersion: 1,
        phase: "pty-receipt",
        predicate,
      });
  }
  return {
    receipt,
    succeeded: scenarioReceiptSucceeded(plan, receipt) && fixtureCaptured,
  };
};
// eslint-disable-next-line max-lines-per-function -- one atomic retained evidence settlement
const recordEvidence = async (evidence) => {
  const verifiedEvidence = compileIsolationEvidence(evidence, {
    baseImageIdentity: preparedIdentityFor(evidence.baseImage),
    mockServerImageIdentity: preparedIdentityFor(evidence.mockServerImage),
  });
  const directory = resolve(artifactsRoot, "runs", verifiedEvidence.runId);
  const admission = admissionByRunId.get(verifiedEvidence.runId);
  const retainedEvidence =
    admission === undefined
      ? verifiedEvidence
      : {
          ...verifiedEvidence,
          preparedHarnessMaterial: admission.preparedHarnessMaterial,
        };
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "evidence.json"),
    `${JSON.stringify(retainedEvidence, undefined, 2)}\n`,
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
  const successful =
    verifiedEvidence.outcome === "passed" &&
    verifiedEvidence.cleanup.outcome === "complete";
  if (
    successful &&
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
  if (admission !== undefined && successful) {
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
          preparedHarnessMaterial: admission.preparedHarnessMaterial,
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
    controllerFailureEvidenceVersion: 3,
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
    causalFailure:
      primaryError?.cause === undefined
        ? null
        : failureCode(primaryError.cause),
    cleanupFailure:
      cleanupError === undefined ? null : failureCode(cleanupError),
    installedPtyFailure: installedPtyFailures.get(plan.runId) ?? null,
    codexResearchDiagnostic: codexResearchDiagnostics.get(plan.runId) ?? null,
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
        image: buildkit.image,
        configDigest: buildkit.configDigest,
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
    {
      terminal: true,
      timeout: ISOLATION_EXECUTOR_LIMITS.cleanup.proofMilliseconds,
    },
  );
  return stdout.trim() === "" ? 0 : stdout.trim().split("\n").length;
};
// eslint-disable-next-line max-lines-per-function -- one exact run-owned Docker lifecycle
const createDriver = (plan) => {
  const scenarioDeadline = performance.now() + scenarioTimeoutMilliseconds;
  let removalSignal;
  let removalDeadline;
  let runtimeIdentity;
  const boundedRemovalSignal = () => {
    removalDeadline ??=
      performance.now() + ISOLATION_EXECUTOR_LIMITS.cleanup.removalMilliseconds;
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
    createControlVolume,
    startCollector,
    startRetrieval,
    startMockServer,
    joinMockServer,
    runScenario: (selectedPlan, signal) =>
      runScenario(selectedPlan, signal, scenarioDeadline),
    recordEvidence,
    removeContainer: (name) =>
      ignoreMissing(["rm", "--force", name], boundedRemovalSignal()),
    removeNetwork: async (name) => {
      if (substrateCertificationCase === "cleanup-failure") {
        observeSubstrateCertificationPredicate(
          plan.runId,
          SUBSTRATE_CERTIFICATION_PREDICATES[substrateCertificationCase],
        );
        throw new Error(
          `integration.certification.${substrateCertificationCase}`,
        );
      }
      const signal = boundedRemovalSignal();
      try {
        await retirePreparedDockerNetwork(preparedDockerClient, {
          deadline:
            performance.now() +
            remainingIntegrationOperationMilliseconds(30_000, true),
          name,
          runId: plan.runId,
          signal,
        });
      } catch (error) {
        throw new Error("integration.isolation.cleanup-network-remove", {
          cause: error,
        });
      }
    },
    removeControlVolume: async (name) => {
      const expected = controlVolumeIdentities.get(plan.runId);
      if (
        expected?.name !== name ||
        name !== `agentscope-int-${plan.runId}-control`
      )
        throw new Error("integration.isolation.cleanup-control-volume");
      const signal = boundedRemovalSignal();
      try {
        await retirePreparedDockerControlVolume(preparedDockerClient, {
          deadline:
            performance.now() +
            remainingIntegrationOperationMilliseconds(30_000, true),
          name,
          runId: plan.runId,
          signal,
        });
        controlVolumeIdentities.delete(plan.runId);
      } catch (error) {
        markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
        throw error;
      }
    },
    removeImage: (tag) =>
      tag === plan.mockServerImageTag
        ? retireMockServerImage(
            plan,
            boundedRemovalSignal(),
            Math.min(
              removalDeadline,
              performance.now() +
                remainingIntegrationOperationMilliseconds(30_000, true),
            ),
          )
        : ignoreMissing(
            ["image", "rm", "--force", tag],
            boundedRemovalSignal(),
          ),
    removeContext: async (runId) => {
      if (!/^[a-f\d]{16}$/u.test(runId))
        throw new Error("integration.isolation.context");
      rmSync(resolve(artifactsRoot, "contexts", runId), {
        force: true,
        recursive: true,
      });
      rmSync(activeMarkerFor(runId), { force: true });
      scenarioContainerIdentities.delete(runId);
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
const readAdmissionComponentFixture = (evidence) => {
  let descriptor;
  try {
    const artifact = evidence.admission.component.fixture;
    const path = resolve(workspaceRoot, artifact.path);
    if (!path.startsWith(`${workspaceRoot}/`))
      throw new Error("integration.harness-scenario-admission.invalid");
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.size < 1 || status.size > 16_777_216)
      throw new Error("integration.harness-scenario-admission.invalid");
    const buffer = Buffer.alloc(status.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (read === 0) break;
      length += read;
    }
    const bytes = buffer.subarray(0, length);
    if (
      bytes.length !== status.size ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new Error("integration.harness-scenario-admission.invalid");
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    // Filesystem/native parser errors must not disclose fixture content or paths.
    throw new Error("integration.harness-scenario-admission.invalid");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
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
    if (preparedMaterial === undefined || evidence.admission === undefined)
      continue;
    const materialAuthority = inspectPreparedHarnessMaterial(preparedMaterial);
    const image = preparedIdentityFor(scenario.image);
    admissionByRunId.set(plan.runId, {
      evidence,
      materialIdentity: materialAuthority.materialIdentity,
      preparedHarnessMaterial: materialAuthority,
      seed: {
        candidateDigest: candidate.bundleIdentity,
        componentFixture: readAdmissionComponentFixture(evidence),
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
  for (const plan of plans) {
    prepareMockServerControl(plan);
    await prepareMockServerImage(plan, integrationStageSignal());
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
  publishScenarioContextRefusals();
  if (
    [...mockServerBuiltImages.values()].some(({ client }) =>
      preparedDockerClientRequiresOuterHostRetirement(client),
    )
  )
    markPreparedDockerClientForOuterHostRetirement(preparedDockerClient);
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
    requireSettledMockServerClients();
    if (mockServerBuiltImages.size > 0) {
      const deadline =
        performance.now() +
        remainingIntegrationOperationMilliseconds(30_000, true);
      const signal = mockServerRetirementSignal(deadline);
      for (const plan of plans)
        await retireMockServerImage(plan, signal, deadline);
    }
  } catch (error) {
    retirementRequired = true;
    cleanupError = error;
    primaryError ??= error;
  }
  try {
    for (const material of preparedHarnessMaterials.values())
      retirePreparedHarnessMaterial(material);
  } catch (error) {
    cleanupError ??= error;
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
      for (const plan of plans) {
        fixtureResults.delete(plan.runId);
        fixtureTrafficObservations.delete(plan.runId);
      }
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
