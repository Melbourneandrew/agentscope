import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT } from "../lifecycle/capability.js";
import type { LocalSqliteLifecycleIntent } from "../lifecycle/configuration.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import {
  createLocalSqliteProductionLifecyclePort,
  inspectLocalSqliteProductionPlan,
  type OwnedSqliteOpener,
} from "./lifecycle-port.js";

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const policy = Object.freeze({
  maximumAgeNanoseconds: "1",
  maximumPayloadBytes: 1,
  maximumTraceCount: 1,
  physicalCleanupTrigger: "next-authorized-mutation" as const,
});
const opener: OwnedSqliteOpener = Object.freeze({
  open: () => {
    throw new Error("native opener must not run");
  },
});

const directFixture = (root: string) => {
  const home = Object.freeze({ root, platform: process.platform });
  const inspected = inspectLocalSqliteProductionPlan(
    home,
    "local-ext4",
    connectionId,
    policy,
    true,
  );
  const capability = localSqliteDestinationDescriptor.localResourceLifecycle!;
  const intent = Object.freeze({
    recordVersion: 1,
    operation: "configure",
    transactionId: "1".repeat(32),
    destinationType: localSqliteDestinationDescriptor.destinationType,
    connectionId,
    connectionDigest: inspected.namespace.connectionDigest,
    owner: Object.freeze({
      processId: process.pid,
      processStartIdentity: `process-start-v1-${"3".repeat(64)}`,
    }),
    namespaceFingerprint: inspected.evidence.namespaceFingerprint,
    physicalEvidenceFingerprint: inspected.evidence.physicalEvidenceFingerprint,
    lifecycleFingerprint: capability.fingerprint,
    recoveryHandlerId: capability.recoveryHandlerId,
    artifactGrammarFingerprint:
      LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
    artifactGrammarVersion: 1,
    capabilityVersion: 1,
    destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
    migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
    protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    expectedConfigurationGeneration: 1,
    candidateConfigurationGeneration: 2,
    expectedConfigurationDigest: `sha256-${"4".repeat(64)}`,
    candidateConfigurationDigest: `sha256-${"5".repeat(64)}`,
    retainedReceiptDigest: null,
    retainedDatabaseFamilyPhysicalIdentity: null,
    retentionPolicy: policy,
  }) as LocalSqliteLifecycleIntent;
  const port = createLocalSqliteProductionLifecyclePort({
    home,
    filesystemProfile: "local-ext4",
    opener,
    allowPathFallbackForTesting: true,
  });
  const fence = Object.freeze({
    state: "exclusive" as const,
    filename: "exclusive-fence-v1",
    physicalIdentity: "dev:1:ino:1",
    record: Object.freeze({
      transactionId: intent.transactionId,
      lifecycleFingerprint: intent.lifecycleFingerprint,
      lifecycleGeneration: intent.capabilityVersion,
      purpose: "lifecycle" as const,
    }),
    deadLeaseNames: Object.freeze([]),
  });
  return Object.freeze({ home, inspected, intent, port, fence });
};

// The adversarial matrix is intentionally kept together so every production
// lifecycle port boundary shares one filesystem fixture and cleanup discipline.
// eslint-disable-next-line max-lines-per-function
describe("production Local SQLite lifecycle adversarial boundaries", () => {
  it("rejects invalid settings, abort, and case-fold namespace collision", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-lifecycle-negative-"));
    chmodSync(root, 0o700);
    try {
      const home = Object.freeze({ root, platform: process.platform });
      const port = createLocalSqliteProductionLifecyclePort({
        home,
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      });
      await expect(
        port.inspect({
          connectionId,
          settings: null,
          signal: new AbortController().signal,
        } as never),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await expect(
        port.inspect({
          connectionId,
          settings: {
            maximumAgeNanoseconds: 1,
            maximumPayloadBytes: "1",
            maximumTraceCount: "1",
          },
          signal: new AbortController().signal,
        } as never),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        port.inspect({
          connectionId,
          settings: {},
          signal: aborted.signal,
        } as never),
      ).rejects.toThrow("destination.local-sqlite.lifecycle-unavailable");

      const namespace = planLocalSqliteNamespace({
        agentscopeHome: root,
        connectionId,
        platform: process.platform === "win32" ? "win32" : "posix",
      });
      mkdirSync(namespace.destinationTypeDirectory, {
        recursive: true,
        mode: 0o700,
      });
      chmodSync(join(root, "destinations"), 0o700);
      chmodSync(namespace.destinationTypeDirectory, 0o700);
      const alias = namespace.connectionDigest.toUpperCase();
      expect(alias).not.toBe(namespace.connectionDigest);
      mkdirSync(join(namespace.destinationTypeDirectory, alias), {
        mode: 0o700,
      });
      const inspectCollision = () =>
        inspectLocalSqliteProductionPlan(
          home,
          "local-ext4",
          connectionId,
          policy,
          true,
        );
      if (process.platform === "darwin") expect(inspectCollision).not.toThrow();
      else
        expect(inspectCollision).toThrow(
          "destination.local-sqlite.lifecycle-reconciliation-required",
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps exact competing and malformed fences before lifecycle mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-lifecycle-fence-"));
    chmodSync(root, 0o700);
    try {
      const home = Object.freeze({ root, platform: process.platform });
      const inspected = inspectLocalSqliteProductionPlan(
        home,
        "local-ext4",
        connectionId,
        policy,
        true,
      );
      const capability =
        localSqliteDestinationDescriptor.localResourceLifecycle!;
      const intent = Object.freeze({
        recordVersion: 1,
        operation: "configure",
        transactionId: "1".repeat(32),
        destinationType: localSqliteDestinationDescriptor.destinationType,
        connectionId,
        connectionDigest: inspected.namespace.connectionDigest,
        owner: Object.freeze({
          processId: process.pid,
          processStartIdentity: `process-start-v1-${"3".repeat(64)}`,
        }),
        namespaceFingerprint: inspected.evidence.namespaceFingerprint,
        physicalEvidenceFingerprint:
          inspected.evidence.physicalEvidenceFingerprint,
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        artifactGrammarFingerprint:
          LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
        artifactGrammarVersion: 1,
        capabilityVersion: 1,
        destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
        migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
        protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
        expectedConfigurationGeneration: 1,
        candidateConfigurationGeneration: 2,
        expectedConfigurationDigest: `sha256-${"4".repeat(64)}`,
        candidateConfigurationDigest: `sha256-${"5".repeat(64)}`,
        retainedReceiptDigest: null,
        retainedDatabaseFamilyPhysicalIdentity: null,
        retentionPolicy: policy,
      }) as LocalSqliteLifecycleIntent;
      const port = createLocalSqliteProductionLifecyclePort({
        home,
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      });
      await port.publishIntent(intent, "{}\n", new AbortController().signal);
      const fence = await port.acquireExclusiveFence(
        intent,
        new AbortController().signal,
      );
      await expect(
        port.acquireExclusiveFence(intent, new AbortController().signal),
      ).rejects.toThrow("destination.local-sqlite.lifecycle-busy");
      await port.finalize(intent, fence, new AbortController().signal);

      writeFileSync(
        join(inspected.namespace.lifecycleDirectory, "exclusive-fence-v1"),
        "malformed",
        { mode: 0o600 },
      );
      await expect(
        port.acquireExclusiveFence(intent, new AbortController().signal),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // This single state-machine test preserves the exact ordering between durable
  // artifacts; splitting it would hide cross-step cleanup and authority reuse.
  // eslint-disable-next-line max-lines-per-function
  it("rejects malformed recovery inventories and exact state mismatches", async () => {
    for (const state of [
      "empty",
      "invalid-connection-name",
      "missing-lifecycle",
      "missing-intent",
      "malformed-intent",
      "inventory-race",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "agentscope-lifecycle-scan-"));
      chmodSync(root, 0o700);
      try {
        const home = Object.freeze({ root, platform: process.platform });
        const namespace = planLocalSqliteNamespace({
          agentscopeHome: root,
          connectionId,
          platform: process.platform === "win32" ? "win32" : "posix",
        });
        if (state !== "empty") {
          mkdirSync(namespace.destinationTypeDirectory, {
            recursive: true,
            mode: 0o700,
          });
          chmodSync(join(root, "destinations"), 0o700);
          chmodSync(namespace.destinationTypeDirectory, 0o700);
        }
        if (state === "invalid-connection-name")
          mkdirSync(join(namespace.destinationTypeDirectory, "invalid"), {
            mode: 0o700,
          });
        if (state === "missing-lifecycle" || state === "inventory-race")
          mkdirSync(namespace.connectionNamespace, { mode: 0o700 });
        if (state === "missing-intent" || state === "malformed-intent")
          mkdirSync(namespace.lifecycleDirectory, {
            recursive: true,
            mode: 0o700,
          });
        if (state === "malformed-intent")
          writeFileSync(
            join(namespace.lifecycleDirectory, "intent-v1.json"),
            "malformed",
            { mode: 0o600 },
          );
        const port = createLocalSqliteProductionLifecyclePort({
          home,
          filesystemProfile: "local-ext4",
          opener,
          allowPathFallbackForTesting: true,
          lifecycleAfterFirstIntentScanForTesting:
            state === "inventory-race"
              ? () => {
                  mkdirSync(
                    join(namespace.destinationTypeDirectory, "f".repeat(64)),
                    { mode: 0o700 },
                  );
                }
              : undefined,
        });
        await expect(
          port.claimRecoveryIntent(new AbortController().signal),
        ).rejects.toThrow(
          "destination.local-sqlite.lifecycle-reconciliation-required",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const root = mkdtempSync(join(tmpdir(), "agentscope-lifecycle-state-"));
    chmodSync(root, 0o700);
    try {
      const fixture = directFixture(root);
      await expect(
        fixture.port.publishIntent(
          {
            ...fixture.intent,
            physicalEvidenceFingerprint: `sha256-${"f".repeat(64)}`,
          },
          "{}\n",
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await fixture.port.publishIntent(
        fixture.intent,
        "{}\n",
        new AbortController().signal,
      );
      await expect(
        fixture.port.inspectRetainedDelete(
          connectionId,
          new AbortController().signal,
        ),
      ).resolves.toBeNull();
      writeFileSync(
        join(
          fixture.inspected.namespace.lifecycleDirectory,
          "ownership-receipt-v1.json",
        ),
        "malformed",
        { mode: 0o600 },
      );
      await expect(
        fixture.port.inspectRetainedDelete(
          connectionId,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await expect(
        fixture.port.revalidatePhysicalEvidence(
          fixture.intent,
          fixture.inspected.evidence,
          {
            ...fixture.fence,
            record: {
              ...fixture.fence.record,
              transactionId: "9".repeat(32),
            },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await expect(
        fixture.port.revalidatePhysicalEvidence(
          fixture.intent,
          {
            ...fixture.inspected.evidence,
            physicalEvidenceFingerprint: `sha256-${"e".repeat(64)}`,
          },
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await expect(
        fixture.port.activateConfigure(
          fixture.intent,
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await expect(
        fixture.port.publishOwnershipReceipt(
          { transactionId: "9".repeat(32), connectionId } as never,
          "{}\n",
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      writeFileSync(
        join(
          fixture.inspected.namespace.connectionNamespace,
          `configure-${fixture.intent.transactionId}.sqlite`,
        ),
        "occupied",
        { mode: 0o600 },
      );
      await expect(
        fixture.port.stageConfigure(
          fixture.intent,
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      expect(
        existsSync(
          join(
            fixture.inspected.namespace.connectionNamespace,
            `configure-${fixture.intent.transactionId}.sqlite`,
          ),
        ),
      ).toBe(true);
      writeFileSync(
        join(
          fixture.inspected.namespace.lifecycleDirectory,
          "operation-phase-v1.json",
        ),
        "malformed",
        { mode: 0o600 },
      );
      await expect(
        fixture.port.rollbackPrepared(
          fixture.intent,
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      unlinkSync(
        join(
          fixture.inspected.namespace.lifecycleDirectory,
          "operation-phase-v1.json",
        ),
      );
      await fixture.port.rollbackPrepared(
        { ...fixture.intent, operation: "unconfigure" },
        fixture.fence,
        new AbortController().signal,
      );

      writeFileSync(fixture.inspected.namespace.databasePath, "", {
        mode: 0o600,
      });
      await expect(
        fixture.port.inspectOwnedDatabase(
          fixture.intent,
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      writeFileSync(
        join(fixture.inspected.namespace.connectionNamespace, "unexpected"),
        "x",
        { mode: 0o600 },
      );
      await expect(
        fixture.port.deleteOwnedDatabaseFamily(
          {
            ...fixture.intent,
            operation: "delete",
            retainedDatabaseFamilyPhysicalIdentity: "dev:1:ino:1",
          },
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      unlinkSync(
        join(fixture.inspected.namespace.connectionNamespace, "unexpected"),
      );
      writeFileSync(
        join(
          fixture.inspected.namespace.lifecycleDirectory,
          "ownership-receipt-v1.json",
        ),
        "malformed",
        { mode: 0o600 },
      );
      await expect(
        fixture.port.authenticateOwnershipReceipt(
          fixture.intent,
          fixture.fence as never,
          new AbortController().signal,
        ),
      ).rejects.toThrow(
        "destination.local-sqlite.lifecycle-reconciliation-required",
      );
      await fixture.port.completeFinalization(
        "8".repeat(32),
        new AbortController().signal,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
