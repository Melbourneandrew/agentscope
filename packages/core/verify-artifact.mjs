import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { invokeRedactedTraceSink } from "../destinations/core/dist/lifecycle-sink.js";
import {
  createReporterDeadline,
  invokeReporter,
} from "../destinations/core/dist/core-orchestration.js";
import {
  compileDestinationRegistry,
  createDestinationReporter,
  createReporterReceipt,
} from "../destinations/core/dist/index.js";
import {
  compileConfigurationMigrationRegistry,
  compileCredentialBackendRegistry,
  createCiEnvironmentCredentialAdapter,
  createCredentialResolutionContext,
  createCredentialOwnership,
  createConfigurationProcessIdentity,
  createConfigurationStore,
  createAgentscopeHomeResolver,
  createOperationalStateStore,
  inspectAgentscopeDoctor,
  migrateConfigurationDocument,
  parseAgentscopeConfiguration,
  readConfigurationSnapshot,
  recoverCredentialMutation,
  resolveCredentialReference,
  recordPipelineHealth,
  runFailOpenTraceLifecycle,
  retireCredentialReference,
  serializeAgentscopeConfiguration,
  writeConfigurationSnapshot,
} from "./dist/index.js";
import {
  createCiEnvironmentCredentialReference,
  createStoredCredentialReference,
  getStoredCredentialImplementation,
  readResolvedCredentialForCore,
} from "./dist/configuration/credential-adapter.js";
import { createMacosKeychainCredentialAdapterForTesting } from "./dist/configuration/macos-keychain.js";
import { createLinuxSecretServiceAdapterForTesting } from "./dist/configuration/linux-secret-service.js";
import { createWindowsCredentialManagerAdapterForTesting } from "./dist/configuration/windows-credential-manager.js";
import * as coreArtifactExports from "./dist/index.js";
import { REDACTION_POLICY_IDENTITIES } from "./dist/redaction/policy.js";
import { isRedactedCanonicalTrace } from "../protocol/dist/index.js";

const invocation = {
  harnessRegistryId: "codex",
  harnessVersion: { state: "observed", value: "1.2.3", source: "process" },
  snapshot: {
    configurationIdentity: "config.v1",
    policyIdentity: REDACTION_POLICY_IDENTITIES.baseline,
    redactionPolicy: { version: 1, mode: "baseline" },
  },
  hookObservedUnixNano: "10",
  operationIdScope: "session-global",
};
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

const verifyRuntime = (run, guard, invoke) => {
  let trace;
  const result = run({
    invocation,
    capture: (factory) => factory.capture(candidate),
    sink(value) {
      trace = value;
      return undefined;
    },
  });
  if (
    result.outcome !== "sink-returned" ||
    !guard(trace) ||
    invoke(() => undefined, structuredClone(trace)) !== "rejected" ||
    invoke(() => undefined, {}) !== "rejected"
  )
    throw new Error("Core lifecycle artifact registry verification failed.");
  return trace;
};

const directTrace = verifyRuntime(
  runFailOpenTraceLifecycle,
  isRedactedCanonicalTrace,
  invokeRedactedTraceSink,
);
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
const artifactRegistry = compileDestinationRegistry([]);
const artifactConfiguration = parseAgentscopeConfiguration(
  {
    configurationVersion: 1,
    generation: 0,
    destinations: {},
    routing: { version: 1, selectedConnectionIds: [] },
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
    configurationVersion: 0,
    generation: 0,
    destinations: {},
    selectedConnectionIds: [],
    policyReference: "core-redaction-policy-v1-baseline",
  },
  compileConfigurationMigrationRegistry([
    {
      fromVersion: 0,
      toVersion: 1,
      migrate: (value) => ({
        configurationVersion: 1,
        generation: value.generation,
        destinations: value.destinations,
        routing: {
          version: 1,
          selectedConnectionIds: value.selectedConnectionIds,
        },
        policy: { version: 1, reference: value.policyReference },
      }),
    },
  ]),
  artifactRegistry,
);
const artifactStore = createConfigurationStore(artifactHome, artifactRegistry);
const artifactOwner = createConfigurationProcessIdentity(
  process.pid,
  `process-start-v1-${"d".repeat(64)}`,
);
await writeConfigurationSnapshot(artifactStore, {
  expectedGeneration: null,
  candidate: migratedConfiguration,
  owner: artifactOwner,
});
if ((await readConfigurationSnapshot(artifactStore)).generation !== 0)
  throw new Error(
    "Core configuration transaction artifact verification failed.",
  );
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
const artifactOperationalStore = createOperationalStateStore(
  artifactHome,
  artifactOwner,
);
if (
  !(
    await recordPipelineHealth(artifactOperationalStore, {
      scope: "hook",
      stage: "redaction",
      outcome: "completed",
      configurationGeneration: 0,
      policyMode: "baseline",
      receipt: null,
    })
  ).recorded
)
  throw new Error("Core operational state artifact write failed.");
const doctorReport = await inspectAgentscopeDoctor({
  configurationStore: artifactStore,
  operationalStateStore: artifactOperationalStore,
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
rmSync(artifactConfigurationDirectory, { recursive: true, force: true });
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
};
if (
  (await invokeReporter(directReporter, directAttempt)).outcome !== "accepted"
)
  throw new Error("Reporter rejected a Core-minted branded trace.");
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
  const asyncMisuse = runFailOpenTraceLifecycle({
    invocation,
    capture: async () => {
      throw new Error("CANARY_SECRET");
    },
    sink: () => undefined,
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

const directory = mkdtempSync(join(tmpdir(), "agentscope-core-artifact-"));
const entry = join(directory, "entry.mjs");
const output = join(directory, "bundle.mjs");
try {
  writeFileSync(
    entry,
    [
      `import { runFailOpenTraceLifecycle } from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { REDACTION_POLICY_IDENTITIES } from ${JSON.stringify(resolve(import.meta.dirname, "dist/redaction/policy.js"))};`,
      `import { invokeRedactedTraceSink } from ${JSON.stringify(resolve(import.meta.dirname, "../destinations/core/dist/lifecycle-sink.js"))};`,
      `import { createReporterDeadline, invokeReporter } from ${JSON.stringify(resolve(import.meta.dirname, "../destinations/core/dist/core-orchestration.js"))};`,
      `import { createDestinationReporter, createReporterReceipt } from ${JSON.stringify(resolve(import.meta.dirname, "../destinations/core/dist/index.js"))};`,
      `import { compileDestinationRegistry } from ${JSON.stringify(resolve(import.meta.dirname, "../destinations/core/dist/index.js"))};`,
      `import { compileConfigurationMigrationRegistry, createAgentscopeHomeResolver, createConfigurationProcessIdentity, createConfigurationStore, createOperationalStateStore, inspectAgentscopeDoctor, migrateConfigurationDocument, parseAgentscopeConfiguration, readConfigurationSnapshot, recordPipelineHealth, serializeAgentscopeConfiguration, writeConfigurationSnapshot } from ${JSON.stringify(resolve(import.meta.dirname, "dist/index.js"))};`,
      `import { isRedactedCanonicalTrace } from ${JSON.stringify(resolve(import.meta.dirname, "../protocol/dist/index.js"))};`,
      `const invocation = ${JSON.stringify(invocation)};`,
      "invocation.snapshot.policyIdentity = REDACTION_POLICY_IDENTITIES.baseline;",
      `const candidate = ${JSON.stringify(candidate)};`,
      "export const verify = async () => {",
      "  let trace;",
      "  const result = runFailOpenTraceLifecycle({ invocation, capture: (factory) => factory.capture(candidate), sink(value) { trace = value; return undefined; } });",
      "  const reporter = createDestinationReporter({ report: ({ traces }) => Promise.resolve(createReporterReceipt(traces.length === 1 && traces[0] === trace ? 'accepted' : 'rejected')) });",
      "  const attempt = { traces: [trace], signal: new AbortController().signal, deadline: createReporterDeadline(1000) };",
      "  const accepted = await invokeReporter(reporter, attempt);",
      "  const home = createAgentscopeHomeResolver({ environment: { AGENTSCOPE_HOME: '/tmp/agentscope-bundle-home' }, environmentOverrideAuthority: 'test', platform: 'linux' })();",
      "  const configuration = parseAgentscopeConfiguration({ configurationVersion: 1, generation: 0, destinations: {}, routing: { version: 1, selectedConnectionIds: [] }, policy: { version: 1, reference: 'core-redaction-policy-v1-baseline' } }, compileDestinationRegistry([]));",
      "  let cloneRejected = false;",
      "  try { await invokeReporter(reporter, { ...attempt, traces: [structuredClone(trace)] }); } catch (error) { cloneRejected = error?.code === 'destination.reporter.invalid'; }",
      "  return result.outcome === 'sink-returned' && accepted.outcome === 'accepted' && cloneRejected && home.configFile.endsWith('config.json') && serializeAgentscopeConfiguration(configuration).endsWith('\\n') && typeof compileConfigurationMigrationRegistry === 'function' && typeof createConfigurationProcessIdentity === 'function' && typeof createConfigurationStore === 'function' && typeof createOperationalStateStore === 'function' && typeof inspectAgentscopeDoctor === 'function' && typeof migrateConfigurationDocument === 'function' && typeof readConfigurationSnapshot === 'function' && typeof recordPipelineHealth === 'function' && typeof writeConfigurationSnapshot === 'function' && isRedactedCanonicalTrace(trace) && invokeRedactedTraceSink(() => undefined, structuredClone(trace)) === 'rejected' && invokeRedactedTraceSink(() => undefined, {}) === 'rejected';",
      "};",
    ].join("\n"),
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
  });
  const bundled = await import(`${pathToFileURL(output).href}?artifact=1`);
  if ((await bundled.verify()) !== true)
    throw new Error("Bundled lifecycle registry verification failed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(
  "Verified Core lifecycle dist and esbuild registry interop.\n",
);
