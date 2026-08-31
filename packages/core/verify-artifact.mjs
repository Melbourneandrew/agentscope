import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import {
  createReporterDeadline,
  invokeReporter,
} from "../destinations/core/dist/core-orchestration.js";
import {
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  commitLocalResourceConfiguration,
  createDestinationReporter,
  createDestinationRetriever,
  createReporterReceipt,
  createRetrievedTrace,
  createRetrieverSearchPage,
  createRetrieverSuccess,
  createTraceLocator,
  createTraceSummary,
  defineDestinationDescriptor,
  defineLocalResourceLifecycleDeclaration,
  defineLocalResourceLifecycleHandler,
} from "../destinations/core/dist/index.js";
import { z } from "zod";
import {
  DEFAULT_CONFIGURATION_MIGRATION_REGISTRY,
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCredentialResolutionContext,
  createCredentialOwnership,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createAgentscopeHomeResolver,
  createOperationalStateStore,
  inspectAgentscopeDoctor,
  inspectOperationalState,
  migrateConfigurationDocument,
  parseAgentscopeConfiguration,
  readConfigurationSnapshot,
  recoverCredentialMutation,
  resolveCredentialReference,
  runResolvedTraceLifecycle,
  retireCredentialReference,
  serializeAgentscopeConfiguration,
  writeConfigurationSnapshot,
} from "./dist/index.js";
import {
  getConfiguredTrace,
  prepareCoreRetrievalRuntime,
  searchConfiguredTraces,
} from "./dist/retrieval/orchestration-index.js";
import {
  createCiEnvironmentCredentialReference,
  createStoredCredentialReference,
  getStoredCredentialImplementation,
  readResolvedCredentialForCore,
} from "./dist/configuration/credential-adapter.js";
import { createConfigurationStoreForTesting } from "./dist/configuration/transaction.js";
import { createMacosKeychainCredentialAdapterForTesting } from "./dist/configuration/macos-keychain.js";
import { createLinuxSecretServiceAdapterForTesting } from "./dist/configuration/linux-secret-service.js";
import { createWindowsCredentialManagerAdapterForTesting } from "./dist/configuration/windows-credential-manager.js";
import * as coreArtifactExports from "./dist/index.js";
import { DEFAULT_REDACTION_POLICY_REGISTRY } from "./dist/redaction/policy.js";
import { createHookEntryAuthority } from "./dist/invocation/hook-orchestration-index.js";
import { runOperationalCoordinatorForTesting } from "./dist/invocation/operational-coordinator.js";
import { isRedactedCanonicalTrace } from "../protocol/dist/index.js";
import {
  applyAgentscopeConfigurationInitialization,
  applyDestinationLifecycleRecoveryPlan,
  applyDestinationLifecyclePlan,
  applyDestinationMaintenancePlan,
  createConfigurationManagementRuntime,
  inspectAgentscopeConfigurationInitialization,
  inspectDestinationConfigureLifecyclePlan,
  inspectDestinationLifecyclePlan,
  inspectDestinationLifecycleRecoveryPlan,
  inspectDestinationLocalResourceDoctor,
  inspectDestinationMaintenancePlan,
} from "./dist/configuration/management-index.js";

// Artifact verification runs inside the aggregate Nx graph, where process
// startup can be delayed by concurrent package builds. Keep this runner-only
// guard separate from product hook deadlines, and exercise a delay longer than
// the former one-second guard so the regression remains causal.
const ARTIFACT_COORDINATOR_TIMEOUT_MILLISECONDS = 5_000;
const ARTIFACT_COORDINATOR_STARTUP_DELAY_MILLISECONDS = 1_100;

const listRegularFiles = (directory, prefix = "") => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(
        ...listRegularFiles(join(directory, entry.name), relativePath),
      );
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Unexpected Core artifact entry: ${relativePath}`);
    files.push(relativePath);
  }
  return files.sort();
};

const productionSources = listRegularFiles(resolve(import.meta.dirname, "src"))
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => file.slice(0, -3));
const expectedArtifactFiles = productionSources
  .flatMap((file) => [`${file}.d.ts`, `${file}.js`])
  .sort();
const actualArtifactFiles = listRegularFiles(
  resolve(import.meta.dirname, "dist"),
);
if (
  actualArtifactFiles.length !== expectedArtifactFiles.length ||
  actualArtifactFiles.some(
    (file, index) => file !== expectedArtifactFiles[index],
  )
)
  throw new Error("Core production artifact inventory is not exact.");
if (actualArtifactFiles.some((file) => file.includes(".test.")))
  throw new Error("Core production artifact contains compiled tests.");
const lifecycleArtifactSource = readFileSync(
  resolve(import.meta.dirname, "dist/lifecycle.js"),
  "utf8",
);
if (
  /node:(?:fs|http|https|net|tls)|\bfetch\s*\(|\bconsole\.|process\.(?:stdout|stderr)/u.test(
    lifecycleArtifactSource,
  )
)
  throw new Error("Core lifecycle artifact contains direct IO authority.");
const candidate = {
  captureBoundary: {
    session: {
      kind: "native-session",
      nativeIdentityKind: "thread",
      nativeIdentity: "artifact-thread",
    },
    boundaryKind: "turn",
    boundaryId: "artifact-turn",
    generation: 0,
    positionKind: "event-index",
    startPosition: 0,
    exclusiveEndPosition: 1,
  },
  rootContext: { fields: [], unavailable: [] },
  operations: [
    {
      logicalKey: "root",
      locator: { kind: "source-ordinal", ordinal: 0 },
      kind: "AGENT",
      name: "agent-operation",
      nameProvenance: { field: "span.name", source: "native-artifact" },
      timing: {
        basis: "native-interval",
        nativeState: "observed",
        source: "native-artifact",
        startUnixNano: "1",
        endUnixNano: "20",
      },
      fields: [],
      unavailable: [],
      events: [],
      links: [],
    },
  ],
};

const artifactConfigurationDirectory = mkdtempSync(
  join(tmpdir(), "agentscope-core-configuration-artifact-"),
);
const artifactHome = createAgentscopeHomeResolver({
  environment: {
    AGENTSCOPE_HOME: join(artifactConfigurationDirectory, "home"),
  },
  environmentOverrideAuthority: "test",
  platform: process.platform,
})();
let directTrace;
const artifactSettingsSchema = z.strictObject({});
void artifactSettingsSchema.shape;
z.toJSONSchema(artifactSettingsSchema);
const artifactConnectionId = `destination-connection-v1-${"a".repeat(64)}`;
const artifactDescriptor = defineDestinationDescriptor({
  descriptorVersion: 1,
  destinationType: "@agentscope/destination-artifact",
  commandName: "artifact",
  settingsVersion: 1,
  settingsSchema: artifactSettingsSchema,
  defaultSettings: {},
  credentialSlots: [],
  documentationPath: "/docs/destinations/artifact",
  deliveryIdentitySupport: "duplicates-possible",
  transport: { kind: "local" },
  createReporter: () =>
    createDestinationReporter({
      report: ({ traces }) => {
        directTrace = traces[0];
        return Promise.resolve(createReporterReceipt("accepted"));
      },
    }),
  retrievalOrdering: "start-time-desc-trace-id-asc",
  createRetriever: () =>
    createDestinationRetriever({
      search: (request) =>
        Promise.resolve(
          createRetrieverSuccess(
            createRetrieverSearchPage({
              summaries: [
                createTraceSummary({
                  locator: createTraceLocator({
                    connectionId: request.connectionId,
                    destinationType: request.destinationType,
                    traceId:
                      directTrace.graph.resourceSpans[0].scopeSpans[0].spans[0]
                        .traceId,
                  }),
                  startTime: "2026-01-01T00:00:00.000Z",
                  models: [],
                  status: "ok",
                  spanCount: 1,
                  tags: [],
                }),
              ],
              state: "exhaustive",
              consistency: "snapshot",
              ordering: "start-time-desc-trace-id-asc",
            }),
          ),
        ),
      get: (request) =>
        Promise.resolve(
          createRetrieverSuccess(
            createRetrievedTrace({
              locator: request.locator,
              representation: {
                kind: "canonical-graph",
                graph: directTrace.graph,
              },
              consistency: "snapshot",
            }),
          ),
        ),
    }),
});
const artifactRegistry = compileDestinationRegistry([artifactDescriptor]);
const emptyCredentialRegistry = compileCredentialBackendRegistry([]);
const artifactConfiguration = parseAgentscopeConfiguration(
  {
    configurationVersion: 2,
    generation: 0,
    destinations: {
      "@agentscope/destination-artifact": {
        namespaceVersion: 1,
        settingsVersion: 1,
        connections: [
          {
            connectionId: artifactConnectionId,
            name: "artifact",
            settings: {},
            credentialReferences: {},
          },
        ],
      },
    },
    routing: {
      version: 1,
      selectedConnectionIds: [artifactConnectionId],
      hookDeadlineMilliseconds: 2_000,
    },
    policy: { version: 1, reference: "core-redaction-policy-v1-baseline" },
  },
  artifactRegistry,
);
if (
  !artifactHome.configFile.endsWith("config.json") ||
  artifactConfiguration.mutationSafe !== true ||
  !serializeAgentscopeConfiguration(artifactConfiguration).endsWith("\n")
)
  throw new Error("Core configuration artifact verification failed.");
const migratedConfiguration = migrateConfigurationDocument(
  {
    configurationVersion: 1,
    generation: 0,
    destinations: artifactConfiguration.document.destinations,
    routing: {
      version: 1,
      selectedConnectionIds: [artifactConnectionId],
    },
    policy: {
      version: 1,
      reference: "core-redaction-policy-v1-baseline",
    },
  },
  DEFAULT_CONFIGURATION_MIGRATION_REGISTRY,
  artifactRegistry,
);
const artifactStore = createConfigurationStore(artifactHome, artifactRegistry);
const hostileAbortSignal = Object.defineProperty({}, "aborted", {
  get: () => {
    throw new Error("CANARY_SIGNAL");
  },
});
const hostileAbortPreparation = await prepareCoreRetrievalRuntime({
  configurationStore: artifactStore,
  credentialBackendRegistry: emptyCredentialRegistry,
  policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
  transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  signal: hostileAbortSignal,
});
if (
  hostileAbortPreparation.ok ||
  hostileAbortPreparation.code !== "deadline-exceeded"
)
  throw new Error("Hostile AbortSignal escaped retrieval preparation.");
const statefulAbortController = new AbortController();
let statefulAbortReads = 0;
let statefulConfigurationReads = 0;
const statefulAbortSignal = {
  get aborted() {
    statefulAbortReads += 1;
    if (statefulAbortReads === 1) {
      statefulAbortController.abort();
      return false;
    }
    return statefulAbortController.signal.aborted;
  },
  addEventListener: statefulAbortController.signal.addEventListener.bind(
    statefulAbortController.signal,
  ),
  removeEventListener: statefulAbortController.signal.removeEventListener.bind(
    statefulAbortController.signal,
  ),
};
const statefulAbortStore = createConfigurationStoreForTesting(
  artifactHome,
  artifactRegistry,
  {
    readForHook: () => {
      statefulConfigurationReads += 1;
      return Promise.resolve(undefined);
    },
  },
);
const statefulAbortPreparation = await prepareCoreRetrievalRuntime({
  configurationStore: statefulAbortStore,
  credentialBackendRegistry: emptyCredentialRegistry,
  policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
  transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  signal: statefulAbortSignal,
});
if (
  statefulAbortPreparation.ok ||
  statefulAbortPreparation.code !== "deadline-exceeded" ||
  statefulAbortReads !== 2 ||
  statefulConfigurationReads !== 0
)
  throw new Error("Stateful AbortSignal escaped retrieval preparation.");
const artifactOwner = createConfigurationProcessIdentity(
  process.pid,
  `process-start-v1-${"d".repeat(64)}`,
);
const artifactManagement = createConfigurationManagementRuntime(
  artifactRegistry,
  artifactStore,
  artifactOwner,
);
const independentlyCompiledArtifactRegistry = compileDestinationRegistry([
  artifactDescriptor,
]);
try {
  createConfigurationManagementRuntime(
    independentlyCompiledArtifactRegistry,
    artifactStore,
    artifactOwner,
  );
  throw new Error("Mismatched configuration registry authority was accepted.");
} catch (error) {
  if (error?.code !== "core.configuration.invalid") throw error;
}
const artifactOperationalStateStore = createOperationalStateStore(
  artifactHome,
  artifactOwner,
);
const captureArtifactCandidate = (factory, _signal, checkpointResolver) => {
  if (typeof checkpointResolver !== "function")
    throw new Error("Core checkpoint resolver was unavailable.");
  const resume = checkpointResolver({
    nativeIdentityKind: "thread",
    nativeIdentity: "artifact-thread",
    sourceGeneration: 0,
    positionKind: "event-index",
    availableStartPosition: 0,
  });
  return factory.capture({
    ...candidate,
    captureBoundary: {
      ...candidate.captureBoundary,
      startPosition: resume.startPosition,
      exclusiveEndPosition: resume.startPosition + 1,
    },
  });
};
await writeConfigurationSnapshot(artifactStore, {
  expectedGeneration: null,
  candidate: migratedConfiguration,
  owner: artifactOwner,
});
if ((await readConfigurationSnapshot(artifactStore)).generation !== 0)
  throw new Error(
    "Core configuration transaction artifact verification failed.",
  );
const artifactInitializationPlan =
  await inspectAgentscopeConfigurationInitialization(artifactManagement);
try {
  await applyAgentscopeConfigurationInitialization({
    ...artifactInitializationPlan,
  });
  throw new Error("Cloned initialization plan authority was accepted.");
} catch (error) {
  if (error?.code !== "core.configuration.invalid") throw error;
}
const artifactInitializationResult =
  await applyAgentscopeConfigurationInitialization(artifactInitializationPlan);
if (
  artifactInitializationResult.created ||
  artifactInitializationResult.generation !== 0
)
  throw new Error("Core initialization plan artifact verification failed.");
const lifecycleResult = await runResolvedTraceLifecycle({
  configurationStore: artifactStore,
  operationalStateStore: artifactOperationalStateStore,
  credentialBackendRegistry: emptyCredentialRegistry,
  transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
  harnessRegistryId: "codex",
  harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
  hookObservedUnixNano: "10",
  operationIdScope: "session-global",
  workspaceCandidates: [],
  gitExecutable: "/usr/bin/git",
  hookEntryAuthority: createHookEntryAuthority({
    durationMilliseconds: 2_000,
    startedAt: performance.now(),
  }),
  capture: captureArtifactCandidate,
});
const artifactOperationalSnapshot = await inspectOperationalState(
  artifactOperationalStateStore,
);
const serializedOperationalSnapshot = JSON.stringify(
  artifactOperationalSnapshot,
);
const lifecycleArtifactFailures = [
  ["lifecycle-outcome", lifecycleResult.outcome === "completed"],
  [
    "connection-outcome",
    lifecycleResult.connections[0]?.outcome === "accepted",
  ],
  [
    "operational-persistence",
    lifecycleResult.operationalEvidence.persistence.code === "recorded",
  ],
  [
    "checkpoint-advance",
    lifecycleResult.operationalEvidence.checkpoints[0]?.code === "advanced",
  ],
  [
    "checkpoint-position",
    lifecycleResult.operationalEvidence.checkpoints[0]
      ?.acknowledgedExclusivePosition === 1,
  ],
  [
    "persisted-checkpoint-position",
    artifactOperationalSnapshot.checkpoints[0]
      ?.acknowledgedExclusivePosition === 1,
  ],
  [
    "thread-content-containment",
    !serializedOperationalSnapshot.includes("artifact-thread"),
  ],
  [
    "delivery-identity-containment",
    !serializedOperationalSnapshot.includes(directTrace.delivery.identity),
  ],
  [
    "trace-identity-containment",
    !serializedOperationalSnapshot.includes(directTrace.graph.traceId),
  ],
  ["redacted-trace-brand", isRedactedCanonicalTrace(directTrace)],
  [
    "redacted-trace-brand-forgery",
    !isRedactedCanonicalTrace(structuredClone(directTrace)),
  ],
]
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (lifecycleArtifactFailures.length > 0) {
  const diagnosticCodes = lifecycleResult.operationalEvidence.diagnostics.map(
    ({ code }) => code,
  );
  const healthOutcomes = lifecycleResult.operationalEvidence.health.map(
    ({ scope, stage, outcome }) => `${scope}:${stage}:${outcome}`,
  );
  throw new Error(
    `Core resolved lifecycle artifact verification failed: checks=${lifecycleArtifactFailures.join(",")}; outcome=${lifecycleResult.outcome}; persistence=${lifecycleResult.operationalEvidence.persistence.code}; diagnostics=${diagnosticCodes.join(",") || "none"}; health=${healthOutcomes.join(",") || "none"}.`,
  );
}
const artifactCheckpoint = artifactOperationalSnapshot.checkpoints[0];
const lostAcknowledgementCommit = spawnSync(
  process.execPath,
  [
    resolve(
      import.meta.dirname,
      "dist/invocation/operational-coordinator-child.js",
    ),
  ],
  {
    input: JSON.stringify({
      kind: "commit",
      homeRoot: artifactHome.root,
      platform: artifactHome.platform,
      evidence: {
        diagnostics: [],
        health: [
          {
            scope: "hook",
            stage: "remote-acceptance",
            outcome: "accepted",
            configurationGeneration: 0,
            policyMode: "baseline",
            receipt: null,
          },
        ],
        checkpoints: [
          {
            adapterId: artifactCheckpoint.adapterId,
            sourceIdentityDigest: artifactCheckpoint.sourceIdentityDigest,
            nativeIdentityKind: artifactCheckpoint.nativeIdentityKind,
            sourceGeneration: artifactCheckpoint.sourceGeneration,
            positionKind: artifactCheckpoint.positionKind,
            startPosition: 1,
            exclusiveEndPosition: 2,
            configurationGeneration: 0,
            destinationType: "@agentscope/destination-artifact",
            connectionId: artifactConnectionId,
          },
        ],
      },
    }),
    encoding: "utf8",
  },
);
// Deliberately discard the successful reply to model replacement followed by
// acknowledgement loss. The next owned preload is the reconciliation authority.
if (lostAcknowledgementCommit.status !== 0)
  throw new Error("Core coordinator acknowledgement-loss setup failed.");
const reconciledOperationalSnapshot = await runOperationalCoordinatorForTesting(
  {
    kind: "preload",
    homeRoot: artifactHome.root,
    platform: artifactHome.platform,
  },
  ARTIFACT_COORDINATOR_TIMEOUT_MILLISECONDS,
  {},
);
if (
  reconciledOperationalSnapshot.checkpoints[0]
    ?.acknowledgedExclusivePosition !== 2
)
  throw new Error("Core coordinator acknowledgement reconciliation failed.");
let hangingCoordinatorProcessId = 0;
try {
  await runOperationalCoordinatorForTesting(
    {
      kind: "preload",
      homeRoot: artifactHome.root,
      platform: artifactHome.platform,
    },
    20,
    {
      program: "process.stdin.resume(); setInterval(() => {}, 1000);",
      onSpawn: (value) => {
        hangingCoordinatorProcessId = value ?? 0;
      },
    },
  );
  throw new Error("Core coordinator accepted a hanging child.");
} catch (error) {
  if (error?.message !== "core.operational-coordinator.unavailable")
    throw error;
}
try {
  process.kill(hangingCoordinatorProcessId, 0);
  throw new Error("Core coordinator did not join a timed-out child.");
} catch (error) {
  if (error?.message === "Core coordinator did not join a timed-out child.")
    throw error;
}
const retrievalRuntime = {
  commandStartedAt: "2026-01-01T00:00:00.000Z",
  configuration: artifactConfiguration,
  policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
  credentialBackendRegistry: emptyCredentialRegistry,
  transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  deadline: createReporterDeadline(1_000),
};
// Built-boundary component coverage; user-facing AC-RET evidence remains planned.
const artifactTraceId =
  directTrace.graph.resourceSpans[0].scopeSpans[0].spans[0].traceId;
const artifactSearch = await searchConfiguredTraces(retrievalRuntime, {
  destinationName: "artifact",
  query: { traceId: artifactTraceId },
});
const artifactGet = await getConfiguredTrace(retrievalRuntime, {
  destinationName: "artifact",
  traceId: artifactTraceId,
});
if (
  !artifactSearch.ok ||
  artifactSearch.page.summaries[0]?.locator.traceId !== artifactTraceId ||
  !artifactGet.ok ||
  artifactGet.trace.graph === directTrace.graph ||
  isRedactedCanonicalTrace(artifactGet.trace.graph)
)
  throw new Error("Core retrieval artifact verification failed.");
const artifactSourceLoss = await runResolvedTraceLifecycle({
  configurationStore: artifactStore,
  operationalStateStore: artifactOperationalStateStore,
  credentialBackendRegistry: emptyCredentialRegistry,
  transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
  harnessRegistryId: "codex",
  harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
  hookObservedUnixNano: "10",
  operationIdScope: "session-global",
  workspaceCandidates: [],
  gitExecutable: "/usr/bin/git",
  hookEntryAuthority: createHookEntryAuthority({
    durationMilliseconds: 2_000,
    startedAt: performance.now(),
  }),
  capture: (factory, _signal, checkpointResolver) => {
    if (typeof checkpointResolver !== "function")
      throw new Error("Core checkpoint resolver was unavailable.");
    const resume = checkpointResolver({
      nativeIdentityKind: "thread",
      nativeIdentity: "artifact-thread",
      sourceGeneration: 0,
      positionKind: "event-index",
      availableStartPosition: 10,
    });
    return factory.capture({
      ...candidate,
      captureBoundary: {
        ...candidate.captureBoundary,
        startPosition: resume.startPosition,
        exclusiveEndPosition: resume.startPosition + 1,
      },
    });
  },
});
if (
  artifactSourceLoss.outcome !== "completed" ||
  artifactSourceLoss.operationalEvidence.diagnostics[0]?.code !==
    "native-source-loss" ||
  artifactSourceLoss.operationalEvidence.diagnostics.length !== 1 ||
  artifactSourceLoss.operationalEvidence.checkpoints[0]?.code !== "stale" ||
  artifactSourceLoss.operationalEvidence.persistence.code !== "recorded"
)
  throw new Error("Core source-loss artifact verification failed.");
let artifactCheckpointAccessorReads = 0;
let retainedArtifactCheckpointResolver;
const hostileCheckpointResult = await runResolvedTraceLifecycle({
  configurationStore: artifactStore,
  operationalStateStore: artifactOperationalStateStore,
  credentialBackendRegistry: emptyCredentialRegistry,
  transportExecutor: () => Promise.reject(new Error("unexpected transport")),
  policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
  harnessRegistryId: "codex",
  harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
  hookObservedUnixNano: "10",
  operationIdScope: "session-global",
  workspaceCandidates: [],
  gitExecutable: "/usr/bin/git",
  hookEntryAuthority: createHookEntryAuthority({
    durationMilliseconds: 2_000,
    startedAt: performance.now(),
  }),
  capture: (_factory, _signal, checkpointResolver) => {
    if (typeof checkpointResolver !== "function")
      throw new Error("Core checkpoint resolver was unavailable.");
    retainedArtifactCheckpointResolver = checkpointResolver;
    const request = Object.create(null);
    Object.defineProperties(request, {
      availableStartPosition: { enumerable: true, value: 0 },
      nativeIdentity: {
        enumerable: true,
        get() {
          artifactCheckpointAccessorReads += 1;
          return "artifact-thread";
        },
      },
      nativeIdentityKind: { enumerable: true, value: "thread" },
      positionKind: { enumerable: true, value: "event-index" },
      sourceGeneration: { enumerable: true, value: 0 },
    });
    checkpointResolver(request);
  },
});
let lateCheckpointResolverRejected = false;
try {
  retainedArtifactCheckpointResolver?.({
    nativeIdentityKind: "thread",
    nativeIdentity: "artifact-thread",
    sourceGeneration: 0,
    positionKind: "event-index",
    availableStartPosition: 0,
  });
} catch {
  lateCheckpointResolverRejected = true;
}
if (
  hostileCheckpointResult.outcome !== "failed-open" ||
  hostileCheckpointResult.stage !== "capture" ||
  artifactCheckpointAccessorReads !== 0 ||
  !lateCheckpointResolverRejected
)
  throw new Error("Core checkpoint authority artifact verification failed.");
const artifactCredentialRegistry = compileCredentialBackendRegistry([
  createCiEnvironmentCredentialAdapter({
    AGENTSCOPE_ARTIFACT_KEY: "CANARY_SECRET",
  }),
]);
const artifactCredentialResult = await resolveCredentialReference(
  artifactCredentialRegistry,
  createCiEnvironmentCredentialReference(
    "AGENTSCOPE_ARTIFACT_KEY",
    `credential-generation-v1-${"e".repeat(64)}`,
  ),
  createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  ),
);
if (
  !artifactCredentialResult.ok ||
  readResolvedCredentialForCore(artifactCredentialResult.credential) !==
    "CANARY_SECRET" ||
  JSON.stringify(artifactCredentialResult).includes("CANARY_SECRET")
)
  throw new Error("Core credential adapter artifact verification failed.");
const keychainSecret = ["KEYCHAIN", "CANARY"].join("_");
let storedKeychainSecret;
const keychainCommands = [];
const keychainAdapter = createMacosKeychainCredentialAdapterForTesting({
  platform: "darwin",
  execute: (command) => {
    keychainCommands.push(command);
    if (command.arguments[0] === "add-generic-password") {
      storedKeychainSecret = command.stdin.slice(0, -1);
      return Promise.resolve({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
    }
    return Promise.resolve({
      exitCode: 0,
      stdout: new TextEncoder().encode(`${storedKeychainSecret}\n`),
      stderr: new Uint8Array(),
    });
  },
});
const keychainRegistry = compileCredentialBackendRegistry([keychainAdapter]);
const keychainGeneration = `credential-generation-v1-${"f".repeat(64)}`;
const keychainImplementation = getStoredCredentialImplementation(
  keychainRegistry,
  "macos-keychain",
);
const pendingKeychainCredential = await keychainImplementation.createPending({
  ownership: createCredentialOwnership({
    destinationType: "@agentscope/destination-artifact",
    connectionId: `destination-connection-v1-${"a".repeat(64)}`,
    slot: "api-key",
  }),
  generationId: keychainGeneration,
  secret: keychainSecret,
  signal: new AbortController().signal,
});
if (!pendingKeychainCredential.ok)
  throw new Error("macOS Keychain artifact creation failed.");
const keychainResolution = await resolveCredentialReference(
  keychainRegistry,
  createStoredCredentialReference(
    "macos-keychain",
    pendingKeychainCredential.referenceId,
    keychainGeneration,
  ),
  createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  ),
);
if (
  !keychainResolution.ok ||
  readResolvedCredentialForCore(keychainResolution.credential) !==
    keychainSecret ||
  keychainCommands.some((command) =>
    command.arguments.some((argument) => argument.includes(keychainSecret)),
  ) ||
  JSON.stringify({ pendingKeychainCredential, keychainResolution }).includes(
    keychainSecret,
  ) ||
  "createMacosKeychainCredentialAdapterForTesting" in coreArtifactExports
)
  throw new Error("macOS Keychain artifact boundary verification failed.");
const windowsSecret = ["WINDOWS", "密钥", "CANARY"].join("_");
let storedWindowsSecretBase64;
const windowsCommands = [];
const windowsAdapter = createWindowsCredentialManagerAdapterForTesting({
  platform: "win32",
  execute: (command) => {
    windowsCommands.push(command);
    const request = JSON.parse(command.stdin);
    if (request.operation === "write")
      storedWindowsSecretBase64 = request.secretBase64;
    const response =
      request.operation === "read"
        ? { ok: true, secretBase64: storedWindowsSecretBase64 }
        : { ok: true };
    return Promise.resolve({
      exitCode: 0,
      stdout: new TextEncoder().encode(JSON.stringify(response)),
      stderr: new Uint8Array(),
    });
  },
});
const windowsRegistry = compileCredentialBackendRegistry([windowsAdapter]);
const windowsGeneration = `credential-generation-v1-${"b".repeat(64)}`;
const windowsImplementation = getStoredCredentialImplementation(
  windowsRegistry,
  "windows-credential-manager",
);
const pendingWindowsCredential = await windowsImplementation.createPending({
  ownership: createCredentialOwnership({
    destinationType: "@agentscope/destination-artifact",
    connectionId: `destination-connection-v1-${"c".repeat(64)}`,
    slot: "api-key",
  }),
  generationId: windowsGeneration,
  secret: windowsSecret,
  signal: new AbortController().signal,
});
if (!pendingWindowsCredential.ok)
  throw new Error("Windows Credential Manager artifact creation failed.");
const windowsResolution = await resolveCredentialReference(
  windowsRegistry,
  createStoredCredentialReference(
    "windows-credential-manager",
    pendingWindowsCredential.referenceId,
    windowsGeneration,
  ),
  createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  ),
);
if (
  !windowsResolution.ok ||
  readResolvedCredentialForCore(windowsResolution.credential) !==
    windowsSecret ||
  windowsCommands.some((command) =>
    command.arguments.some((argument) => argument.includes(windowsSecret)),
  ) ||
  JSON.stringify({ pendingWindowsCredential, windowsResolution }).includes(
    windowsSecret,
  ) ||
  "createWindowsCredentialManagerAdapterForTesting" in coreArtifactExports
)
  throw new Error(
    "Windows Credential Manager artifact boundary verification failed.",
  );
const linuxSecret = ["LINUX", "秘密", "CANARY"].join("_");
let storedLinuxSecret;
const linuxCommands = [];
const linuxAdapter = createLinuxSecretServiceAdapterForTesting({
  platform: "linux",
  sessionAvailable: true,
  execute: (command) => {
    linuxCommands.push(command);
    if (command.operation === "store")
      storedLinuxSecret = command.stdin.slice(0, -1);
    return Promise.resolve({
      exitCode: 0,
      stdout:
        command.operation === "lookup"
          ? new TextEncoder().encode(`${storedLinuxSecret}\n`)
          : new Uint8Array(),
    });
  },
});
const linuxRegistry = compileCredentialBackendRegistry([linuxAdapter]);
const linuxGeneration = `credential-generation-v1-${"d".repeat(64)}`;
const linuxImplementation = getStoredCredentialImplementation(
  linuxRegistry,
  "linux-secret-service",
);
const pendingLinuxCredential = await linuxImplementation.createPending({
  ownership: createCredentialOwnership({
    destinationType: "@agentscope/destination-artifact",
    connectionId: `destination-connection-v1-${"e".repeat(64)}`,
    slot: "api-key",
  }),
  generationId: linuxGeneration,
  secret: linuxSecret,
  signal: new AbortController().signal,
});
if (!pendingLinuxCredential.ok)
  throw new Error("Linux Secret Service artifact creation failed.");
const linuxResolution = await resolveCredentialReference(
  linuxRegistry,
  createStoredCredentialReference(
    "linux-secret-service",
    pendingLinuxCredential.referenceId,
    linuxGeneration,
  ),
  createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  ),
);
if (
  !linuxResolution.ok ||
  readResolvedCredentialForCore(linuxResolution.credential) !== linuxSecret ||
  linuxCommands.some((command) =>
    command.arguments.some((argument) => argument.includes(linuxSecret)),
  ) ||
  JSON.stringify({ pendingLinuxCredential, linuxResolution }).includes(
    linuxSecret,
  ) ||
  "createLinuxSecretServiceAdapterForTesting" in coreArtifactExports ||
  "linuxSecretServiceSessionIsAvailableForTesting" in coreArtifactExports
)
  throw new Error(
    "Linux Secret Service artifact boundary verification failed.",
  );
const doctorReport = await inspectAgentscopeDoctor({
  configurationStore: artifactStore,
  operationalStateStore: artifactOperationalStateStore,
  credentialRegistry: artifactCredentialRegistry,
  credentialResolutionContext: createCredentialResolutionContext(
    "hook-equivalent",
    new AbortController().signal,
  ),
  ownerState: () => "dead",
});
if (
  doctorReport.configuration.state !== "valid" ||
  doctorReport.operationalState.state !== "available" ||
  typeof recoverCredentialMutation !== "function" ||
  typeof retireCredentialReference !== "function" ||
  JSON.stringify(doctorReport).includes("CANARY_SECRET") ||
  "createOperationalStateStoreForTesting" in coreArtifactExports
)
  throw new Error("Core Doctor artifact boundary verification failed.");
const directReporter = createDestinationReporter({
  report: ({ traces }) =>
    Promise.resolve(
      traces.length === 1 && traces[0] === directTrace
        ? createReporterReceipt("accepted")
        : createReporterReceipt("rejected"),
    ),
});
// AC-REP-002.1: the built Reporter boundary accepts only the Core-produced,
// harness-independent branded canonical envelope and preserves its identity.
const directAttempt = {
  traces: [directTrace],
  signal: new AbortController().signal,
  deadline: createReporterDeadline(1_000),
  admissionTimeUnixNano: "1000000",
};
if (
  (await invokeReporter(directReporter, directAttempt)).outcome !== "accepted"
)
  throw new Error("Reporter rejected a Core-minted branded trace.");
const reasonReporter = createDestinationReporter({
  report: ({ admissionTimeUnixNano }) =>
    Promise.resolve(
      admissionTimeUnixNano === "1000000"
        ? createReporterReceipt("unavailable", "destination-busy")
        : { outcome: "accepted", reason: "destination-busy" },
    ),
});
const reasonReceipt = await invokeReporter(reasonReporter, directAttempt);
if (
  reasonReceipt.outcome !== "unavailable" ||
  reasonReceipt.reason !== "destination-busy"
)
  throw new Error("Reporter lost the exact Core admission time or reason.");
const invalidReasonReporter = createDestinationReporter({
  report: () =>
    Promise.resolve({ outcome: "accepted", reason: "destination-busy" }),
});
if (
  (await invokeReporter(invalidReasonReporter, directAttempt)).outcome !==
  "outcome-unknown"
)
  throw new Error("Reporter accepted an invalid outcome/reason pair.");
const hangingReporter = createDestinationReporter({
  report: () => new Promise(() => undefined),
});
if (
  (
    await invokeReporter(hangingReporter, {
      ...directAttempt,
      deadline: createReporterDeadline(20),
    })
  ).outcome !== "outcome-unknown"
)
  throw new Error("Hanging Reporter did not settle at the Core deadline.");
try {
  await invokeReporter(directReporter, {
    ...directAttempt,
    traces: [structuredClone(directTrace)],
  });
  throw new Error("Reporter accepted a cloned trace.");
} catch (error) {
  if (error?.code !== "destination.reporter.invalid") throw error;
}
const unhandled = [];
const collectUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", collectUnhandled);
try {
  const asyncMisuse = await runResolvedTraceLifecycle({
    configurationStore: artifactStore,
    operationalStateStore: artifactOperationalStateStore,
    credentialBackendRegistry: emptyCredentialRegistry,
    transportExecutor: () => Promise.reject(new Error("unexpected transport")),
    policyRegistry: DEFAULT_REDACTION_POLICY_REGISTRY,
    harnessRegistryId: "codex",
    harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
    hookObservedUnixNano: "10",
    operationIdScope: "session-global",
    workspaceCandidates: [],
    gitExecutable: "/usr/bin/git",
    hookEntryAuthority: createHookEntryAuthority({
      durationMilliseconds: 2_000,
      startedAt: performance.now(),
    }),
    capture: async () => {
      throw new Error("CANARY_SECRET");
    },
  });
  if (asyncMisuse.outcome !== "failed-open" || asyncMisuse.stage !== "capture")
    throw new Error("Async capture misuse did not fail open.");
  await Promise.resolve();
  await Promise.resolve();
  if (unhandled.length !== 0)
    throw new Error("Async capture misuse was not safely observed.");
} finally {
  process.off("unhandledRejection", collectUnhandled);
}

const lifecycleSettingsSchema = z.strictObject({ project: z.string() });
void lifecycleSettingsSchema.shape;
const lifecycleDeclaration = defineLocalResourceLifecycleDeclaration({
  artifactGrammarFingerprint: `sha256-${"1".repeat(64)}`,
  artifactGrammarVersion: 1,
  artifactKinds: [
    "active-database",
    "backup",
    "backup-receipt",
    "lifecycle-intent",
    "ownership-receipt",
  ],
  capabilityVersion: 1,
  destinationType: "@agentscope/destination-artifact-local",
  operations: [
    "backup",
    "configure",
    "delete",
    "doctor",
    "recover",
    "restore",
    "unconfigure",
  ],
  receiptReasons: ["destination-busy", "destination-capacity"],
  recoveryHandlerId: "@agentscope/destination-artifact-local/lifecycle-v1",
  settingKeys: ["project"],
  settingsVersion: 1,
});
const lifecycleDescriptor = defineDestinationDescriptor({
  descriptorVersion: 1,
  destinationType: lifecycleDeclaration.destinationType,
  commandName: "artifact-local",
  settingsVersion: 1,
  settingsSchema: lifecycleSettingsSchema,
  defaultSettings: { project: "artifact" },
  credentialSlots: [],
  documentationPath: "/docs/destinations/artifact-local",
  deliveryIdentitySupport: "duplicates-possible",
  localResourceLifecycle: lifecycleDeclaration,
  transport: { kind: "local" },
  createReporter: () =>
    createDestinationReporter({
      report: () => Promise.resolve(createReporterReceipt("accepted")),
    }),
});
const lifecycleArtifactRegistry = compileDestinationRegistry([
  lifecycleDescriptor,
]);
const lifecycleCapability =
  lifecycleArtifactRegistry.descriptors[0].localResourceLifecycle;
let failLifecycleCompletion = false;
let lifecycleRecoveryCalls = 0;
let failBuiltMaintenance = false;
let builtMaintenanceRecoveryCalls = 0;
let substituteTerminalOnCompletion = false;
let lifecycleCompletionPath;
const lifecycleArtifactHandlers = compileLocalResourceLifecycleHandlerRegistry(
  lifecycleArtifactRegistry,
  [
    defineLocalResourceLifecycleHandler({
      capability: lifecycleCapability,
      complete: () => {
        if (substituteTerminalOnCompletion) {
          substituteTerminalOnCompletion = false;
          const completion = JSON.parse(
            readFileSync(lifecycleCompletionPath, "utf8"),
          );
          completion.terminalState = "backed-up";
          writeFileSync(
            lifecycleCompletionPath,
            `${JSON.stringify(completion)}\n`,
          );
        }
        if (failLifecycleCompletion) {
          failLifecycleCompletion = false;
          return Promise.reject(new Error("simulated completion crash"));
        }
        return Promise.resolve();
      },
      inspectPlan: () =>
        Promise.resolve({
          namespaceFingerprint: `sha256-${"2".repeat(64)}`,
          physicalEvidenceFingerprint: `sha256-${"3".repeat(64)}`,
          displayPath: "/owned/artifact-local",
          persistentDataNotice: true,
          retentionPolicy: {
            maximumAgeNanoseconds: "1",
            maximumTraceCount: 1,
            maximumPayloadBytes: 1,
            physicalCleanupTrigger: "next-authorized-mutation",
          },
        }),
      inspectRetainedDelete: () => Promise.resolve(null),
      apply: async (context) => {
        await commitLocalResourceConfiguration(context.configurationAuthority, {
          destinationType: context.destinationType,
          connectionId: context.connectionId,
          operationId: context.operationId,
          lifecycleFingerprint: lifecycleCapability.fingerprint,
          recoveryHandlerId: lifecycleCapability.recoveryHandlerId,
        });
        return context.operation === "unconfigure"
          ? {
              ok: true,
              state: "retained",
              retainedAuthority: {
                receiptDigest: `sha256-${"4".repeat(64)}`,
                databaseFamilyPhysicalIdentity: "dev:1:ino:2",
              },
            }
          : { ok: true, state: "configured" };
      },
      recover: () => {
        lifecycleRecoveryCalls += 1;
        return Promise.resolve({ ok: true, state: "rolled-back" });
      },
      inspectMaintenancePlan: (context) =>
        Promise.resolve({
          planEvidence: {
            namespaceFingerprint: `sha256-${"2".repeat(64)}`,
            physicalEvidenceFingerprint: `sha256-${"3".repeat(64)}`,
            displayPath: "/owned/artifact-local/backups",
            persistentDataNotice: true,
            retentionPolicy: {
              maximumAgeNanoseconds: "1",
              maximumTraceCount: 1,
              maximumPayloadBytes: 1,
              physicalCleanupTrigger: "next-authorized-mutation",
            },
          },
          resourceSelector: context.resourceSelector,
          selectedBackupAuthority:
            context.operation === "restore"
              ? {
                  backupId: context.resourceSelector,
                  receiptDigest: `sha256-${"6".repeat(64)}`,
                  snapshotPhysicalIdentity: "dev:1:ino:20",
                }
              : null,
        }),
      applyMaintenance: (context) => {
        if (failBuiltMaintenance) {
          failBuiltMaintenance = false;
          return Promise.reject(new Error("simulated maintenance crash"));
        }
        return Promise.resolve(
          context.operation === "backup"
            ? {
                ok: true,
                state: "backed-up",
                backupAuthority: {
                  backupId: context.resourceSelector,
                  receiptDigest: `sha256-${"6".repeat(64)}`,
                  snapshotPhysicalIdentity: "dev:1:ino:20",
                },
              }
            : { ok: true, state: "restored" },
        );
      },
      recoverMaintenance: () => {
        builtMaintenanceRecoveryCalls += 1;
        return Promise.resolve({ ok: true, state: "rolled-back" });
      },
      inspectDoctor: () =>
        Promise.resolve({
          state: "available",
          lifecycleState: "clean",
          databaseState: "present",
          backupState: "available",
          sharedLeaseCount: 0,
          publishedBackupCount: 1,
          retentionPolicy: {
            maximumAgeNanoseconds: "1",
            maximumTraceCount: 1,
            maximumPayloadBytes: 1,
            physicalCleanupTrigger: "next-authorized-mutation",
          },
          databaseDerivedRetention: {
            cutoff: "unavailable",
            clockContinuity: "unavailable",
            rowCount: "unavailable",
            payloadBytes: "unavailable",
          },
        }),
    }),
  ],
);
const lifecycleArtifactHome = createAgentscopeHomeResolver({
  environment: {
    AGENTSCOPE_HOME: join(artifactConfigurationDirectory, "lifecycle-home"),
  },
  environmentOverrideAuthority: "test",
  platform: process.platform,
})();
const lifecycleArtifactStore = createConfigurationStore(
  lifecycleArtifactHome,
  lifecycleArtifactRegistry,
);
lifecycleCompletionPath = join(
  lifecycleArtifactHome.mutationDirectory,
  "local-resource.completion.lock",
);
const lifecycleArtifactRuntime = createConfigurationManagementRuntime(
  lifecycleArtifactRegistry,
  lifecycleArtifactStore,
  artifactOwner,
  lifecycleArtifactHandlers,
);
await applyAgentscopeConfigurationInitialization(
  await inspectAgentscopeConfigurationInitialization(lifecycleArtifactRuntime),
);
await applyDestinationLifecyclePlan(
  await inspectDestinationConfigureLifecyclePlan(
    lifecycleArtifactRuntime,
    {
      commandName: "artifact-local",
      credentialReferences: {},
      name: "artifact-local",
      settings: { project: "artifact" },
    },
    new AbortController().signal,
  ),
);
const builtBackupPlan = await inspectDestinationMaintenancePlan(
  lifecycleArtifactRuntime,
  "backup",
  "artifact-local",
  undefined,
  new AbortController().signal,
);
const builtBackup = await applyDestinationMaintenancePlan(builtBackupPlan);
if (
  builtBackup.state !== "backed-up" ||
  !/^[0-9a-f]{32}$/u.test(builtBackup.backupSelector)
)
  throw new Error("Built Core backup plan/apply orchestration drifted.");
const builtRestore = await applyDestinationMaintenancePlan(
  await inspectDestinationMaintenancePlan(
    lifecycleArtifactRuntime,
    "restore",
    "artifact-local",
    builtBackup.backupSelector,
    new AbortController().signal,
  ),
);
if (
  builtRestore.state !== "restored" ||
  builtRestore.backupSelector !== builtBackup.backupSelector
)
  throw new Error("Built Core restore plan/apply orchestration drifted.");
const builtDoctor = await inspectDestinationLocalResourceDoctor(
  lifecycleArtifactRuntime,
  "artifact-local",
  new AbortController().signal,
);
if (
  builtDoctor.inspection.databaseDerivedRetention.rowCount !== "unavailable" ||
  builtDoctor.inspection.databaseDerivedRetention.payloadBytes !== "unavailable"
)
  throw new Error("Built Core conservative Doctor orchestration drifted.");
const rolledBackPlan = await inspectDestinationMaintenancePlan(
  lifecycleArtifactRuntime,
  "backup",
  "artifact-local",
  undefined,
  new AbortController().signal,
);
failBuiltMaintenance = true;
try {
  await applyDestinationMaintenancePlan(rolledBackPlan);
  throw new Error("Built Core interrupted maintenance was not surfaced.");
} catch (error) {
  if (error?.code !== "core.destination.lifecycle-outcome-unknown") throw error;
}
failLifecycleCompletion = true;
try {
  await applyDestinationLifecycleRecoveryPlan(
    await inspectDestinationLifecycleRecoveryPlan(
      lifecycleArtifactRuntime,
      () => "dead",
      new AbortController().signal,
    ),
  );
  throw new Error("Built Core rolled-back completion crash was not surfaced.");
} catch (error) {
  if (error?.code !== "core.destination.lifecycle-outcome-unknown") throw error;
}
const builtCompletionBytes = readFileSync(lifecycleCompletionPath, "utf8");
substituteTerminalOnCompletion = true;
try {
  await applyDestinationLifecycleRecoveryPlan(
    await inspectDestinationLifecycleRecoveryPlan(
      lifecycleArtifactRuntime,
      () => "unknown",
      new AbortController().signal,
    ),
  );
  throw new Error("Built Core terminal-state substitution was accepted.");
} catch (error) {
  if (error?.code !== "core.destination.lifecycle-outcome-unknown") throw error;
}
writeFileSync(lifecycleCompletionPath, builtCompletionBytes);
const rollbackRecoveryPlan = await inspectDestinationLifecycleRecoveryPlan(
  lifecycleArtifactRuntime,
  () => "unknown",
  new AbortController().signal,
);
if (
  rollbackRecoveryPlan.pendingOperation !== "backup" ||
  rollbackRecoveryPlan.recoveryStage !== "completion"
)
  throw new Error("Built Core recovery plan authority drifted.");
const recoveredRollback =
  await applyDestinationLifecycleRecoveryPlan(rollbackRecoveryPlan);
if (
  recoveredRollback.state !== "rolled-back" ||
  "backupSelector" in recoveredRollback ||
  builtMaintenanceRecoveryCalls !== 1
)
  throw new Error("Built Core rolled-back completion state drifted.");
failLifecycleCompletion = true;
try {
  await applyDestinationLifecyclePlan(
    await inspectDestinationLifecyclePlan(
      lifecycleArtifactRuntime,
      "unconfigure",
      "artifact-local",
      new AbortController().signal,
    ),
  );
  throw new Error("Built retained completion crash was not surfaced.");
} catch (error) {
  if (error?.code !== "core.destination.lifecycle-outcome-unknown") throw error;
}
const retainedRecoveryPlan = await inspectDestinationLifecycleRecoveryPlan(
  lifecycleArtifactRuntime,
  () => "unknown",
  new AbortController().signal,
);
if (
  retainedRecoveryPlan.pendingOperation !== "unconfigure" ||
  retainedRecoveryPlan.recoveryStage !== "completion"
)
  throw new Error("Built Core retained recovery plan authority drifted.");
const recoveredRetained =
  await applyDestinationLifecycleRecoveryPlan(retainedRecoveryPlan);
if (
  recoveredRetained.state !== "retained" ||
  !/^destination-connection-v1-[0-9a-f]{64}$/u.test(
    recoveredRetained.retainedDeleteSelector ?? "",
  ) ||
  lifecycleRecoveryCalls !== 0
)
  throw new Error("Built retained recovery selector drifted.");
rmSync(artifactConfigurationDirectory, { recursive: true, force: true });

const directory = mkdtempSync(join(tmpdir(), "agentscope-core-artifact-"));
const entry = join(directory, "entry.mjs");
const output = join(directory, "bundle.mjs");
try {
  const coordinatorBuild = await build({
    entryPoints: [
      resolve(
        import.meta.dirname,
        "src/invocation/operational-coordinator-child.ts",
      ),
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false,
  });
  if (coordinatorBuild.outputFiles.length !== 1)
    throw new Error("Core coordinator did not build as one program.");
  const coordinatorProgram = [
    `await new Promise((resolve) => setTimeout(resolve, ${ARTIFACT_COORDINATOR_STARTUP_DELAY_MILLISECONDS}));`,
    coordinatorBuild.outputFiles[0].text,
  ].join("\n");
  writeFileSync(
    entry,
    [
      `import * as core from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { compileDestinationRegistry } from ${JSON.stringify(resolve(import.meta.dirname, "../destinations/core/dist/index.js"))};`,
      `import { compileConfigurationMigrationRegistry, createAgentscopeHomeResolver, createConfigurationProcessIdentity, createConfigurationStore, createOperationalStateStore, inspectAgentscopeDoctor, migrateConfigurationDocument, parseAgentscopeConfiguration, readConfigurationSnapshot, serializeAgentscopeConfiguration, writeConfigurationSnapshot } from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { runOperationalCoordinatorForTesting } from ${JSON.stringify(resolve(import.meta.dirname, "dist/invocation/operational-coordinator.js"))};`,
      "export const verify = async () => {",
      "  const home = createAgentscopeHomeResolver({ environment: { AGENTSCOPE_HOME: '/tmp/agentscope-bundle-home' }, environmentOverrideAuthority: 'test', platform: 'linux' })();",
      "  const configuration = parseAgentscopeConfiguration({ configurationVersion: 2, generation: 0, destinations: {}, routing: { version: 1, selectedConnectionIds: [], hookDeadlineMilliseconds: 2000 }, policy: { version: 1, reference: 'core-redaction-policy-v1-baseline' } }, compileDestinationRegistry([]));",
      "  return typeof core.runResolvedTraceLifecycle === 'function' && !('searchConfiguredTraces' in core) && !('getConfiguredTrace' in core) && !('prepareCoreRetrievalRuntime' in core) && !('agentscope' in core) && !('CoreRedactionError' in core) && !('createHookEntryAuthority' in core) && !('runFailOpenTraceLifecycle' in core) && !('withCaptureInvocation' in core) && !('redactCapturedTrace' in core) && !('resolveCaptureInvocationSnapshot' in core) && !('recordPipelineHealth' in core) && !('recordSanitizedDiagnostic' in core) && home.configFile.endsWith('config.json') && serializeAgentscopeConfiguration(configuration).endsWith('\\n') && typeof compileConfigurationMigrationRegistry === 'function' && typeof createConfigurationProcessIdentity === 'function' && typeof createConfigurationStore === 'function' && typeof createOperationalStateStore === 'function' && typeof inspectAgentscopeDoctor === 'function' && typeof migrateConfigurationDocument === 'function' && typeof readConfigurationSnapshot === 'function' && typeof writeConfigurationSnapshot === 'function';",
      "};",
      `export const verifyCoordinator = (homeRoot, platform) => runOperationalCoordinatorForTesting({ kind: 'preload', homeRoot, platform }, ${ARTIFACT_COORDINATOR_TIMEOUT_MILLISECONDS}, {});`,
    ].join("\n"),
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    define: {
      __AGENTSCOPE_OPERATIONAL_COORDINATOR_PROGRAM__:
        JSON.stringify(coordinatorProgram),
    },
  });
  const bundled = await import(`${pathToFileURL(output).href}?artifact=1`);
  if ((await bundled.verify()) !== true)
    throw new Error("Bundled lifecycle registry verification failed.");
  const bundledCoordinatorSnapshot = await bundled.verifyCoordinator(
    directory,
    process.platform,
  );
  if (
    bundledCoordinatorSnapshot.nextSequence !== 0 ||
    bundledCoordinatorSnapshot.checkpoints.length !== 0
  )
    throw new Error("Bundled coordinator preload verification failed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(
  "Verified Core lifecycle dist and esbuild registry interop.\n",
);
