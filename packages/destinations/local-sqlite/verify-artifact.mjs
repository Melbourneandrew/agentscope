import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { standardsManifest } from "@agentscope/protocol";

import * as root from "./dist/index.js";
import * as reporter from "./dist/reporter/index.js";
import { executePreparedLocalSqliteTransaction } from "./dist/reporter/transaction.js";
import * as retriever from "./dist/retriever/index.js";
import * as testing from "./dist/testing.js";

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
const expectedDist = [
  ...sourceFiles.flatMap((file) => [
    file.replace(/\.ts$/u, ".d.ts"),
    file.replace(/\.ts$/u, ".js"),
  ]),
  ...migrationFiles,
].sort();
const actualDist = regularFiles(distRoot);
if (JSON.stringify(actualDist) !== JSON.stringify(expectedDist))
  throw new Error(
    "Local SQLite dist is not an exact production-source artifact.",
  );
if (actualDist.some((file) => file.includes(".test.")))
  throw new Error("Local SQLite dist contains compiled tests.");

const expectedRoot = [
  "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST",
  "inspectLocalSqliteNativeSupport",
  "LOCAL_SQLITE_DESTINATION_TYPE",
  "LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION",
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
  JSON.stringify(Object.keys(retriever)) !==
  JSON.stringify(["localSqliteRetrieverPackageId"])
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
      "inspectLocalSqliteNativeSupportManifestForTesting",
      "compileLocalSqlitePhysicalNamespaceEvidence",
      "LocalSqliteNamespaceError",
      "LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR",
      "LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT",
      "LOCAL_SQLITE_DESTINATION_FORMAT",
      "LOCAL_SQLITE_MIGRATION_MANIFEST_ID",
      "LOCAL_SQLITE_MIGRATIONS",
      "LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID",
      "LOCAL_SQLITE_REPORTER_POLICY_MANIFEST",
      "LOCAL_SQLITE_REPORTER_POLICY_VERSION",
      "planLocalSqliteNamespace",
      "createLocalSqliteDatabaseFailureForTesting",
      "createLocalSqliteReporterForTesting",
      "decodeLocalSqliteFenceRecord",
      "decodeLocalSqliteLeaseRecord",
      "encodeLocalSqliteFenceRecord",
      "encodeLocalSqliteLeaseRecord",
      "inspectLocalSqliteLifecycleInventory",
      "prepareLocalSqliteTraceForTesting",
      "LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS",
      "parseLocalSqliteFenceRecord",
      "parseLocalSqliteLeaseRecord",
      "recoverDeadLocalSqliteLease",
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
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.nativeBinaries.length !== 0 ||
  root.LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.supportedPlatforms.length !== 0
)
  throw new Error("Local SQLite artifact claimed an unproved native tuple.");
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
  )
)
  throw new Error("Local SQLite lifecycle artifact grammar drifted.");
const artifactsByKind = new Map(
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.artifacts.map((artifact) => [
    artifact.kind,
    artifact,
  ]),
);
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
    .maximumSnapshotBytes !== 0 ||
  testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.supportManifest
    .nativeAdmission !== "no-admitted-native-tuples"
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
const unavailable = root.inspectLocalSqliteNativeSupport(runtimeIdentity);
if (
  root.inspectLocalSqliteNativeSupport.length !== 1 ||
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
  testing.LOCAL_SQLITE_MIGRATIONS.length !== 1 ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.name !== "0001-initialize.sql" ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.sha256 !==
    "616f0f680cd8d86d36e3f880caf0925e6c0a16138d50e4af98e907bcfb855d24" ||
  testing.LOCAL_SQLITE_MIGRATIONS[0]?.protocolCompatibilityId !==
    standardsManifest.manifestId ||
  testing.compileLocalSqliteMigrationInventoryForTesting(
    testing.LOCAL_SQLITE_MIGRATIONS,
  )?.length !== 1 ||
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
  migrationState.statements.length !== 6 ||
  migrationState.ledger.length !== 1 ||
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
  createRecoveryClaim: () => ({ state: "mismatch" }),
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
  [`recovery-claim-${builtFenceRecord.transactionId}`, builtLeaseBytes],
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
const claimFilename = `recovery-claim-${builtFenceRecord.transactionId}`;
const claimCrashPort = Object.freeze({
  ...deadLifecyclePort,
  createRecoveryClaim: ({ leaseName }) => {
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
    createRecoveryClaim: () => ({ state: "exists" }),
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
  throw new Error("Local SQLite built recovery-claim resume drifted.");
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
