import { createHash } from "node:crypto";
import { fork, spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { standardsManifest } from "@agentscope/protocol";
import { isDestinationRetriever } from "@agentscope/destinations-core";

import * as root from "./dist/index.js";
import * as reporter from "./dist/reporter/index.js";
import { executePreparedLocalSqliteTransaction } from "./dist/reporter/transaction.js";
import * as retriever from "./dist/retriever/public.js";
import * as testing from "./dist/testing.js";
import {
  decodeLocalSqliteOperationPhase,
  encodeLocalSqliteOperationPhase,
} from "./dist/production/operation-phase.js";
import {
  boundedOwnedNames,
  openOwnedDirectory,
  removeOwnedFile,
  renameOwnedFile,
  statOwnedFile,
} from "./dist/production/owned-filesystem.js";

const packageRoot = new URL(".", import.meta.url);
const sourceRoot = new URL("./src/", packageRoot);
const distRoot = new URL("./dist/", packageRoot);

const regularFiles = (rootUrl) => {
  const rootPath = fileURLToPath(rootUrl);
  const files = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Local SQLite artifact contains a symlink: ${path}`);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) files.push(relative(rootPath, path));
      else
        throw new Error(
          `Local SQLite artifact contains a nonregular entry: ${path}`,
        );
    }
  }
  return files.sort();
};

const sourceFiles = regularFiles(sourceRoot).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
);
const migrationFiles = regularFiles(sourceRoot).filter(
  (file) => file.startsWith("migrations/") && file.endsWith(".sql"),
);
const nativeCandidateRoot = new URL("./native-candidate/files/", packageRoot);
const nativeCandidateFiles = regularFiles(nativeCandidateRoot).map(
  (file) => `native-candidate/${file}`,
);
const expectedDist = [
  ...sourceFiles.flatMap((file) => [
    file.replace(/\.ts$/u, ".d.ts"),
    file.replace(/\.ts$/u, ".js"),
  ]),
  ...migrationFiles,
  ...nativeCandidateFiles,
].sort();
const actualDist = regularFiles(distRoot);
if (JSON.stringify(actualDist) !== JSON.stringify(expectedDist))
  throw new Error(
    "Local SQLite dist is not an exact production-source artifact.",
  );
if (actualDist.some((file) => file.includes(".test.")))
  throw new Error("Local SQLite dist contains compiled tests.");

const waitForChildEvent = (child, event, timeoutMilliseconds) =>
  new Promise((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off(event, onEvent);
      child.off("error", onError);
    };
    const onEvent = (...values) => {
      cleanup();
      resolvePromise(values);
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Timed out waiting for child ${event}.`));
    }, timeoutMilliseconds);
    timer.unref();
    child.once(event, onEvent);
    child.once("error", onError);
  });

if (process.platform === "linux") {
  const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const watchdog = fork(
    fileURLToPath(
      new URL("./dist/production/reporter-watchdog.js", packageRoot),
    ),
    [],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const workerExit = waitForChildEvent(worker, "exit", 5_000);
  const watchdogExit = waitForChildEvent(watchdog, "exit", 5_000);
  try {
    const watching = waitForChildEvent(watchdog, "message", 5_000);
    const stat = readFileSync(`/proc/${worker.pid}/stat`, "utf8");
    const workerStartIdentity = createHash("sha256")
      .update(
        `${worker.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`,
      )
      .digest("hex")
      .slice(0, 32);
    watchdog.send({
      type: "watch",
      workerPid: worker.pid,
      workerStartIdentity,
    });
    const [message] = await watching;
    if (message?.type !== "watching")
      throw new Error("Built Reporter watchdog acknowledgement drifted.");
    watchdog.disconnect();
    const [watchdogCode] = await watchdogExit;
    const [workerCode, workerSignal] = await workerExit;
    if (
      watchdogCode !== 70 ||
      workerCode !== null ||
      workerSignal !== "SIGKILL"
    )
      throw new Error("Built Reporter watchdog parent-death cleanup drifted.");
  } finally {
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill("SIGKILL");
    if (watchdog.exitCode === null && watchdog.signalCode === null)
      watchdog.kill("SIGKILL");
  }
}

const expectedRoot = [
  "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST",
  "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST",
  "LOCAL_SQLITE_DESTINATION_TYPE",
  "LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION",
  "createLocalSqliteLifecycleHandler",
  "localSqliteDestinationDescriptor",
  "localSqliteDestinationPackageId",
  "localSqliteLifecycleDeclaration",
  "localSqliteReporterPackageId",
  "localSqliteRetrieverPackageId",
].sort();
if (JSON.stringify(Object.keys(root).sort()) !== JSON.stringify(expectedRoot))
  throw new Error("Local SQLite root export surface drifted.");
if (
  JSON.stringify(Object.keys(reporter)) !==
  JSON.stringify(["localSqliteReporterPackageId"])
)
  throw new Error("Local SQLite Reporter export surface drifted.");
if (
  JSON.stringify(Object.keys(retriever).sort()) !==
  JSON.stringify(["localSqliteRetrieverPackageId"].sort())
)
  throw new Error("Local SQLite Retriever export surface drifted.");
if (
  JSON.stringify(Object.keys(testing)) !==
  JSON.stringify(
    [
      "acquireLocalSqliteExclusiveFence",
      "acquireLocalSqliteSharedLease",
      "amendLocalSqliteLeaseWithChild",
      "canonicalizeLocalSqliteEvidenceForTesting",
      "compileReleaseTarArchiveForTesting",
      "compileLocalSqliteMigrationInventoryForTesting",
      "compileLocalSqliteMigrationSqlForTesting",
      "compileLocalSqliteGetPlan",
      "compileLocalSqliteSearchPlan",
      "createLocalSqliteRetriever",
      "inspectLocalSqliteNativeSupportManifestForTesting",
      "compileLocalSqlitePhysicalNamespaceEvidence",
      "createLocalSqliteLifecycleHandlerForTesting",
      "createLocalSqliteDestinationDescriptorForTesting",
      "createLocalSqliteProductionLifecyclePort",
      "createLocalSqliteProductionMaintenancePort",
      "bindLocalSqliteProductionRuntimeForTesting",
      "createLocalSqliteFilesystemGatePort",
      "createOwnedMigrationDatabase",
      "createOwnedReporterDatabase",
      "createOwnedRetrieverDatabase",
      "currentProcessStartIdentity",
      "initializeOwnedSqliteConnection",
      "LocalSqliteLifecycleError",
      "LocalSqliteNamespaceError",
      "LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR",
      "LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT",
      "LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES",
      "LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES",
      "createLocalSqliteLifecycleArtifactGrammarForTesting",
      "localSqliteLifecycleArtifactGrammarFingerprintForTesting",
      "LOCAL_SQLITE_DESTINATION_FORMAT",
      "LOCAL_SQLITE_MIGRATION_MANIFEST_ID",
      "LOCAL_SQLITE_MIGRATIONS",
      "LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID",
      "LOCAL_SQLITE_REPORTER_POLICY_MANIFEST",
      "LOCAL_SQLITE_REPORTER_POLICY_VERSION",
      "LOCAL_SQLITE_RETRIEVER_PLAN_VERSION",
      "applyLocalSqliteMaintenance",
      "decodeLocalSqliteBackupReceipt",
      "decodeLocalSqliteMaintenanceIntent",
      "encodeLocalSqliteBackupReceipt",
      "encodeLocalSqliteMaintenanceIntent",
      "inspectLocalSqliteDoctor",
      "LocalSqliteMaintenanceError",
      "planLocalSqliteNamespace",
      "createLocalSqliteDatabaseFailureForTesting",
      "createLocalSqliteReporterForTesting",
      "decodeLocalSqliteFenceRecord",
      "decodeLocalSqliteLifecycleIntent",
      "decodeLocalSqliteLeaseRecord",
      "decodeLocalSqliteOwnershipReceipt",
      "encodeLocalSqliteFenceRecord",
      "encodeLocalSqliteLifecycleIntent",
      "encodeLocalSqliteLeaseRecord",
      "encodeLocalSqliteOwnershipReceipt",
      "inspectLocalSqliteLifecycleInventory",
      "prepareLocalSqliteTraceForTesting",
      "LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS",
      "parseLocalSqliteFenceRecord",
      "parseLocalSqliteLeaseRecord",
      "recoverDeadLocalSqliteLease",
      "recoverLocalSqliteMaintenance",
      "releaseLocalSqliteExclusiveFence",
      "releaseLocalSqliteSharedLease",
      "runLocalSqliteMigrations",
      "runLocalSqliteMigrationsWithInventoryForTesting",
    ].sort(),
  )
)
  throw new Error("Local SQLite testing export surface drifted.");
if (
  root.LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION !== 1 ||
  root.LOCAL_SQLITE_DESTINATION_TYPE !==
    "@agentscope/destination-local-sqlite" ||
  root.localSqliteLifecycleDeclaration.destinationType !==
    "@agentscope/destination-local-sqlite" ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.schemaVersion !== 1 ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.disposition !==
    "proposed-unpublished-execution-eligible" ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.nativeBinaries.length !== 1 ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.supportedPlatforms.length !== 1 ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.artifactFiles.length !== 9
)
  throw new Error("Local SQLite proposed native tuple closure drifted.");
const builtCandidateRoot = fileURLToPath(
  new URL("./dist/native-candidate/", packageRoot),
);
const declaredCandidateFiles =
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.artifactFiles
    .map(({ relativePath }) => relativePath)
    .sort();
declaredCandidateFiles.push("records/support-manifest.json");
declaredCandidateFiles.sort();
if (
  JSON.stringify(
    regularFiles(new URL("./dist/native-candidate/", packageRoot)),
  ) !== JSON.stringify(declaredCandidateFiles)
)
  throw new Error("Local SQLite native candidate inventory drifted.");
const supportManifestBytes = readFileSync(
  resolve(builtCandidateRoot, "records/support-manifest.json"),
);
if (
  `sha256:${createHash("sha256").update(supportManifestBytes).digest("hex")}` !==
    root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST ||
  JSON.stringify(JSON.parse(supportManifestBytes)) !==
    JSON.stringify(root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST)
)
  throw new Error("Local SQLite native support manifest drifted.");
if (
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.loaderContract !==
    "owned-absolute-no-discovery-plus-exchange-v2" ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.namespaceMutationContract !==
    "linux-renameat2-exchange-exact-inode-v1"
)
  throw new Error("Local SQLite native namespace authority drifted.");
for (const artifact of root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST
  .artifactFiles) {
  const bytes = readFileSync(
    resolve(builtCandidateRoot, artifact.relativePath),
  );
  if (
    bytes.length !== artifact.bytes ||
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
      artifact.digest
  )
    throw new Error(
      `Local SQLite native candidate artifact drifted: ${artifact.relativePath}`,
    );
}
const releaseMaterials = JSON.parse(
  readFileSync(resolve(builtCandidateRoot, "records/release-materials.json")),
);
if (
  releaseMaterials.schemaVersion !== 3 ||
  releaseMaterials.archiveCompiler?.grammar !==
    "single-gzip-member-ustar-regular-file-only-v2" ||
  releaseMaterials.archiveCompiler?.maximumPathBytes !== 91 ||
  releaseMaterials.archiveCompiler?.maximumArchivePathBytes !== 99 ||
  releaseMaterials.archiveCompiler?.maximumSegmentBytes !== 91 ||
  releaseMaterials.archiveCompiler?.maximumFileBytes !== 16 * 1024 * 1024 ||
  releaseMaterials.buildGraph?.identity !==
    "agentscope-owned-cc-ar-cxx-link-plus-namespace-v2" ||
  releaseMaterials.buildGraph?.upstreamBuildMetadata !== "never-evaluated" ||
  releaseMaterials.buildGraph?.processAuthority !==
    "ptrace-all-process-creation-exact-exec-path-and-driver-ledger-v4" ||
  releaseMaterials.buildGraph?.outputClosure !==
    "exact-whole-writable-root-inventory-with-32MiB-output-cap-v2" ||
  releaseMaterials.materials?.length !== 2 ||
  releaseMaterials.toolchainClosure?.image !==
    "node@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2" ||
  releaseMaterials.toolchainClosure?.imageId !==
    "sha256:a1bea2f8c1ee78866f82039a60baa1c3a480872018aa0ef4891000ec793ed82b" ||
  releaseMaterials.materials.some(
    (material) =>
      !Array.isArray(material.entries) ||
      material.entries.length < 1 ||
      material.entries.length > 128 ||
      new Set(material.entries.map(({ path }) => path)).size !==
        material.entries.length,
  )
)
  throw new Error("Local SQLite release material authority drifted.");
const provenance = JSON.parse(
  readFileSync(resolve(builtCandidateRoot, "records/provenance.json")),
);
const releaseMaterialDigest = createHash("sha256")
  .update(
    readFileSync(resolve(builtCandidateRoot, "records/release-materials.json")),
  )
  .digest("hex");
if (
  provenance.releaseMaterialManifestSha256 !== releaseMaterialDigest ||
  provenance.output?.sha256 !==
    "c580e8f3254f6603a0642db03f48569eaacf471a04497fe15bc1a0567e35292c" ||
  provenance.output?.repeatBuildSha256 !== provenance.output.sha256 ||
  provenance.ownedBuild?.containerImage !==
    releaseMaterials.toolchainClosure.image ||
  provenance.ownedBuild?.containerImageId !==
    releaseMaterials.toolchainClosure.imageId
)
  throw new Error("Local SQLite build provenance authority drifted.");
const sbom = JSON.parse(
  readFileSync(resolve(builtCandidateRoot, "records/sbom.spdx.json")),
);
const generatedFrom = new Set(
  sbom.relationships
    ?.filter(
      ({ spdxElementId, relationshipType }) =>
        spdxElementId === "SPDXRef-File-native" &&
        relationshipType === "GENERATED_FROM",
    )
    .map(({ relatedSpdxElement }) => relatedSpdxElement),
);
if (
  sbom.spdxVersion !== "SPDX-2.3" ||
  sbom.packages?.length !== 4 ||
  !sbom.packages.every(({ filesAnalyzed }) => filesAnalyzed === false) ||
  JSON.stringify([...generatedFrom].sort()) !==
    JSON.stringify(
      [
        "SPDXRef-Package-SQLite",
        "SPDXRef-Package-better-sqlite3",
        "SPDXRef-Package-node-addon-api",
        "SPDXRef-Package-AgentscopeNamespaceHelper",
      ].sort(),
    )
)
  throw new Error("Local SQLite SPDX material closure drifted.");
const builtLifecycleConnectionId = `destination-connection-v1-${"2".repeat(64)}`;
const builtLifecycleIntentBytes = `${JSON.stringify({
  artifactGrammarFingerprint:
    testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  artifactGrammarVersion: 1,
  candidateConfigurationDigest: `sha256-${"4".repeat(64)}`,
  candidateConfigurationGeneration: 2,
  capabilityVersion: 1,
  connectionDigest: createHash("sha256")
    .update(
      JSON.stringify({
        connectionId: builtLifecycleConnectionId,
        destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
      }),
    )
    .digest("hex"),
  connectionId: builtLifecycleConnectionId,
  destinationFormat: testing.LOCAL_SQLITE_DESTINATION_FORMAT,
  destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
  expectedConfigurationDigest: `sha256-${"3".repeat(64)}`,
  expectedConfigurationGeneration: 1,
  lifecycleFingerprint: `sha256-${"5".repeat(64)}`,
  migrationManifestId: testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  namespaceFingerprint: `sha256-${"6".repeat(64)}`,
  operation: "configure",
  owner: {
    processId: 1,
    processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
  },
  physicalEvidenceFingerprint: `sha256-${"8".repeat(64)}`,
  protocolCompatibilityId: testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
  recordVersion: 1,
  recoveryHandlerId: root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  retentionPolicy: {
    maximumAgeNanoseconds: "2592000000000000",
    maximumPayloadBytes: 1_073_741_824,
    maximumTraceCount: 100_000,
    physicalCleanupTrigger: "next-authorized-mutation",
  },
  retainedDatabaseFamilyPhysicalIdentity: null,
  retainedReceiptDigest: null,
  transactionId: "1".repeat(32),
})}\n`;
const builtLifecycleIntent = testing.decodeLocalSqliteLifecycleIntent(
  builtLifecycleIntentBytes,
);
if (
  !builtLifecycleIntent ||
  testing.encodeLocalSqliteLifecycleIntent(builtLifecycleIntent) !==
    builtLifecycleIntentBytes
)
  throw new Error("Local SQLite built lifecycle intent codec drifted.");
try {
  testing.encodeLocalSqliteLifecycleIntent({ ...builtLifecycleIntent });
  throw new Error("Local SQLite copied lifecycle intent was accepted.");
} catch (error) {
  if (error?.code !== "reconciliation-required") throw error;
}
const builtMaintenanceIntentBytes = `${JSON.stringify({
  recordVersion: 1,
  operation: "backup",
  transactionId: "9".repeat(32),
  backupId: "8".repeat(32),
  destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
  connectionId: builtLifecycleConnectionId,
  connectionDigest: createHash("sha256")
    .update(
      JSON.stringify({
        connectionId: builtLifecycleConnectionId,
        destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
      }),
    )
    .digest("hex"),
  owner: {
    processId: 1,
    processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
  },
  namespaceFingerprint: `sha256-${"6".repeat(64)}`,
  physicalEvidenceFingerprint: `sha256-${"8".repeat(64)}`,
  lifecycleFingerprint: `sha256-${"5".repeat(64)}`,
  recoveryHandlerId: root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  artifactGrammarFingerprint:
    testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  artifactGrammarVersion: 1,
  capabilityVersion: 1,
  destinationFormat: testing.LOCAL_SQLITE_DESTINATION_FORMAT,
  migrationManifestId: testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  protocolCompatibilityId: testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
  configurationGeneration: 1,
  configurationDigest: `sha256-${"3".repeat(64)}`,
  maximumAgeNanoseconds: "1",
  maximumTraceCount: 1,
  maximumPayloadBytes: 1,
  selectedReceiptDigest: null,
  selectedSnapshotPhysicalIdentity: null,
})}\n`;
const builtMaintenanceIntent = testing.decodeLocalSqliteMaintenanceIntent(
  builtMaintenanceIntentBytes,
);
if (
  !builtMaintenanceIntent ||
  testing.encodeLocalSqliteMaintenanceIntent(builtMaintenanceIntent) !==
    builtMaintenanceIntentBytes
)
  throw new Error("Local SQLite built maintenance intent codec drifted.");
try {
  testing.encodeLocalSqliteMaintenanceIntent({ ...builtMaintenanceIntent });
  throw new Error("Local SQLite copied maintenance intent was accepted.");
} catch (error) {
  if (error?.code !== "reconciliation-required") throw error;
}

const syntheticMaximumSnapshotBytes =
  testing.LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES;
const syntheticArtifactFingerprint =
  testing.localSqliteLifecycleArtifactGrammarFingerprintForTesting(
    syntheticMaximumSnapshotBytes,
  );
const maintenanceEvents = [];
let capturedMaintenanceIntent = "";
let builtPublishedReceipt = "";
let maintenanceCandidateCalls = 0;
const maintenanceFence = Object.freeze({
  state: "exclusive",
  filename: "exclusive-fence-v1",
  physicalIdentity: "dev:1:ino:9",
  record: Object.freeze({
    transactionId: "9".repeat(32),
    lifecycleFingerprint: `sha256-${"5".repeat(64)}`,
    lifecycleGeneration: 1,
    purpose: "lifecycle",
  }),
  deadLeaseNames: Object.freeze([]),
});
const maintenanceContext = Object.freeze({
  operation: "backup",
  operationId: "9".repeat(32),
  resourceSelector: "8".repeat(32),
  destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
  connectionId: builtLifecycleConnectionId,
  connectionName: "built-local",
  owner: {
    processId: 1,
    processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
  },
  settings: {
    maximumAgeNanoseconds: "1",
    maximumTraceCount: 1,
    maximumPayloadBytes: 1,
  },
  configurationGeneration: 1,
  configurationDigest: `sha256-${"3".repeat(64)}`,
  signal: new AbortController().signal,
  deadline: Object.freeze({ expiresAtMonotonicMilliseconds: 10_000 }),
});
const builtPlanEvidence = Object.freeze({
  namespaceFingerprint: `sha256-${"6".repeat(64)}`,
  physicalEvidenceFingerprint: `sha256-${"8".repeat(64)}`,
  displayPath: "/synthetic/local-sqlite/backups",
  persistentDataNotice: true,
  retentionPolicy: Object.freeze({
    ...maintenanceContext.settings,
    physicalCleanupTrigger: "next-authorized-mutation",
  }),
});
const unused = () => Promise.reject(new Error("unused built maintenance port"));
const builtMaintenancePort = {
  inspectMaintenance: unused,
  publishMaintenanceIntent: (_intent, bytes) => {
    maintenanceEvents.push("intent");
    capturedMaintenanceIntent = bytes;
    return Promise.resolve();
  },
  acquireExclusiveFence: () => Promise.resolve(maintenanceFence),
  revalidatePhysicalEvidence: () => Promise.resolve(),
  inspectBackupInventory: () =>
    Promise.resolve({ entries: [], hasCapacity: true }),
  cleanupRetention: () => Promise.resolve(),
  createBackupCandidate: () => {
    maintenanceCandidateCalls += 1;
    return Promise.resolve();
  },
  verifyBackupCandidate: () =>
    Promise.resolve({
      snapshotPhysicalIdentity: "dev:1:ino:20",
      snapshotBytes: 4_096,
      destinationFormat: testing.LOCAL_SQLITE_DESTINATION_FORMAT,
      migrationManifestId: testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
      protocolCompatibilityId: testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    }),
  publishBackup: (_intent, _receipt, canonicalReceipt) => {
    maintenanceEvents.push("publish");
    builtPublishedReceipt = canonicalReceipt;
    return Promise.resolve();
  },
  readPublishedBackupReceipt: unused,
  verifyPublishedBackup: () =>
    Promise.resolve({
      snapshotPhysicalIdentity: "dev:1:ino:20",
      snapshotBytes: 4_096,
      destinationFormat: testing.LOCAL_SQLITE_DESTINATION_FORMAT,
      migrationManifestId: testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
      protocolCompatibilityId: testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    }),
  readSelectedBackupReceipt: unused,
  createRestoreCandidate: unused,
  verifyRestoreCandidate: unused,
  enforceRestoreRetention: unused,
  replaceActiveWithRestoreCandidate: unused,
  verifyRestoredActive: unused,
  rollbackRestoredActive: unused,
  verifyRolledBackActive: () => {
    maintenanceEvents.push("verify-rollback");
    return Promise.resolve();
  },
  removeRollbackPreimage: unused,
  claimMaintenanceIntent: unused,
  inspectRecoveryPhase: unused,
  rollbackPreparedMaintenance: unused,
  finalizeMaintenance: () => {
    maintenanceEvents.push("finalize");
    return Promise.resolve();
  },
  completeMaintenanceFinalization: () => Promise.resolve(),
  inspectDoctor: () =>
    Promise.resolve({
      state: "available",
      lifecycleState: "clean",
      databaseState: "present",
      backupState: "available",
      sharedLeaseCount: 0,
      publishedBackupCount: 1,
      retentionPolicy: builtPlanEvidence.retentionPolicy,
      databaseDerivedRetention: {
        cutoff: "unavailable",
        clockContinuity: "unavailable",
        rowCount: "unavailable",
        payloadBytes: "unavailable",
      },
    }),
};
const builtBackupResult = await testing.applyLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  builtMaintenancePort,
  Object.freeze({
    ...maintenanceContext,
    planEvidence: Object.freeze({
      planEvidence: builtPlanEvidence,
      resourceSelector: maintenanceContext.resourceSelector,
      selectedBackupAuthority: null,
    }),
  }),
);
if (
  !builtBackupResult.ok ||
  builtBackupResult.state !== "backed-up" ||
  maintenanceCandidateCalls !== 1 ||
  maintenanceEvents.join("|") !== "intent|publish|finalize"
)
  throw new Error("Built Local SQLite backup orchestration drifted.");
const fullBuiltInventory = Array.from({ length: 8 }, (_, index) => {
  const artifactId = (index + 1).toString(16).repeat(32).slice(0, 32);
  return [
    {
      role: "published-snapshot",
      artifactId,
      physicalIdentity: `dev:2:ino:${index + 1}`,
      bytes: 1,
      sparse: false,
    },
    {
      role: "backup-receipt",
      artifactId,
      physicalIdentity: `dev:3:ino:${index + 1}`,
      bytes: 1,
      sparse: false,
    },
  ];
}).flat();
const capacityResult = await testing.applyLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  {
    ...builtMaintenancePort,
    inspectBackupInventory: () =>
      Promise.resolve({ entries: fullBuiltInventory, hasCapacity: true }),
  },
  Object.freeze({
    ...maintenanceContext,
    planEvidence: Object.freeze({
      planEvidence: builtPlanEvidence,
      resourceSelector: maintenanceContext.resourceSelector,
      selectedBackupAuthority: null,
    }),
  }),
);
if (
  capacityResult.ok ||
  capacityResult.code !== "capacity" ||
  maintenanceCandidateCalls !== 1
)
  throw new Error("Built Local SQLite full-inventory capacity gate drifted.");
const backupRecoveryContext = Object.freeze({
  operation: "backup",
  operationId: "9".repeat(32),
  resourceSelector: "8".repeat(32),
  destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
  connectionId: builtLifecycleConnectionId,
  owner: maintenanceContext.owner,
  lifecycleFingerprint: `sha256-${"5".repeat(64)}`,
  recoveryHandlerId: root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  configurationGeneration: 1,
  configurationDigest: `sha256-${"3".repeat(64)}`,
  signal: new AbortController().signal,
  deadline: Object.freeze({ expiresAtMonotonicMilliseconds: 10_000 }),
});
const replacedPublished = await testing.recoverLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  {
    ...builtMaintenancePort,
    claimMaintenanceIntent: () =>
      Promise.resolve({
        canonicalBytes: capturedMaintenanceIntent,
        fence: maintenanceFence,
      }),
    inspectRecoveryPhase: () => Promise.resolve("backup-published"),
    readPublishedBackupReceipt: () => Promise.resolve(builtPublishedReceipt),
    verifyPublishedBackup: () =>
      Promise.resolve({
        snapshotPhysicalIdentity: "dev:1:ino:999",
        snapshotBytes: 4_096,
        destinationFormat: testing.LOCAL_SQLITE_DESTINATION_FORMAT,
        migrationManifestId: testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
        protocolCompatibilityId: testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
      }),
  },
  backupRecoveryContext,
);
const wrongCandidate = await testing.recoverLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  {
    ...builtMaintenancePort,
    claimMaintenanceIntent: () =>
      Promise.resolve({
        canonicalBytes: capturedMaintenanceIntent,
        fence: maintenanceFence,
      }),
    inspectRecoveryPhase: () => Promise.resolve("backup-candidate"),
    inspectBackupInventory: () =>
      Promise.resolve({
        entries: [
          {
            role: "database-candidate",
            artifactId: "6".repeat(32),
            physicalIdentity: "dev:1:ino:40",
            bytes: 4_096,
            sparse: false,
          },
        ],
        hasCapacity: true,
      }),
  },
  backupRecoveryContext,
);
const wrongTransactionReceipt = JSON.parse(builtPublishedReceipt);
wrongTransactionReceipt.transactionId = "6".repeat(32);
const wrongTransaction = await testing.recoverLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  {
    ...builtMaintenancePort,
    claimMaintenanceIntent: () =>
      Promise.resolve({
        canonicalBytes: capturedMaintenanceIntent,
        fence: maintenanceFence,
      }),
    inspectRecoveryPhase: () => Promise.resolve("backup-published"),
    readPublishedBackupReceipt: () =>
      Promise.resolve(`${JSON.stringify(wrongTransactionReceipt)}\n`),
  },
  backupRecoveryContext,
);
if (
  replacedPublished.ok ||
  replacedPublished.code !== "reconciliation-required" ||
  wrongCandidate.ok ||
  wrongCandidate.code !== "reconciliation-required" ||
  wrongTransaction.ok ||
  wrongTransaction.code !== "reconciliation-required"
)
  throw new Error("Built Local SQLite recovery identity gates drifted.");
const restoreIntentRecord = JSON.parse(capturedMaintenanceIntent);
restoreIntentRecord.operation = "restore";
restoreIntentRecord.transactionId = "7".repeat(32);
restoreIntentRecord.selectedReceiptDigest = `sha256-${"4".repeat(64)}`;
restoreIntentRecord.selectedSnapshotPhysicalIdentity = "dev:1:ino:20";
const restoreIntentBytes = `${JSON.stringify(restoreIntentRecord)}\n`;
if (
  !testing.decodeLocalSqliteMaintenanceIntent(
    restoreIntentBytes,
    syntheticArtifactFingerprint,
  )
)
  throw new Error("Built synthetic restore intent was not canonical.");
const recoveryContext = Object.freeze({
  operation: "restore",
  operationId: "7".repeat(32),
  resourceSelector: "8".repeat(32),
  destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
  connectionId: builtLifecycleConnectionId,
  owner: maintenanceContext.owner,
  lifecycleFingerprint: `sha256-${"5".repeat(64)}`,
  recoveryHandlerId: root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  configurationGeneration: 1,
  configurationDigest: `sha256-${"3".repeat(64)}`,
  signal: new AbortController().signal,
  deadline: Object.freeze({ expiresAtMonotonicMilliseconds: 10_000 }),
});
const recovered = await testing.recoverLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  {
    ...builtMaintenancePort,
    claimMaintenanceIntent: () =>
      Promise.resolve({
        canonicalBytes: restoreIntentBytes,
        fence: maintenanceFence,
      }),
    inspectRecoveryPhase: () => Promise.resolve("restore-rolled-back"),
  },
  recoveryContext,
);
if (
  !recovered.ok ||
  recovered.state !== "rolled-back" ||
  maintenanceEvents.at(-2) !== "verify-rollback" ||
  maintenanceEvents.at(-1) !== "finalize"
)
  throw new Error("Built Local SQLite rollback recovery drifted.");
let builtRestoreRollbackCalls = 0;
let builtPreimageRemovalCalls = 0;
const swappedActive = await testing.recoverLocalSqliteMaintenance(
  `sha256-${"5".repeat(64)}`,
  root.localSqliteLifecycleDeclaration.recoveryHandlerId,
  syntheticMaximumSnapshotBytes,
  {
    ...builtMaintenancePort,
    claimMaintenanceIntent: () =>
      Promise.resolve({
        canonicalBytes: restoreIntentBytes,
        fence: maintenanceFence,
      }),
    inspectRecoveryPhase: () => Promise.resolve("restore-verified"),
    verifyRestoredActive: () => Promise.resolve(false),
    rollbackRestoredActive: () => {
      builtRestoreRollbackCalls += 1;
      return Promise.resolve();
    },
    removeRollbackPreimage: () => {
      builtPreimageRemovalCalls += 1;
      return Promise.resolve();
    },
  },
  recoveryContext,
);
if (
  swappedActive.ok ||
  swappedActive.code !== "unavailable" ||
  builtRestoreRollbackCalls !== 1 ||
  builtPreimageRemovalCalls !== 0
)
  throw new Error("Built Local SQLite restore revalidation drifted.");
const doctorContext = Object.freeze({
  destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
  connectionId: builtLifecycleConnectionId,
  connectionName: "built-local",
  settings: maintenanceContext.settings,
  configurationGeneration: 1,
  configurationDigest: `sha256-${"3".repeat(64)}`,
  signal: new AbortController().signal,
  deadline: Object.freeze({ expiresAtMonotonicMilliseconds: 10_000 }),
});
const builtDoctor = await testing.inspectLocalSqliteDoctor(
  builtMaintenancePort,
  doctorContext,
);
if (
  builtDoctor.databaseDerivedRetention.rowCount !== "unavailable" ||
  builtDoctor.databaseDerivedRetention.payloadBytes !== "unavailable" ||
  JSON.stringify(builtDoctor).includes("built-local") ||
  JSON.stringify(builtDoctor).includes(builtLifecycleConnectionId)
)
  throw new Error("Built Local SQLite conservative Doctor drifted.");

const replacementRoot = mkdtempSync(
  join(tmpdir(), "agentscope-built-local-replacement-"),
);
chmodSync(replacementRoot, 0o700);
try {
  const replacementNamespace = testing.planLocalSqliteNamespace({
    agentscopeHome: replacementRoot,
    connectionId: builtLifecycleConnectionId,
    platform: process.platform === "win32" ? "win32" : "posix",
  });
  for (const directory of [
    replacementNamespace.destinationsDirectory,
    replacementNamespace.destinationTypeDirectory,
    replacementNamespace.connectionNamespace,
    replacementNamespace.lifecycleDirectory,
    replacementNamespace.backupsDirectory,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const replacementBackupId = "a".repeat(32);
  const replacementCandidate = join(
    replacementNamespace.backupsDirectory,
    `candidate-${replacementBackupId}.sqlite`,
  );
  const displacedCandidate = `${replacementCandidate}.displaced`;
  writeFileSync(replacementCandidate, "same-size-a", { mode: 0o600 });
  let doctorReplaced = false;
  const replacementBase = {
    home: { root: replacementRoot, platform: process.platform },
    filesystemProfile: "local-ext4",
    opener: {
      open: () => {
        throw new Error("built replacement verifier opened SQLite");
      },
    },
    allowPathFallbackForTesting: true,
  };
  const doctorReplacementPort =
    testing.createLocalSqliteProductionMaintenancePort({
      ...replacementBase,
      doctorAfterFirstScanForTesting: () => {
        if (doctorReplaced) return;
        doctorReplaced = true;
        renameSync(replacementCandidate, displacedCandidate);
        writeFileSync(replacementCandidate, "same-size-b", { mode: 0o600 });
      },
    });
  const replacementDoctor = await doctorReplacementPort.inspectDoctor({
    connectionId: builtLifecycleConnectionId,
    settings: maintenanceContext.settings,
    signal: new AbortController().signal,
  });
  if (
    !doctorReplaced ||
    replacementDoctor.state !== "unavailable" ||
    replacementDoctor.backupState !== "unavailable"
  )
    throw new Error("Built Local SQLite Doctor replacement gate drifted.");

  rmSync(displacedCandidate);
  writeFileSync(replacementCandidate, "same-size-a", { mode: 0o600 });
  let inventoryReplaced = false;
  const inventoryReplacementPort =
    testing.createLocalSqliteProductionMaintenancePort({
      ...replacementBase,
      maintenanceAfterFirstInventoryScanForTesting: () => {
        if (inventoryReplaced) return;
        inventoryReplaced = true;
        renameSync(replacementCandidate, displacedCandidate);
        writeFileSync(replacementCandidate, "same-size-b", { mode: 0o600 });
      },
    });
  const replacementIntent = {
    operation: "backup",
    transactionId: "b".repeat(32),
    backupId: replacementBackupId,
    connectionId: builtLifecycleConnectionId,
    lifecycleFingerprint: root.localSqliteLifecycleDeclaration.fingerprint,
    capabilityVersion: 1,
    artifactGrammarFingerprint:
      testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  };
  const replacementFence = Object.freeze({
    state: "exclusive",
    filename: "exclusive-fence-v1",
    physicalIdentity: "dev:1:ino:1",
    record: Object.freeze({
      transactionId: replacementIntent.transactionId,
      lifecycleFingerprint: replacementIntent.lifecycleFingerprint,
      lifecycleGeneration: 1,
      purpose: "lifecycle",
    }),
    deadLeaseNames: Object.freeze([]),
  });
  let inventoryRejected = false;
  try {
    await inventoryReplacementPort.inspectBackupInventory(
      replacementIntent,
      replacementFence,
      new AbortController().signal,
    );
  } catch (error) {
    inventoryRejected = error?.code === "reconciliation-required";
  }
  if (!inventoryReplaced || !inventoryRejected)
    throw new Error("Built Local SQLite inventory replacement gate drifted.");
} finally {
  rmSync(replacementRoot, { recursive: true, force: true });
}
const artifactGrammarFingerprint = `sha256-${createHash("sha256")
  .update(JSON.stringify(testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR))
  .digest("hex")}`;
if (
  artifactGrammarFingerprint !==
    testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT ||
  root.localSqliteLifecycleDeclaration.artifactGrammarFingerprint !==
    artifactGrammarFingerprint ||
  !root.localSqliteLifecycleDeclaration.artifactKinds.includes(
    "configure-database-candidate",
  ) ||
  !root.localSqliteLifecycleDeclaration.artifactKinds.includes(
    "restore-database-candidate",
  ) ||
  !root.localSqliteLifecycleDeclaration.artifactKinds.includes(
    "operation-phase",
  )
)
  throw new Error("Local SQLite lifecycle artifact grammar drifted.");
const artifactsByKind = new Map(
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.artifacts.map((artifact) => [
    artifact.kind,
    artifact,
  ]),
);
const builtOperationPhase = Object.freeze({
  schemaVersion: 1,
  operation: "restore",
  phase: "restore-verified",
  transactionId: "1".repeat(32),
  lifecycleFingerprint: `sha256-${"2".repeat(64)}`,
  artifactGrammarFingerprint,
  artifactPhysicalIdentity: "dev:1:ino:2",
});
const builtOperationPhaseBytes =
  encodeLocalSqliteOperationPhase(builtOperationPhase);
if (
  JSON.stringify(decodeLocalSqliteOperationPhase(builtOperationPhaseBytes)) !==
    JSON.stringify(builtOperationPhase) ||
  decodeLocalSqliteOperationPhase(
    `${JSON.stringify({
      ...builtOperationPhase,
      extra: true,
    })}\n`,
  ) !== undefined ||
  decodeLocalSqliteOperationPhase(
    `${JSON.stringify({ ...builtOperationPhase, operation: "backup" })}\n`,
  ) !== undefined
)
  throw new Error("Built Local SQLite operation-phase codec drifted.");
const builtPhaseRoot = mkdtempSync(join(tmpdir(), "agentscope-built-phase-"));
chmodSync(builtPhaseRoot, 0o700);
try {
  const builtPhaseConnectionId = `destination-connection-v1-${"7".repeat(64)}`;
  const builtPhasePlan = testing.planLocalSqliteNamespace({
    agentscopeHome: builtPhaseRoot,
    connectionId: builtPhaseConnectionId,
    platform: process.platform === "win32" ? "win32" : "posix",
  });
  mkdirSync(builtPhasePlan.lifecycleDirectory, {
    recursive: true,
    mode: 0o700,
  });
  for (const directory of [
    dirname(dirname(builtPhasePlan.connectionNamespace)),
    dirname(builtPhasePlan.connectionNamespace),
    builtPhasePlan.connectionNamespace,
    builtPhasePlan.lifecycleDirectory,
  ])
    chmodSync(directory, 0o700);
  writeFileSync(
    join(
      builtPhasePlan.connectionNamespace,
      `configure-${"1".repeat(32)}.sqlite`,
    ),
    "",
    { mode: 0o600 },
  );
  writeFileSync(
    join(builtPhasePlan.lifecycleDirectory, "operation-phase-v1.json"),
    encodeLocalSqliteOperationPhase({
      ...builtOperationPhase,
      operation: "configure",
      phase: "configured-active",
      transactionId: "9".repeat(32),
    }),
    { mode: 0o600 },
  );
  let builtOpenerCalls = 0;
  const builtLifecyclePort = testing.createLocalSqliteProductionLifecyclePort({
    home: { root: builtPhaseRoot, platform: process.platform },
    filesystemProfile: "local-ext4",
    opener: {
      open: () => {
        builtOpenerCalls += 1;
        throw new Error("built operation phase must reject before native open");
      },
    },
    allowPathFallbackForTesting: true,
  });
  let builtPhaseRejected = false;
  try {
    await builtLifecyclePort.activateConfigure(
      {
        recordVersion: 1,
        operation: "configure",
        transactionId: "1".repeat(32),
        destinationType: root.LOCAL_SQLITE_DESTINATION_TYPE,
        connectionId: builtPhaseConnectionId,
        connectionDigest: builtPhasePlan.connectionDigest,
        owner: { processId: process.pid, processStartIdentity: "owner" },
        namespaceFingerprint: builtPhasePlan.fingerprint,
        physicalEvidenceFingerprint: `sha256-${"3".repeat(64)}`,
        lifecycleFingerprint: builtOperationPhase.lifecycleFingerprint,
        recoveryHandlerId: "built-recovery-handler",
        artifactGrammarFingerprint,
        artifactGrammarVersion: 1,
        capabilityVersion: 1,
        destinationFormat: "built-format",
        migrationManifestId: "built-migration",
        protocolCompatibilityId: "built-protocol",
        expectedConfigurationGeneration: 1,
        candidateConfigurationGeneration: 2,
        expectedConfigurationDigest: `sha256-${"4".repeat(64)}`,
        candidateConfigurationDigest: `sha256-${"5".repeat(64)}`,
        retainedReceiptDigest: null,
        retainedDatabaseFamilyPhysicalIdentity: null,
        retentionPolicy: {
          maximumAgeNanoseconds: "1",
          maximumTraceCount: 1,
          maximumPayloadBytes: 1,
          physicalCleanupTrigger: "next-authorized-mutation",
        },
      },
      {
        state: "exclusive",
        filename: "exclusive-fence-v1",
        physicalIdentity: "dev:1:ino:3",
        record: {
          transactionId: "1".repeat(32),
          lifecycleFingerprint: builtOperationPhase.lifecycleFingerprint,
          lifecycleGeneration: 1,
        },
        deadLeaseNames: [],
      },
      new AbortController().signal,
    );
  } catch (error) {
    builtPhaseRejected = error?.code === "reconciliation-required";
  }
  if (!builtPhaseRejected || builtOpenerCalls !== 0)
    throw new Error("Built Local SQLite operation-phase authority drifted.");
} finally {
  rmSync(builtPhaseRoot, { recursive: true, force: true });
}
const sameDirectoryRoles = [
  "configure-database-candidate",
  "restore-database-candidate",
  "rollback-preimage",
];
const lifecycleLimits =
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.inspectionLimits;
if (
  artifactsByKind.get("active-database")?.relativePathGrammar !==
    "traces.sqlite" ||
  sameDirectoryRoles.some((kind) =>
    artifactsByKind.get(kind)?.relativePathGrammar.includes("/"),
  ) ||
  lifecycleLimits.maximumBackupDirectoryEntries !== 32 ||
  lifecycleLimits.maximumPublishedBackups !== 8 ||
  lifecycleLimits.maximumMetadataAggregateBytes !== 65_536 ||
  lifecycleLimits.maximumTransientDatabaseCandidates !== 1 ||
  lifecycleLimits.maximumTransientRollbackPreimages !== 1 ||
  lifecycleLimits.leaseRecordBytes !== 256 ||
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.supportManifest
    .maximumSnapshotBytes !==
    16 * 1024 * 1024 * 1024 ||
  testing.LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES !== 16 * 1024 * 1024 * 1024 ||
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.supportManifest
    .nativeAdmission !== "proposed-unpublished-execution-eligible"
)
  throw new Error(
    "Local SQLite lifecycle bounds or candidate placement drifted.",
  );
const transientGroups = new Map(
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.transientRoleGroups.map(
    (group) => [group.name, group],
  ),
);
const candidateGroup = transientGroups.get("database-candidate");
const preimageGroup = transientGroups.get("rollback-preimage");
if (
  candidateGroup?.maximumCountAcrossKinds !== 1 ||
  candidateGroup.maximumBytesPerArtifact !==
    "supportManifest.maximumSnapshotBytes" ||
  candidateGroup.kinds.join(",") !==
    "backup-candidate,configure-database-candidate,restore-database-candidate" ||
  preimageGroup?.maximumCountAcrossKinds !== 1 ||
  preimageGroup.maximumBytesPerArtifact !==
    "supportManifest.maximumSnapshotBytes" ||
  preimageGroup.kinds.join(",") !== "rollback-preimage"
)
  throw new Error("Local SQLite transient role grouping drifted.");

const namespacePlan = testing.planLocalSqliteNamespace({
  agentscopeHome: "/home/artifact/.agentscope",
  connectionId:
    "destination-connection-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  platform: "posix",
});
const namespaceEvidence = testing.compileLocalSqlitePhysicalNamespaceEvidence(
  namespacePlan,
  {
    absenceBoundary: null,
    existingAncestors: [
      ["agentscope-home", namespacePlan.agentscopeHome, "dev1:ino1"],
      ["destinations", namespacePlan.destinationsDirectory, "dev1:ino2"],
      ["destination-type", namespacePlan.destinationTypeDirectory, "dev1:ino3"],
      ["connection-namespace", namespacePlan.connectionNamespace, "dev1:ino4"],
    ].map(([role, path, physicalIdentity]) => ({
      currentUserOnly: true,
      kind: "directory",
      noFollow: true,
      path,
      physicalIdentity,
      role,
      state: "existing",
    })),
    filesystemProfile: "local-ext4",
    plannedAbsentAncestors: [],
    schemaVersion: 1,
  },
);
if (
  namespacePlan.databasePath !==
    `${namespacePlan.connectionNamespace}/traces.sqlite` ||
  namespaceEvidence.namespaceFingerprint !== namespacePlan.fingerprint
)
  throw new Error("Local SQLite built namespace authority drifted.");
const firstConfigureEvidence = {
  absenceBoundary: {
    firstAbsentPath: namespacePlan.destinationsDirectory,
    firstAbsentRole: "destinations",
    nameCollisionFree: true,
    noFollow: true,
    parentPath: namespacePlan.agentscopeHome,
    parentPhysicalIdentity: "dev1:ino1",
    parentRole: "agentscope-home",
  },
  existingAncestors: [
    {
      currentUserOnly: true,
      kind: "directory",
      noFollow: true,
      path: namespacePlan.agentscopeHome,
      physicalIdentity: "dev1:ino1",
      role: "agentscope-home",
      state: "existing",
    },
  ],
  filesystemProfile: "local-ext4",
  plannedAbsentAncestors: [
    ["destinations", namespacePlan.destinationsDirectory],
    ["destination-type", namespacePlan.destinationTypeDirectory],
    ["connection-namespace", namespacePlan.connectionNamespace],
  ].map(([role, path]) => ({
    createMode: "current-user-only",
    noFollow: true,
    path,
    role,
    state: "planned-absent",
  })),
  schemaVersion: 1,
};
const firstConfigureBefore = JSON.stringify(firstConfigureEvidence);
const firstConfigureCompiled =
  testing.compileLocalSqlitePhysicalNamespaceEvidence(
    namespacePlan,
    firstConfigureEvidence,
  );
if (
  JSON.stringify(firstConfigureEvidence) !== firstConfigureBefore ||
  firstConfigureCompiled.existingAncestors.length !== 1 ||
  firstConfigureCompiled.plannedAbsentAncestors.length !== 3 ||
  new testing.LocalSqliteNamespaceError().code !==
    "destination.local-sqlite.namespace-invalid"
)
  throw new Error("Local SQLite built first-configure authority drifted.");

const runtimeIdentity = {
  nodeAbi: 127,
  nodeMajor: 22,
  platform: "linux",
  osVersion: "6.8",
  architecture: "x64",
  libcFamily: "glibc",
  libcVersion: "2.39",
  credentialBackend: "ci-environment",
  filesystemProfile: "local-ext4",
};
const proposed = testing.inspectLocalSqliteNativeSupportManifestForTesting(
  runtimeIdentity,
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
);
const unavailable = testing.inspectLocalSqliteNativeSupportManifestForTesting(
  { ...runtimeIdentity, nodeAbi: 128 },
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
);
if (
  proposed.state !== "available" ||
  proposed.admission !== "proposed-unpublished" ||
  proposed.nativeTupleId !== "node127-linux-x64-glibc" ||
  unavailable.state !== "unavailable" ||
  unavailable.code !== "destination.local-sqlite.native-unavailable"
)
  throw new Error("Local SQLite built unavailable boundary drifted.");

let coercionCalls = 0;
const hostileValue = Object.freeze({
  toString() {
    coercionCalls += 1;
    return "glibc";
  },
  [Symbol.toPrimitive]() {
    coercionCalls += 1;
    return "glibc";
  },
});
testing.inspectLocalSqliteNativeSupportManifestForTesting(
  { ...runtimeIdentity, libcFamily: hostileValue },
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
);
if (coercionCalls !== 0)
  throw new Error("Local SQLite built boundary coerced caller-owned data.");

if (
  testing.LOCAL_SQLITE_DESTINATION_FORMAT !== "agentscope.local-sqlite.v1" ||
  testing.LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID !==
    standardsManifest.manifestId ||
  !/^sha256:[a-f0-9]{64}$/u.test(testing.LOCAL_SQLITE_MIGRATION_MANIFEST_ID) ||
  testing.LOCAL_SQLITE_MIGRATIONS.length !== 2 ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.name !== "0001-initialize.sql" ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.sha256 !==
    "616f0f680cd8d86d36e3f880caf0925e6c0a16138d50e4af98e907bcfb855d24" ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.protocolCompatibilityId !==
    standardsManifest.manifestId ||
  testing.LOCAL_SQLITE_MIGRATIONS[1]?.name !== "0002-retrieval-indexes.sql" ||
  testing.LOCAL_SQLITE_MIGRATIONS[1]?.sha256 !==
    "48472b1673ed36f4bb77494b3f8c6b425c99467004a2c3da2f042e896e693a3e" ||
  testing.LOCAL_SQLITE_MIGRATIONS[1]?.protocolCompatibilityId !==
    standardsManifest.manifestId ||
  testing.compileLocalSqliteMigrationInventoryForTesting(
    testing.LOCAL_SQLITE_MIGRATIONS,
  )?.length !== 2 ||
  testing.compileLocalSqliteMigrationSqlForTesting(
    "CREATE TABLE payload_copy AS SELECT payload FROM traces;",
  ) !== undefined
)
  throw new Error("Local SQLite built migration authority drifted.");

const migrationState = {
  transaction: false,
  committed: false,
  rolledBack: false,
  statements: [],
  ledger: [],
  metadata: undefined,
};
const migrationDatabase = Object.freeze({
  beginExclusive() {
    migrationState.transaction = true;
  },
  execute(statement) {
    migrationState.statements.push(statement);
  },
  inTransaction() {
    return migrationState.transaction;
  },
  readMigrationLedger() {
    return migrationState.ledger;
  },
  recordMigration(entry) {
    migrationState.ledger.push(entry);
  },
  readDestinationMetadata() {
    return migrationState.metadata;
  },
  writeDestinationMetadata(metadata) {
    migrationState.metadata = metadata;
  },
  readImmutableRows() {
    return [];
  },
  rebuildPortableProjections() {},
  readPortableProjections() {
    return [];
  },
  readExpectedPortableProjections() {
    return [];
  },
  commit() {
    migrationState.transaction = false;
    migrationState.committed = true;
  },
  rollback() {
    migrationState.transaction = false;
    migrationState.rolledBack = true;
  },
});
const migrationResult = testing.runLocalSqliteMigrations(migrationDatabase);
if (
  migrationResult.ok !== true ||
  migrationResult.state !== "migrated" ||
  migrationState.statements.length !== 8 ||
  migrationState.ledger.length !== 2 ||
  migrationState.committed !== true ||
  migrationState.rolledBack !== false
)
  throw new Error("Local SQLite built migration transaction drifted.");
const workBeforeInvalidInventory = migrationState.statements.length;
const invalidInventoryResult =
  testing.runLocalSqliteMigrationsWithInventoryForTesting(
    migrationDatabase,
    [],
  );
if (
  invalidInventoryResult.ok !== false ||
  invalidInventoryResult.state !== "invalid-inventory" ||
  migrationState.statements.length !== workBeforeInvalidInventory
)
  throw new Error("Local SQLite built migration preflight drifted.");

const missingLedgerState = {
  transaction: false,
  committed: false,
  rolledBack: false,
  metadata: undefined,
};
const missingLedgerDatabase = Object.freeze({
  ...migrationDatabase,
  beginExclusive() {
    missingLedgerState.transaction = true;
  },
  inTransaction() {
    return missingLedgerState.transaction;
  },
  readMigrationLedger() {
    return [];
  },
  recordMigration() {},
  readDestinationMetadata() {
    return missingLedgerState.metadata;
  },
  writeDestinationMetadata(metadata) {
    missingLedgerState.metadata = metadata;
  },
  commit() {
    missingLedgerState.committed = true;
  },
  rollback() {
    missingLedgerState.transaction = false;
    missingLedgerState.rolledBack = true;
  },
});
const missingLedgerResult = testing.runLocalSqliteMigrations(
  missingLedgerDatabase,
);
if (
  missingLedgerResult.ok !== false ||
  missingLedgerResult.state !== "reconciliation-required" ||
  missingLedgerState.committed !== false ||
  missingLedgerState.rolledBack !== true
)
  throw new Error("Local SQLite built candidate-ledger proof drifted.");

const reporterState = {
  transaction: false,
  committed: false,
  rows: [],
  trustedTime: undefined,
};
const reporterDatabase = Object.freeze({
  beginImmediate() {
    reporterState.transaction = true;
  },
  inTransaction() {
    return reporterState.transaction;
  },
  readLastTrustedTimeUnixNano() {
    return reporterState.trustedTime;
  },
  readExisting(identities) {
    return reporterState.rows.filter((row) =>
      identities.includes(row.deliveryIdentity),
    );
  },
  deleteExpiredBefore() {},
  insertTrace(trace) {
    reporterState.rows.push({
      deliveryIdentity: trace.deliveryIdentity,
      traceId: trace.traceId,
      admissionTimeUnixNano: trace.admissionTimeUnixNano,
      protocolCompatibilityId: trace.protocolCompatibilityId,
      payloadSha256: trace.payloadSha256,
      payloadBytes: trace.payloadBytes,
    });
    return "inserted";
  },
  readCapacity() {
    return {
      traceCount: reporterState.rows.length,
      payloadBytes: reporterState.rows.reduce(
        (total, row) => total + row.payloadBytes,
        0,
      ),
    };
  },
  evictOldestUntilWithin() {},
  writeLastTrustedTimeUnixNano(value) {
    reporterState.trustedTime = value;
  },
  commit() {
    reporterState.transaction = false;
    reporterState.committed = true;
  },
  rollback() {
    reporterState.transaction = false;
  },
});
const preparedTrace = Object.freeze({
  deliveryIdentity: "1".repeat(64),
  traceId: "2".repeat(32),
  startTimeUnixNano: "1",
  startTimeSortKey: "00000000000000000001",
  admissionTimeUnixNano: "1000000",
  admissionTimeSortKey: "00000000000001000000",
  protocolCompatibilityId: standardsManifest.manifestId,
  payloadUtf8: "{}",
  payloadSha256:
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  payloadBytes: 2,
  dimensions: Object.freeze([
    Object.freeze({ kind: "harness", value: "artifact", ordinal: 0 }),
  ]),
});
const builtReporterResult = executePreparedLocalSqliteTransaction(
  reporterDatabase,
  {
    maximumAgeNanoseconds: "2592000000000000",
    maximumTraceCount: 100000,
    maximumPayloadBytes: 1073741824,
  },
  Object.freeze([preparedTrace]),
  "1000000",
  () => false,
);
if (
  testing.LOCAL_SQLITE_REPORTER_POLICY_VERSION !== 1 ||
  testing.LOCAL_SQLITE_REPORTER_POLICY_MANIFEST.maximumAgeNanoseconds !==
    "31536000000000000" ||
  testing.LOCAL_SQLITE_REPORTER_POLICY_MANIFEST
    .maximumForwardJumpNanoseconds !== "3600000000000" ||
  builtReporterResult.outcome !== "accepted" ||
  reporterState.committed !== true ||
  reporterState.rows.length !== 1 ||
  reporterState.rows[0]?.payloadSha256 !== preparedTrace.payloadSha256 ||
  preparedTrace.dimensions.length !== 1
)
  throw new Error("Local SQLite built Reporter transaction drifted.");

const builtRetriever = testing.createLocalSqliteRetriever(
  Object.freeze({
    search: () => Promise.reject(new Error("artifact-static-only")),
    get: () => Promise.reject(new Error("artifact-static-only")),
  }),
);
const builtExecutionBounds = Object.freeze({
  maximumResponseBytes: 4_096,
  maximumWorkMilliseconds: 250,
});
const builtSearchPlan = testing.compileLocalSqliteSearchPlan(
  {
    query: {
      to: "2099-01-01T00:00:00.000Z",
      tags: [],
      limit: 1,
    },
  },
  builtExecutionBounds,
);
const builtGetPlan = testing.compileLocalSqliteGetPlan(
  { locator: { traceId: "a".repeat(32) } },
  builtExecutionBounds,
);
if (
  testing.LOCAL_SQLITE_RETRIEVER_PLAN_VERSION !== 1 ||
  !isDestinationRetriever(builtRetriever) ||
  builtSearchPlan?.maximumResponseBytes !== 4_096 ||
  builtSearchPlan.maximumWorkMilliseconds !== 250 ||
  !builtSearchPlan.sql.includes(
    "admission_time_sort_key >= :retentionCutoffSortKey",
  ) ||
  !builtSearchPlan.sql.includes(
    "t2.admission_time_sort_key >= :retentionCutoffSortKey",
  ) ||
  builtGetPlan?.maximumResponseBytes !== 4_096 ||
  builtGetPlan.maximumWorkMilliseconds !== 250
)
  throw new Error("Local SQLite built Retriever artifact drifted.");

let corruptAdmissionCommitted = false;
const corruptAdmissionDatabase = Object.freeze({
  ...reporterDatabase,
  insertTrace(trace) {
    reporterState.rows.push({
      deliveryIdentity: trace.deliveryIdentity,
      traceId: trace.traceId,
      admissionTimeUnixNano: "999",
      protocolCompatibilityId: trace.protocolCompatibilityId,
      payloadSha256: trace.payloadSha256,
      payloadBytes: trace.payloadBytes,
    });
    return "inserted";
  },
  commit() {
    corruptAdmissionCommitted = true;
  },
});
reporterState.rows = [];
reporterState.transaction = false;
const corruptAdmissionResult = executePreparedLocalSqliteTransaction(
  corruptAdmissionDatabase,
  {
    maximumAgeNanoseconds: "2592000000000000",
    maximumTraceCount: 100000,
    maximumPayloadBytes: 1073741824,
  },
  Object.freeze([preparedTrace]),
  "1000000",
  () => false,
);
if (
  corruptAdmissionResult.outcome !== "unavailable" ||
  corruptAdmissionCommitted
)
  throw new Error("Local SQLite built admission-time proof drifted.");

let failedBeginRollbackCalls = 0;
const failedBeginDatabase = Object.freeze({
  ...reporterDatabase,
  beginImmediate() {
    throw testing.createLocalSqliteDatabaseFailureForTesting(
      "destination-busy",
    );
  },
  inTransaction() {
    return false;
  },
  rollback() {
    failedBeginRollbackCalls += 1;
    throw new Error("no-transaction");
  },
});
const failedBeginResult = executePreparedLocalSqliteTransaction(
  failedBeginDatabase,
  {
    maximumAgeNanoseconds: "2592000000000000",
    maximumTraceCount: 100000,
    maximumPayloadBytes: 1073741824,
  },
  Object.freeze([preparedTrace]),
  "1000000",
  () => false,
);
if (
  failedBeginResult.outcome !== "unavailable" ||
  failedBeginResult.reason !== "destination-busy" ||
  failedBeginRollbackCalls !== 0
)
  throw new Error("Local SQLite built failed-BEGIN proof drifted.");

reporterState.rows = [];
reporterState.transaction = false;
reporterState.trustedTime = undefined;
let outsideTransactionDelete = false;
const readLossDatabase = Object.freeze({
  ...reporterDatabase,
  readExisting() {
    reporterState.transaction = false;
    return [];
  },
  deleteExpiredBefore() {
    outsideTransactionDelete = true;
  },
});
const readLossResult = executePreparedLocalSqliteTransaction(
  readLossDatabase,
  {
    maximumAgeNanoseconds: "2592000000000000",
    maximumTraceCount: 100000,
    maximumPayloadBytes: 1073741824,
  },
  Object.freeze([preparedTrace]),
  "1000000",
  () => false,
);
if (readLossResult.outcome !== "outcome-unknown" || outsideTransactionDelete)
  throw new Error("Local SQLite built read-loss proof drifted.");

reporterState.rows = [];
reporterState.transaction = false;
let durableDelete = false;
let endedRollbackCalls = 0;
const mutationLossDatabase = Object.freeze({
  ...reporterDatabase,
  deleteExpiredBefore() {
    durableDelete = true;
    reporterState.transaction = false;
  },
  rollback() {
    endedRollbackCalls += 1;
  },
});
const mutationLossResult = executePreparedLocalSqliteTransaction(
  mutationLossDatabase,
  {
    maximumAgeNanoseconds: "2592000000000000",
    maximumTraceCount: 100000,
    maximumPayloadBytes: 1073741824,
  },
  Object.freeze([preparedTrace]),
  "1000000",
  () => false,
);
if (
  mutationLossResult.outcome !== "outcome-unknown" ||
  !durableDelete ||
  endedRollbackCalls !== 0
)
  throw new Error("Local SQLite built mutation-loss proof drifted.");

let rejectedPolicy = false;
try {
  testing.createLocalSqliteReporterForTesting(reporterDatabase, {
    maximumAgeNanoseconds: "31536000000000001",
    maximumTraceCount: 100000,
    maximumPayloadBytes: 1073741824,
  });
} catch {
  rejectedPolicy = true;
}
if (!rejectedPolicy)
  throw new Error("Local SQLite built Reporter policy ceiling drifted.");

const builtLifecycleFingerprint = `sha256-${"a".repeat(64)}`;
const builtLeaseRecord = testing.parseLocalSqliteLeaseRecord({
  leaseId: "1".repeat(32),
  lifecycleFingerprint: builtLifecycleFingerprint,
  lifecycleGeneration: 1,
  parent: { pid: 101, startIdentity: "2".repeat(32) },
  child: null,
});
const builtFenceRecord = testing.parseLocalSqliteFenceRecord({
  transactionId: "3".repeat(32),
  lifecycleFingerprint: builtLifecycleFingerprint,
  lifecycleGeneration: 1,
  purpose: "lifecycle",
});
const builtLeaseBytes = testing.encodeLocalSqliteLeaseRecord(builtLeaseRecord);
const builtFenceBytes = testing.encodeLocalSqliteFenceRecord(builtFenceRecord);
if (
  builtLeaseBytes?.length !== 256 ||
  builtFenceBytes?.length !== 256 ||
  testing.decodeLocalSqliteLeaseRecord(builtLeaseBytes)?.leaseId !==
    builtLeaseRecord?.leaseId ||
  testing.decodeLocalSqliteFenceRecord(builtFenceBytes)?.transactionId !==
    builtFenceRecord?.transactionId ||
  testing.LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS.maximumLeases !== 64
)
  throw new Error("Local SQLite built lifecycle record grammar drifted.");

const lifecycleArtifacts = new Map();
let lifecycleIdentity = 0;
const nextLifecycleIdentity = () => `dev1:ino${(lifecycleIdentity += 1)}`;
const createLifecycleArtifact = (filename, content) => {
  if (lifecycleArtifacts.has(filename)) return { state: "exists" };
  const physicalIdentity = nextLifecycleIdentity();
  lifecycleArtifacts.set(filename, { content, physicalIdentity });
  return { state: "created", physicalIdentity };
};
const lifecyclePort = Object.freeze({
  classifyOwner: () => ({ state: "live" }),
  createFenceDurably: ({ filename, content }) =>
    createLifecycleArtifact(filename, content),
  createLeaseDurably: ({ filename, content }) =>
    createLifecycleArtifact(filename, content),
  createLeaseCleanupClaim: ({
    cleanupClaimName,
    leaseName,
    leasePhysicalIdentity,
  }) => {
    const lease = lifecycleArtifacts.get(leaseName);
    if (
      lease === undefined ||
      lease.physicalIdentity !== leasePhysicalIdentity ||
      lifecycleArtifacts.has(cleanupClaimName)
    )
      return { state: "mismatch" };
    lifecycleArtifacts.set(cleanupClaimName, lease);
    return { state: "created", physicalIdentity: lease.physicalIdentity };
  },
  listLifecycle: () => ({
    entries: [...lifecycleArtifacts.entries()].map(([name, artifact]) => ({
      name,
      bytes: artifact.content.length,
      physicalIdentity: artifact.physicalIdentity,
    })),
  }),
  readArtifact: ({ filename }) => {
    const artifact = lifecycleArtifacts.get(filename);
    return artifact === undefined
      ? { state: "absent" }
      : { state: "present", ...artifact };
  },
  removeArtifactIfIdentity: ({ filename, physicalIdentity }) => {
    const artifact = lifecycleArtifacts.get(filename);
    if (artifact?.physicalIdentity !== physicalIdentity)
      return { state: "mismatch" };
    lifecycleArtifacts.delete(filename);
    return { state: "removed" };
  },
  replaceLeaseDurably: () => ({ state: "mismatch" }),
});
const builtShared = await testing.acquireLocalSqliteSharedLease(lifecyclePort, {
  leaseId: builtLeaseRecord.leaseId,
  lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
  lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
  parent: builtLeaseRecord.parent,
});
if (!builtShared.ok)
  throw new Error("Local SQLite built shared lifecycle gate drifted.");
const builtRelease = await testing.releaseLocalSqliteSharedLease(
  lifecyclePort,
  builtShared.value,
);
if (!builtRelease.ok || lifecycleArtifacts.size !== 0)
  throw new Error("Local SQLite built shared release drifted.");

for (const [name, content] of [
  ["intent-v1.json", "intent"],
  [`lease-cleanup-${builtLeaseRecord.leaseId}.json`, builtLeaseBytes],
]) {
  lifecycleArtifacts.set(name, {
    content,
    physicalIdentity: nextLifecycleIdentity(),
  });
  const blockedShared = await testing.acquireLocalSqliteSharedLease(
    lifecyclePort,
    {
      leaseId: builtLeaseRecord.leaseId,
      lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
      lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
      parent: builtLeaseRecord.parent,
    },
  );
  if (blockedShared.ok || blockedShared.state !== "reconciliation-required")
    throw new Error("Local SQLite built open-artifact fence drifted.");
  lifecycleArtifacts.clear();
}

const racedBlockerPort = Object.freeze({
  ...lifecyclePort,
  createLeaseDurably: ({ filename, content }) => {
    const created = createLifecycleArtifact(filename, content);
    lifecycleArtifacts.set("intent-v1.json", {
      content: "intent",
      physicalIdentity: "dev1:racing-intent",
    });
    return created;
  },
});
const racedBlockerShared = await testing.acquireLocalSqliteSharedLease(
  racedBlockerPort,
  {
    leaseId: builtLeaseRecord.leaseId,
    lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
    lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
    parent: builtLeaseRecord.parent,
  },
);
if (
  racedBlockerShared.ok ||
  racedBlockerShared.state !== "reconciliation-required" ||
  lifecycleArtifacts.has(`lease-${builtLeaseRecord.leaseId}.json`)
)
  throw new Error("Local SQLite built final-inventory fence drifted.");
lifecycleArtifacts.clear();

lifecycleArtifacts.set(`lease-${builtLeaseRecord.leaseId}.json`, {
  content: "malformed".padEnd(256, " "),
  physicalIdentity: nextLifecycleIdentity(),
});
const malformedLeaseInspection =
  await testing.inspectLocalSqliteLifecycleInventory(lifecyclePort);
if (
  malformedLeaseInspection.ok ||
  malformedLeaseInspection.state !== "reconciliation-required"
)
  throw new Error("Local SQLite built lease inspection drifted.");
lifecycleArtifacts.clear();

const amendShared = await testing.acquireLocalSqliteSharedLease(lifecyclePort, {
  leaseId: builtLeaseRecord.leaseId,
  lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
  lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
  parent: builtLeaseRecord.parent,
});
if (!amendShared.ok)
  throw new Error("Local SQLite built amend fixture failed.");
const amendRacePort = Object.freeze({
  ...lifecyclePort,
  readArtifact: ({ filename }) => {
    if (filename === "exclusive-fence-v1")
      lifecycleArtifacts.set(filename, {
        content: builtFenceBytes,
        physicalIdentity: "dev1:racing-fence",
      });
    return lifecyclePort.readArtifact({ filename });
  },
  replaceLeaseDurably: ({ filename, physicalIdentity, content }) => {
    const artifact = lifecycleArtifacts.get(filename);
    if (artifact?.physicalIdentity !== physicalIdentity)
      return { state: "mismatch" };
    const replacementIdentity = nextLifecycleIdentity();
    lifecycleArtifacts.set(filename, {
      content,
      physicalIdentity: replacementIdentity,
    });
    return { state: "replaced", physicalIdentity: replacementIdentity };
  },
});
const racedAmend = await testing.amendLocalSqliteLeaseWithChild(
  amendRacePort,
  amendShared.value,
  { nonce: "4".repeat(32), pid: 202, startIdentity: "5".repeat(32) },
);
if (
  racedAmend.ok ||
  racedAmend.state !== "busy" ||
  lifecycleArtifacts.has(amendShared.value.filename) ||
  !lifecycleArtifacts.has("exclusive-fence-v1")
)
  throw new Error("Local SQLite built child-amend fence race drifted.");
lifecycleArtifacts.clear();

lifecycleArtifacts.set("exclusive-fence-v1", {
  content: "malformed".padEnd(256, " "),
  physicalIdentity: nextLifecycleIdentity(),
});
const malformedSharedFence = await testing.acquireLocalSqliteSharedLease(
  lifecyclePort,
  {
    leaseId: builtLeaseRecord.leaseId,
    lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
    lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
    parent: builtLeaseRecord.parent,
  },
);
const malformedExclusiveFence = await testing.acquireLocalSqliteExclusiveFence(
  lifecyclePort,
  builtFenceRecord,
);
if (
  malformedSharedFence.ok ||
  malformedSharedFence.state !== "reconciliation-required" ||
  malformedExclusiveFence.ok ||
  malformedExclusiveFence.state !== "reconciliation-required"
)
  throw new Error("Local SQLite built malformed-fence handling drifted.");
lifecycleArtifacts.clear();

const deadLifecyclePort = Object.freeze({
  ...lifecyclePort,
  classifyOwner: () => ({ state: "dead" }),
});
const lifecycleMismatchShared = await testing.acquireLocalSqliteSharedLease(
  deadLifecyclePort,
  {
    leaseId: builtLeaseRecord.leaseId,
    lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
    lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
    parent: builtLeaseRecord.parent,
  },
);
if (!lifecycleMismatchShared.ok)
  throw new Error("Local SQLite built mismatch fixture failed.");
const lifecycleMismatchFence = await testing.acquireLocalSqliteExclusiveFence(
  deadLifecyclePort,
  {
    ...builtFenceRecord,
    lifecycleFingerprint: `sha256-${"b".repeat(64)}`,
    purpose: "recovery",
  },
);
if (
  lifecycleMismatchFence.ok ||
  lifecycleMismatchFence.state !== "reconciliation-required"
)
  throw new Error("Local SQLite built lifecycle-identity handling drifted.");
await testing.releaseLocalSqliteSharedLease(
  deadLifecyclePort,
  lifecycleMismatchShared.value,
);

const claimShared = await testing.acquireLocalSqliteSharedLease(
  deadLifecyclePort,
  {
    leaseId: builtLeaseRecord.leaseId,
    lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
    lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
    parent: builtLeaseRecord.parent,
  },
);
if (!claimShared.ok)
  throw new Error("Local SQLite built claim fixture failed.");
const claimFence = await testing.acquireLocalSqliteExclusiveFence(
  deadLifecyclePort,
  { ...builtFenceRecord, purpose: "recovery" },
);
if (!claimFence.ok)
  throw new Error("Local SQLite built claim fence fixture failed.");
const claimFilename = `lease-cleanup-${builtLeaseRecord.leaseId}.json`;
const claimCrashPort = Object.freeze({
  ...deadLifecyclePort,
  createLeaseCleanupClaim: ({ leaseName }) => {
    const lease = lifecycleArtifacts.get(leaseName);
    if (lease === undefined) return { state: "mismatch" };
    lifecycleArtifacts.set(claimFilename, lease);
    return undefined;
  },
});
const claimCrash = await testing.recoverDeadLocalSqliteLease(
  claimCrashPort,
  claimFence.value,
  claimShared.value.filename,
);
const claimResume = await testing.recoverDeadLocalSqliteLease(
  Object.freeze({
    ...deadLifecyclePort,
    createLeaseCleanupClaim: () => ({ state: "exists" }),
  }),
  claimFence.value,
  claimShared.value.filename,
);
if (
  claimCrash.ok ||
  claimCrash.state !== "reconciliation-required" ||
  !claimResume.ok ||
  lifecycleArtifacts.has(claimFilename) ||
  lifecycleArtifacts.has(claimShared.value.filename)
)
  throw new Error("Local SQLite built lease-cleanup resume drifted.");
await testing.releaseLocalSqliteExclusiveFence(
  deadLifecyclePort,
  claimFence.value,
);

let lifecycleCoercions = 0;
const hostileLifecycleResult = await testing.acquireLocalSqliteSharedLease(
  Object.freeze({
    ...lifecyclePort,
    readArtifact: () => ({
      state: {
        toString() {
          lifecycleCoercions += 1;
          return "absent";
        },
      },
    }),
  }),
  {
    leaseId: builtLeaseRecord.leaseId,
    lifecycleFingerprint: builtLeaseRecord.lifecycleFingerprint,
    lifecycleGeneration: builtLeaseRecord.lifecycleGeneration,
    parent: builtLeaseRecord.parent,
  },
);
if (
  hostileLifecycleResult.ok ||
  hostileLifecycleResult.state !== "reconciliation-required" ||
  lifecycleCoercions !== 0
)
  throw new Error("Local SQLite built lifecycle containment drifted.");

const builtClaimRoot = mkdtempSync(join(tmpdir(), "agentscope-built-claim-"));
chmodSync(builtClaimRoot, 0o700);
const builtClaimDirectory = openOwnedDirectory(builtClaimRoot, true);
try {
  writeFileSync(join(builtClaimRoot, "remove"), "owned", { mode: 0o600 });
  const removeIdentity = statOwnedFile(
    builtClaimDirectory,
    "remove",
  ).physicalIdentity;
  if (
    removeOwnedFile(builtClaimDirectory, "remove", removeIdentity, () =>
      writeFileSync(join(builtClaimRoot, "remove"), "replacement", {
        mode: 0o600,
      }),
    ) !== "mismatch" ||
    readFileSync(join(builtClaimRoot, "remove"), "utf8") !== "replacement"
  )
    throw new Error("Local SQLite built private removal claim drifted.");
  writeFileSync(join(builtClaimRoot, "source"), "owned", { mode: 0o600 });
  const sourceIdentity = statOwnedFile(
    builtClaimDirectory,
    "source",
  ).physicalIdentity;
  try {
    renameOwnedFile(
      builtClaimDirectory,
      "source",
      builtClaimDirectory,
      "destination",
      sourceIdentity,
      () =>
        writeFileSync(join(builtClaimRoot, "source"), "replacement", {
          mode: 0o600,
        }),
    );
    throw new Error("Local SQLite built private rename race was accepted.");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "destination.local-sqlite.filesystem.raced"
    )
      throw error;
  }
  if (
    readFileSync(join(builtClaimRoot, "source"), "utf8") !== "replacement" ||
    readFileSync(join(builtClaimRoot, "destination"), "utf8") !== "owned" ||
    boundedOwnedNames(builtClaimDirectory, 16).some((name) =>
      name.startsWith(".agentscope-private-"),
    )
  )
    throw new Error("Local SQLite built private claim cleanup drifted.");
} finally {
  builtClaimDirectory.close();
  rmSync(builtClaimRoot, { recursive: true, force: true });
}
