import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  compileCapabilityManifest,
  compileIsolationEvidence,
  compileIsolationExecutionPolicy,
  createIsolationPlan,
  executeIsolationPlan,
  ISOLATION_EXECUTOR_LIMITS,
} from "./dist/index.js";

const integrationRoot = import.meta.dirname;
const runsRoot = resolve(integrationRoot, "../../artifacts/integration/runs");
mkdirSync(runsRoot, { recursive: true });
const label = "com.agentscope.integration=true";
const labeledContainers = () =>
  execFileSync(
    "docker",
    ["container", "ls", "--all", "--quiet", "--filter", `label=${label}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
const noResourcesRemain = () => {
  const checks = [
    ["container", "ls", "--all", "--quiet", "--filter", `label=${label}`],
    ["network", "ls", "--quiet", "--filter", `label=${label}`],
    ["image", "ls", "--quiet", "--filter", `label=${label}`],
  ];
  return checks.every(
    (arguments_) =>
      execFileSync("docker", arguments_, { encoding: "utf8" }).trim() === "",
  );
};
const runDirectories = () =>
  new Set(
    readdirSync(runsRoot, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? [entry.name] : [],
    ),
  );
const wait = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const runMode = async (mode, interrupt) => {
  const before = runDirectories();
  const child = spawn(
    process.execPath,
    [resolve(integrationRoot, "run-scenarios.mjs")],
    {
      env: { ...process.env, AGENTSCOPE_INTEGRATION_TEST_MODE: mode },
      stdio: "ignore",
    },
  );
  if (interrupt) {
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (labeledContainers().length > 0) {
        observed = true;
        break;
      }
      await wait(100);
    }
    if (!observed) throw new Error("integration.isolation.verify-start");
    child.kill("SIGINT");
  }
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  if (exitCode === 0) throw new Error("integration.isolation.verify-exit");
  if (!noResourcesRemain())
    throw new Error("integration.isolation.verify-cleanup");
  const created = [...runDirectories()].filter((name) => !before.has(name));
  if (created.length !== 1)
    throw new Error("integration.isolation.verify-evidence");
  return JSON.parse(
    readFileSync(resolve(runsRoot, created[0], "evidence.json"), "utf8"),
  );
};

const failure = await runMode("failure", false);
const preparedAuthority = {
  baseImageIdentity: failure.baseImageIdentity,
  mockServerImageIdentity: failure.mockServerImageIdentity,
};
if (
  compileIsolationEvidence(failure, preparedAuthority).outcome !== "failed" ||
  failure.evidenceVersion !== 2 ||
  failure.cleanup?.outcome !== "complete" ||
  Object.values(failure.cleanup.remaining ?? {}).some((count) => count !== 0)
)
  throw new Error("integration.isolation.verify-failure");
for (const substitution of [
  { ...failure, scenarioId: "different-scenario" },
  {
    ...failure,
    executionPolicy: {
      ...failure.executionPolicy,
      selection: {
        ...failure.executionPolicy.selection,
        manifestIdentity: `sha256-${"0".repeat(64)}`,
      },
    },
  },
  {
    ...failure,
    outcome: "passed",
    executionPolicy: {
      ...failure.executionPolicy,
      runtimeInspection: { outcome: "unavailable", identity: null },
    },
  },
  {
    ...failure,
    executionPolicy: {
      ...failure.executionPolicy,
      runtimeInspection: { outcome: "unavailable", identity: null },
    },
  },
  {
    ...failure,
    builtImageDigest: null,
  },
  {
    ...failure,
    baseImageIdentity: {
      ...failure.baseImageIdentity,
      manifestDigest: `sha256:${"f".repeat(64)}`,
    },
  },
]) {
  let rejected = false;
  try {
    compileIsolationEvidence(substitution, preparedAuthority);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("integration.isolation.verify-selection");
}
if (
  failure.builtImageDigest === null ||
  failure.builtMockServerImageDigest === null
)
  throw new Error("integration.isolation.verify-image-identity");
const manifest = compileCapabilityManifest(
  JSON.parse(
    readFileSync(resolve(integrationRoot, "capability-manifest.json"), "utf8"),
  ),
);
const scenario = manifest.scenarios.find(
  ({ scenarioId }) => scenarioId === failure.scenarioId,
);
if (scenario === undefined)
  throw new Error("integration.isolation.verify-selection");
const cleanupAbortController = new AbortController();
let cleanupAbortPublished = false;
let recordedCleanupBoundaryEvidence;
const cleanupBoundaryPlan = createIsolationPlan({
  scenario,
  manifestIdentity: manifest.manifestIdentity,
  candidate: {
    evidenceVersion: 1,
    bundleIdentity: failure.candidateBundleIdentity,
    candidateRevision: failure.candidateRevision,
    platform: {
      os: "linux",
      architecture: "x64",
      nodeVersion: "22.0.0",
    },
    lockfile: {
      fileName: "pnpm-lock.yaml",
      bytes: 1,
      sha256: `sha256-${"1".repeat(64)}`,
    },
    artifacts: [
      {
        id: "agentscope-cli",
        kind: "npm-tarball",
        fileName: "agentscope-cli.tgz",
        bytes: 1,
        sha256: `sha256-${"2".repeat(64)}`,
      },
    ],
    scenarioNetworkPolicy: "offline-no-package-or-registry-download",
  },
  runToken: "0123456789abcdef",
  baseImageIdentity: failure.baseImageIdentity,
  mockServerImageIdentity: failure.mockServerImageIdentity,
  selection: failure.executionPolicy.selection,
  maximumParallelScenarios: failure.executionPolicy.maximumParallelScenarios,
  scenarioTimeoutMilliseconds:
    failure.executionPolicy.scenarioTimeoutMilliseconds,
});
const noOperation = () => Promise.resolve();
const cleanupBoundaryEvidence = await executeIsolationPlan(
  cleanupBoundaryPlan,
  {
    inspectExecutionPolicy: () => Promise.resolve(failure.executionPolicy),
    buildImage: () => Promise.resolve(failure.builtImageDigest),
    buildMockServerImage: () =>
      Promise.resolve(failure.builtMockServerImageDigest),
    createNetwork: noOperation,
    startCollector: noOperation,
    startRetrieval: noOperation,
    startMockServer: noOperation,
    runScenario: noOperation,
    recordEvidence: (evidence) => {
      recordedCleanupBoundaryEvidence = evidence;
      return Promise.resolve();
    },
    removeContainer: () => {
      if (!cleanupAbortPublished) {
        cleanupAbortPublished = true;
        cleanupAbortController.abort();
      }
      return Promise.resolve();
    },
    removeNetwork: noOperation,
    removeImage: noOperation,
    removeContext: noOperation,
    inspectCleanup: () =>
      Promise.resolve({
        containers: 0,
        networks: 0,
        images: 0,
        volumes: 0,
        buildContexts: 0,
        activeRunMarkers: 0,
      }),
  },
  cleanupAbortController.signal,
);
if (
  !cleanupAbortController.signal.aborted ||
  cleanupBoundaryEvidence.outcome !== "passed" ||
  recordedCleanupBoundaryEvidence?.outcome !== "passed"
)
  throw new Error("integration.isolation.verify-cleanup-boundary");
const interruption = await runMode("interruption", true);
if (
  compileIsolationEvidence(interruption).outcome !== "interrupted" ||
  interruption.cleanup?.outcome !== "complete"
)
  throw new Error("integration.isolation.verify-interruption");
for (const evidence of [failure, interruption]) {
  for (const imageDigest of [
    evidence.builtImageDigest,
    evidence.builtMockServerImageDigest,
  ]) {
    if (imageDigest === `sha256-${"0".repeat(64)}`)
      throw new Error("integration.isolation.verify-image-identity");
  }
}
const policy = failure.executionPolicy;
for (const substitution of [
  { ...policy, maximumParallelScenarios: 17 },
  { ...policy, runtimeInspection: undefined },
  {
    ...policy,
    requests: {
      destinationServerMaximumBytes:
        ISOLATION_EXECUTOR_LIMITS.requests.destinationServerMaximumBytes + 1,
    },
  },
  {
    ...policy,
    containers: {
      ...policy.containers,
      scenario: {
        ...policy.containers.scenario,
        memoryBytes:
          ISOLATION_EXECUTOR_LIMITS.containers.scenario.memoryBytes - 1,
      },
    },
  },
  {
    ...policy,
    runtimeInspection: {
      ...policy.runtimeInspection,
      identity: {
        ...policy.runtimeInspection.identity,
        engine: {
          ...policy.runtimeInspection.identity.engine,
          operatingSystem: "/home/operator",
        },
      },
    },
  },
]) {
  let rejected = false;
  try {
    compileIsolationExecutionPolicy(substitution);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("integration.isolation.verify-policy");
}
console.log("Verified Docker teardown after failure and interruption.");
