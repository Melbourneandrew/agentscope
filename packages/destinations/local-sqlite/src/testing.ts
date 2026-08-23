export {
  compileReleaseTarArchiveForTesting,
  type ReleaseArchiveEntry,
  type ReleaseArchiveManifest,
} from "./release-archive.js";
export {
  compileLocalSqlitePhysicalNamespaceEvidence,
  LocalSqliteNamespaceError,
  planLocalSqliteNamespace,
  type LocalSqliteNamespacePlan,
  type LocalSqliteNamespacePlanInput,
  type LocalSqliteAbsenceBoundaryEvidence,
  type LocalSqliteExistingAncestorEvidence,
  type LocalSqlitePhysicalNamespaceEvidence,
  type LocalSqlitePhysicalNamespaceEvidenceInput,
  type LocalSqlitePlannedAbsentAncestor,
} from "./lifecycle/namespace.js";
export {
  acquireLocalSqliteExclusiveFence,
  acquireLocalSqliteSharedLease,
  amendLocalSqliteLeaseWithChild,
  decodeLocalSqliteFenceRecord,
  decodeLocalSqliteLeaseRecord,
  encodeLocalSqliteFenceRecord,
  encodeLocalSqliteLeaseRecord,
  inspectLocalSqliteLifecycleInventory,
  LOCAL_SQLITE_LIFECYCLE_GATE_CONSTANTS,
  parseLocalSqliteFenceRecord,
  parseLocalSqliteLeaseRecord,
  recoverDeadLocalSqliteLease,
  releaseLocalSqliteExclusiveFence,
  releaseLocalSqliteSharedLease,
  type LocalSqliteExclusiveFenceAuthority,
  type LocalSqliteFenceRecord,
  type LocalSqliteLifecycleGateFailure,
  type LocalSqliteLifecycleGatePort,
  type LocalSqliteLeaseRecord,
  type LocalSqliteSharedLeaseAuthority,
} from "./lifecycle/fence.js";
export {
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR,
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES,
  createLocalSqliteLifecycleArtifactGrammarForTesting,
  localSqliteLifecycleArtifactGrammarFingerprintForTesting,
} from "./lifecycle/capability.js";
export {
  inspectLocalSqliteNativeSupportManifestForTesting,
  type LocalSqliteNativeSupportManifest,
} from "./native-support.js";
export {
  canonicalizeLocalSqliteEvidenceForTesting,
  compileLocalSqliteMigrationInventoryForTesting,
  compileLocalSqliteMigrationSqlForTesting,
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_MIGRATIONS,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
  runLocalSqliteMigrations,
  runLocalSqliteMigrationsWithInventoryForTesting,
  type LocalSqliteImmutableRowEvidence,
  type LocalSqliteMigrationDatabase,
  type LocalSqliteMigrationLedgerEntry,
  type LocalSqliteMigrationResource,
  type LocalSqliteMigrationResult,
  type LocalSqliteProjectionEvidence,
} from "./migrations.js";
export {
  createLocalSqliteDatabaseFailure as createLocalSqliteDatabaseFailureForTesting,
  createLocalSqliteReporter as createLocalSqliteReporterForTesting,
  LOCAL_SQLITE_REPORTER_POLICY_MANIFEST,
  LOCAL_SQLITE_REPORTER_POLICY_VERSION,
  prepareLocalSqliteTrace as prepareLocalSqliteTraceForTesting,
  type LocalSqliteCapacityEvidence,
  type LocalSqliteDatabaseFailureReason,
  type LocalSqliteDimensionKind,
  type LocalSqlitePreparedDimension,
  type LocalSqlitePreparedTrace,
  type LocalSqliteReporterDatabase,
  type LocalSqliteReporterPolicy,
  type LocalSqliteStoredTraceEvidence,
} from "./reporter/transaction.js";
export {
  createLocalSqliteLifecycleHandlerForTesting,
  decodeLocalSqliteLifecycleIntent,
  decodeLocalSqliteOwnershipReceipt,
  LocalSqliteLifecycleError,
  encodeLocalSqliteLifecycleIntent,
  encodeLocalSqliteOwnershipReceipt,
  type LocalSqliteLifecycleIntent,
  type LocalSqliteLifecyclePort,
  type LocalSqliteOwnershipReceipt,
} from "./lifecycle/configuration.js";
export {
  applyLocalSqliteMaintenance,
  decodeLocalSqliteBackupReceipt,
  decodeLocalSqliteMaintenanceIntent,
  encodeLocalSqliteBackupReceipt,
  encodeLocalSqliteMaintenanceIntent,
  inspectLocalSqliteDoctor,
  LocalSqliteMaintenanceError,
  recoverLocalSqliteMaintenance,
  type LocalSqliteBackupInventoryEvidence,
  type LocalSqliteBackupReceipt,
  type LocalSqliteMaintenanceIntent,
  type LocalSqliteMaintenancePort,
  type LocalSqliteMaintenanceRecoveryPhase,
  type LocalSqliteVerifiedSnapshotEvidence,
} from "./lifecycle/maintenance.js";
export {
  compileLocalSqliteGetPlan,
  compileLocalSqliteSearchPlan,
  createLocalSqliteRetriever,
  LOCAL_SQLITE_RETRIEVER_PLAN_VERSION,
  type LocalSqliteGetPlan,
  type LocalSqliteGetEvidence,
  type LocalSqliteRetrievalRow,
  type LocalSqliteRetrieverDatabase,
  type LocalSqliteSearchEvidence,
  type LocalSqliteSearchPlan,
} from "./retriever/index.js";
export {
  bindLocalSqliteProductionRuntimeForTesting,
  type LocalSqliteProductionRuntime,
} from "./production/runtime.js";
export { createLocalSqliteDestinationDescriptorForTesting } from "./production/descriptor.js";
export {
  createLocalSqliteProductionLifecyclePort,
  type LocalSqliteProductionHome,
  type OwnedSqliteOpener,
} from "./production/lifecycle-port.js";
export { createLocalSqliteProductionMaintenancePort } from "./production/maintenance-port.js";
export {
  createLocalSqliteFilesystemGatePort,
  currentProcessStartIdentity,
} from "./production/filesystem-port.js";
export {
  createOwnedMigrationDatabase,
  createOwnedReporterDatabase,
  createOwnedRetrieverDatabase,
  initializeOwnedSqliteConnection,
  type LocalSqliteExecutionPolicy,
  type OwnedSqliteConnection,
  type OwnedSqliteStatement,
} from "./production/sqlite-port.js";
