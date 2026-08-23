import { createHash } from "node:crypto";

import {
  defineLocalResourceLifecycleDeclaration,
  type LocalResourceLifecycleDeclaration,
} from "@agentscope/destinations-core";

export const LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION = 1 as const;
export const LOCAL_SQLITE_DESTINATION_TYPE =
  "@agentscope/destination-local-sqlite" as const;
export const LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES = 16 * 1_024 * 1_024 * 1_024;
export const LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES =
  8 * 1_024 * 1_024 * 1_024;

const artifact = (
  kind: string,
  relativePathGrammar: string,
  maximumCount: number,
) => Object.freeze({ kind, maximumCount, relativePathGrammar });

export const createLocalSqliteLifecycleArtifactGrammarForTesting = (
  maximumSnapshotBytes: number,
) =>
  Object.freeze({
    artifacts: Object.freeze([
      artifact("active-database", "traces.sqlite", 1),
      artifact("journal", "traces.sqlite-journal", 1),
      artifact("write-ahead-log", "traces.sqlite-wal", 1),
      artifact("shared-memory", "traces.sqlite-shm", 1),
      artifact(
        "configure-database-candidate",
        "configure-<transaction-id>.sqlite",
        1,
      ),
      artifact(
        "restore-database-candidate",
        "restore-<transaction-id>.sqlite",
        1,
      ),
      artifact("exclusive-fence", "lifecycle/exclusive-fence-v1", 1),
      artifact("shared-lease", "lifecycle/lease-<owner-identity>.json", 64),
      artifact("lifecycle-intent", "lifecycle/intent-v1.json", 1),
      artifact("operation-phase", "lifecycle/operation-phase-v1.json", 1),
      artifact(
        "recovery-claim",
        "lifecycle/recovery-claim-<transaction-id>",
        1,
      ),
      artifact("ownership-receipt", "lifecycle/ownership-receipt-v1.json", 1),
      artifact(
        "rollback-preimage",
        "rollback-preimage-<transaction-id>.sqlite",
        1,
      ),
      artifact("backup", "backups/backup-<backup-id>.sqlite", 8),
      artifact("backup-candidate", "backups/candidate-<backup-id>.sqlite", 1),
      artifact("backup-receipt", "backups/receipt-<backup-id>.json", 8),
    ]),
    inspectionLimits: Object.freeze({
      leaseRecordBytes: 256,
      maximumBackupDirectoryEntries: 32,
      maximumDirectoryEntries: 128,
      maximumInspectionBytes: 65_536,
      maximumMetadataAggregateBytes: 65_536,
      maximumPublishedBackups: 8,
      maximumPublishedSnapshotBytes:
        "checked-multiply(maximumPublishedBackups,supportManifest.maximumSnapshotBytes)",
      maximumSharedLeases: 64,
      maximumTransientDatabaseCandidates: 1,
      maximumTransientRollbackPreimages: 1,
      namespaceByteCeiling:
        "checked-add(publishedSnapshotBytes,metadataAggregateBytes,transientCandidateBytes,transientPreimageBytes)",
      sizeArithmetic: "exact-nonnegative-filesystem-integer-checked",
      sparseOrHugeEvidence: "reconciliation-required",
    }),
    identifiers: Object.freeze({
      backupId: "nonzero-128-bit-lowercase-hex-32",
      ownerIdentity: "process-start-identity-v1",
      transactionId: "nonzero-128-bit-lowercase-hex-32",
    }),
    namespace: Object.freeze({
      backupDirectory: "backups",
      destinationDirectory: "destinations/local-sqlite",
      digestPreimage: "json-v1:{connectionId,destinationType}",
      lifecycleDirectory: "lifecycle",
      namespaceLeaf: "sha256-lowercase-hex-64",
    }),
    schemaVersion: 1,
    supportManifest: Object.freeze({
      maximumSnapshotBytes,
      nativeAdmission:
        maximumSnapshotBytes === LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES
          ? "proposed-unpublished-execution-eligible"
          : maximumSnapshotBytes === 0
            ? "no-admitted-native-tuples"
            : "synthetic-testing-only",
      schemaVersion: 1,
    }),
    transientRoleGroups: Object.freeze([
      Object.freeze({
        kinds: Object.freeze([
          "backup-candidate",
          "configure-database-candidate",
          "restore-database-candidate",
        ]),
        maximumBytesPerArtifact: "supportManifest.maximumSnapshotBytes",
        maximumCountAcrossKinds: 1,
        name: "database-candidate",
      }),
      Object.freeze({
        kinds: Object.freeze(["rollback-preimage"]),
        maximumBytesPerArtifact: "supportManifest.maximumSnapshotBytes",
        maximumCountAcrossKinds: 1,
        name: "rollback-preimage",
      }),
    ]),
  });

export const LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR =
  createLocalSqliteLifecycleArtifactGrammarForTesting(
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  );

export const localSqliteLifecycleArtifactGrammarFingerprintForTesting = (
  maximumSnapshotBytes: number,
): `sha256-${string}` =>
  `sha256-${createHash("sha256")
    .update(
      JSON.stringify(
        createLocalSqliteLifecycleArtifactGrammarForTesting(
          maximumSnapshotBytes,
        ),
      ),
    )
    .digest("hex")}`;

export const LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT =
  localSqliteLifecycleArtifactGrammarFingerprintForTesting(
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  );

export const localSqliteLifecycleDeclaration: LocalResourceLifecycleDeclaration =
  defineLocalResourceLifecycleDeclaration({
    artifactGrammarFingerprint:
      LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
    artifactGrammarVersion: 1,
    artifactKinds: LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR.artifacts.map(
      ({ kind }) => kind,
    ),
    capabilityVersion: 1,
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    operations: [
      "backup",
      "configure",
      "delete",
      "doctor",
      "recover",
      "restore",
      "unconfigure",
    ],
    receiptReasons: [
      "destination-busy",
      "destination-capacity",
      "destination-corrupt",
      "destination-full",
      "destination-migrating",
      "destination-retention",
    ],
    recoveryHandlerId: "@agentscope/destination-local-sqlite/lifecycle-v1",
    settingKeys: [
      "maximumAgeNanoseconds",
      "maximumPayloadBytes",
      "maximumTraceCount",
    ],
    settingsVersion: LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION,
  });
