import { describe, expect, it } from "vitest";
import { bindLocalResourceHomeAuthorityForTesting } from "@agentscope/destinations-core/testing";

import * as root from "./index.js";
import * as reporter from "./reporter/index.js";
import * as retriever from "./retriever/index.js";
import * as testing from "./testing.js";

describe("Local SQLite package boundaries", () => {
  it("exports only the production identity and native admission surface", () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST",
        "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST",
        "LOCAL_SQLITE_DESTINATION_TYPE",
        "LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION",
        "createLocalSqliteLifecycleHandler",
        "initializeLocalSqliteProductionComposition",
        "localSqliteDestinationDescriptor",
        "localSqliteDestinationPackageId",
        "localSqliteLifecycleDeclaration",
        "localSqliteReporterPackageId",
        "localSqliteRetrieverPackageId",
      ].sort(),
    );
    expect(reporter.localSqliteReporterPackageId).toBe(
      "@agentscope/destination-local-sqlite/reporter",
    );
    expect(retriever.localSqliteRetrieverPackageId).toBe(
      "@agentscope/destination-local-sqlite/retriever",
    );
    expect(root.localSqliteLifecycleDeclaration).toMatchObject({
      capabilityVersion: 1,
      destinationType: "@agentscope/destination-local-sqlite",
      settingsVersion: root.LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION,
    });
    expect(
      root.localSqliteLifecycleDeclaration.artifactGrammarFingerprint,
    ).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(root.localSqliteLifecycleDeclaration.artifactKinds).toEqual(
      expect.arrayContaining([
        "configure-database-candidate",
        "restore-database-candidate",
        "namespace-removal-claim",
      ]),
    );
    expect(root.LOCAL_SQLITE_DESTINATION_TYPE).toBe(
      "@agentscope/destination-local-sqlite",
    );
  });

  it("binds one branded home without exposing raw runtime authority", () => {
    const home = bindLocalResourceHomeAuthorityForTesting({
      root: "/owned/agentscope-home",
      platform: process.platform,
    });
    const composition = root.initializeLocalSqliteProductionComposition(home);
    expect(Object.keys(composition).sort()).toEqual([
      "createLifecycleHandler",
      "destinationDescriptor",
    ]);
    expect(composition.destinationDescriptor).toBe(
      root.localSqliteDestinationDescriptor,
    );
    expect(root.initializeLocalSqliteProductionComposition(home)).toBe(
      composition,
    );
    expect(() =>
      root.initializeLocalSqliteProductionComposition(
        bindLocalResourceHomeAuthorityForTesting({
          root: "/different/agentscope-home",
          platform: process.platform,
        }),
      ),
    ).toThrow("destination.local-sqlite.native-unavailable");
    expect(Object.keys(composition)).not.toContain("opener");
    expect(Object.keys(composition)).not.toContain("withSharedDatabase");
  });
});

describe("Local SQLite lifecycle artifact grammar", () => {
  it("binds the exact lifecycle artifact and transient-role grammar", () => {
    const grammar = testing.LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR;
    const artifacts = new Map(
      grammar.artifacts.map((artifact) => [artifact.kind, artifact]),
    );
    expect(artifacts.get("active-database")?.relativePathGrammar).toBe(
      "traces.sqlite",
    );
    for (const kind of [
      "configure-database-candidate",
      "restore-database-candidate",
      "rollback-preimage",
    ]) {
      expect(artifacts.get(kind)?.relativePathGrammar).not.toContain("/");
    }
    expect(grammar.inspectionLimits).toEqual({
      leaseRecordBytes: 256,
      maximumBackupDirectoryEntries: 32,
      maximumDirectoryEntries: 192,
      maximumInspectionBytes: 98_304,
      maximumMetadataAggregateBytes: 65_536,
      maximumPublishedBackups: 8,
      maximumPublishedSnapshotBytes:
        "checked-multiply(maximumPublishedBackups,supportManifest.maximumSnapshotBytes)",
      maximumNamespaceRemovalClaims: 1,
      maximumRecoveryFenceRecordBytes: 32_768,
      maximumSharedLeaseCleanupClaims: 64,
      maximumSharedLeases: 64,
      maximumTransientDatabaseCandidates: 1,
      maximumTransientRollbackPreimages: 1,
      namespaceByteCeiling:
        "checked-add(publishedSnapshotBytes,metadataAggregateBytes,transientCandidateBytes,transientPreimageBytes,namespaceRemovalClaimBytes)",
      sizeArithmetic: "exact-nonnegative-filesystem-integer-checked",
      sparseOrHugeEvidence: "reconciliation-required",
    });
    expect(grammar.recoveryFence).toEqual({
      lockContract:
        "package-owned-nonblocking-descriptor-advisory-exclusive-process-death-release-v1",
      recordContract:
        "immutable-owner-plus-canonical-dead-lease-vector-and-monotonic-suffix-v1",
    });
    expect(grammar.supportManifest).toEqual({
      maximumSnapshotBytes: 16 * 1_024 * 1_024 * 1_024,
      nativeAdmission: "proposed-unpublished-execution-eligible",
      schemaVersion: 1,
    });
    expect(
      testing.createLocalSqliteLifecycleArtifactGrammarForTesting(0)
        .supportManifest.nativeAdmission,
    ).toBe("no-admitted-native-tuples");
    expect(
      testing.createLocalSqliteLifecycleArtifactGrammarForTesting(1)
        .supportManifest.nativeAdmission,
    ).toBe("synthetic-testing-only");
    expect(grammar.transientRoleGroups).toEqual([
      {
        kinds: [
          "backup-candidate",
          "configure-database-candidate",
          "restore-database-candidate",
        ],
        maximumBytesPerArtifact: "supportManifest.maximumSnapshotBytes",
        maximumCountAcrossKinds: 1,
        name: "database-candidate",
      },
      {
        kinds: ["rollback-preimage"],
        maximumBytesPerArtifact: "supportManifest.maximumSnapshotBytes",
        maximumCountAcrossKinds: 1,
        name: "rollback-preimage",
      },
      {
        kinds: ["namespace-removal-claim"],
        maximumBytesPerArtifact: "mapped-public-artifact-maximum",
        maximumCountAcrossKinds: 1,
        name: "namespace-removal-claim",
      },
    ]);
  });
});
