import { describe, expect, it } from "vitest";

import * as root from "./index.js";
import * as reporter from "./reporter/index.js";
import * as retriever from "./retriever/index.js";
import * as testing from "./testing.js";

describe("Local SQLite package boundaries", () => {
  it("exports only the production identity and native admission surface", () => {
    expect(Object.keys(root).sort()).toEqual(
      [
        "LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST",
        "inspectLocalSqliteNativeSupport",
        "LOCAL_SQLITE_DESTINATION_TYPE",
        "LOCAL_SQLITE_LIFECYCLE_SETTINGS_VERSION",
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
      ]),
    );
    expect(root.LOCAL_SQLITE_DESTINATION_TYPE).toBe(
      "@agentscope/destination-local-sqlite",
    );
    expect(
      root.inspectLocalSqliteNativeSupport({
        nodeAbi: 127,
        nodeMajor: 22,
        platform: "darwin",
        osVersion: "15.0",
        architecture: "arm64",
        libcFamily: null,
        libcVersion: null,
        credentialBackend: "keychain",
        filesystemProfile: "local-apfs",
      }),
    ).toEqual({
      state: "unavailable",
      code: "destination.local-sqlite.native-unavailable",
    });
    const hostileRuntime = new Proxy(
      {} as Parameters<typeof root.inspectLocalSqliteNativeSupport>[0],
      {
        getPrototypeOf: () => {
          throw new Error("CANARY");
        },
      },
    );
    expect(root.inspectLocalSqliteNativeSupport(hostileRuntime).state).toBe(
      "unavailable",
    );
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
    });
    expect(grammar.supportManifest).toEqual({
      maximumSnapshotBytes: 0,
      nativeAdmission: "no-admitted-native-tuples",
      schemaVersion: 1,
    });
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
    ]);
  });
});
