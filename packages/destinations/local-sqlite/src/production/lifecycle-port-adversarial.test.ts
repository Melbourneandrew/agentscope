import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT } from "../lifecycle/capability.js";
import type {
  LocalSqliteLifecycleIntent,
  LocalSqliteOwnershipReceipt,
} from "../lifecycle/configuration.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import { encodeLocalSqliteFenceRecord } from "../lifecycle/fence.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import { createLocalSqliteFilesystemGatePort } from "./filesystem-port.js";
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

const recoveryClaimContext = (
  operationId = "1".repeat(32),
  selectedConnectionId = connectionId,
) =>
  ({
    connectionId: selectedConnectionId,
    operationId,
    signal: new AbortController().signal,
  }) as never;

const ownershipReceiptFor = (
  intent: LocalSqliteLifecycleIntent,
  overrides: Partial<LocalSqliteOwnershipReceipt> = {},
): LocalSqliteOwnershipReceipt =>
  Object.freeze({
    recordVersion: 1,
    destinationType: intent.destinationType,
    connectionId: intent.connectionId,
    connectionDigest: intent.connectionDigest,
    namespaceFingerprint: intent.namespaceFingerprint,
    physicalEvidenceFingerprint: intent.physicalEvidenceFingerprint,
    databaseFamilyPhysicalIdentity: "dev:1:ino:1",
    destinationFormat: intent.destinationFormat,
    migrationManifestId: intent.migrationManifestId,
    protocolCompatibilityId: intent.protocolCompatibilityId,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    recoveryHandlerId: intent.recoveryHandlerId,
    capabilityVersion: 1,
    artifactGrammarVersion: 1,
    artifactGrammarFingerprint: intent.artifactGrammarFingerprint,
    originatingConfigurationGeneration: intent.expectedConfigurationGeneration,
    originatingConfigurationDigest: intent.expectedConfigurationDigest,
    transactionId: intent.transactionId,
    retentionPolicy: intent.retentionPolicy,
    ...overrides,
  });

const directFixture = (
  root: string,
  selectedConnectionId = connectionId,
  transactionId = "1".repeat(32),
) => {
  const home = Object.freeze({ root, platform: process.platform });
  const inspected = inspectLocalSqliteProductionPlan(
    home,
    "local-ext4",
    selectedConnectionId,
    policy,
    true,
  );
  const capability = localSqliteDestinationDescriptor.localResourceLifecycle!;
  const intent = Object.freeze({
    recordVersion: 1,
    operation: "configure",
    transactionId,
    destinationType: localSqliteDestinationDescriptor.destinationType,
    connectionId: selectedConnectionId,
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
      owner: Object.freeze({
        pid: intent.owner.processId,
        startIdentity: intent.owner.processStartIdentity,
      }),
    }),
    deadLeaseNames: Object.freeze([]),
  });
  return Object.freeze({ home, inspected, intent, port, fence });
};

// The adversarial matrix is intentionally kept together so every production
// lifecycle port boundary shares one filesystem fixture and cleanup discipline.
// eslint-disable-next-line max-lines-per-function
describe("production Local SQLite lifecycle adversarial boundaries", () => {
  it("adopts an exact claim-only recovery fence without creating a second inode", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "agentscope-lifecycle-claim-only-"),
    );
    chmodSync(root, 0o700);
    try {
      const initial = directFixture(root);
      for (const directory of [
        initial.inspected.namespace.lifecycleDirectory,
        initial.inspected.namespace.backupsDirectory,
      ])
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fixture = directFixture(root);
      await fixture.port.publishIntent(
        fixture.intent,
        `${JSON.stringify(fixture.intent)}\n`,
        new AbortController().signal,
      );
      const fenceRecord = Object.freeze({
        transactionId: fixture.intent.transactionId,
        lifecycleFingerprint: fixture.intent.lifecycleFingerprint,
        lifecycleGeneration: fixture.intent.capabilityVersion,
        purpose: "lifecycle" as const,
        owner: Object.freeze({
          pid: 2_147_483_647,
          startIdentity: "1".repeat(32),
        }),
      });
      const gate = createLocalSqliteFilesystemGatePort(
        fixture.inspected.namespace.lifecycleDirectory,
        {
          allowPathFallbackForTesting: true,
          afterNamespaceClaimForTesting: () => {
            unlinkSync(
              join(
                fixture.inspected.namespace.lifecycleDirectory,
                "exclusive-fence-v1",
              ),
            );
            throw new Error("synthetic claim-only interruption");
          },
        },
      );
      const created = gate.createFenceDurably({
        filename: "exclusive-fence-v1",
        content: encodeLocalSqliteFenceRecord(fenceRecord)!,
      }) as { state: "created"; physicalIdentity: string };
      expect(() =>
        gate.removeArtifactIfIdentity({
          filename: "exclusive-fence-v1",
          physicalIdentity: created.physicalIdentity,
        }),
      ).toThrow("synthetic claim-only interruption");
      const recovery = createLocalSqliteProductionLifecyclePort({
        home: fixture.home,
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      }).claimRecoveryIntent(recoveryClaimContext());
      if (process.platform === "linux")
        await expect(recovery).resolves.toMatchObject({
          fence: { physicalIdentity: created.physicalIdentity },
        });
      else
        await expect(recovery).rejects.toThrow(
          "destination.local-sqlite.lifecycle-busy",
        );
      expect(
        readdirSync(fixture.inspected.namespace.lifecycleDirectory).filter(
          (name) =>
            name === "exclusive-fence-v1" ||
            name.startsWith("namespace-claim-v1-"),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
      "intent-race",
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
        if (
          state === "missing-intent" ||
          state === "malformed-intent" ||
          state === "intent-race"
        )
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
        if (state === "intent-race") {
          const intent = directFixture(root).intent;
          writeFileSync(
            join(namespace.lifecycleDirectory, "intent-v1.json"),
            `${JSON.stringify(intent)}\n`,
            { mode: 0o600 },
          );
        }
        const port = createLocalSqliteProductionLifecyclePort({
          home,
          filesystemProfile: "local-ext4",
          opener,
          allowPathFallbackForTesting: true,
          lifecycleAfterFirstIntentScanForTesting:
            state === "inventory-race" || state === "intent-race"
              ? () => {
                  if (state === "inventory-race")
                    mkdirSync(
                      join(namespace.destinationTypeDirectory, "f".repeat(64)),
                      { mode: 0o700 },
                    );
                  else {
                    const changed = {
                      ...directFixture(root).intent,
                      transactionId: "2".repeat(32),
                    };
                    writeFileSync(
                      join(namespace.lifecycleDirectory, "intent-v1.json"),
                      `${JSON.stringify(changed)}\n`,
                      { mode: 0o600 },
                    );
                  }
                }
              : undefined,
        });
        const operation =
          state === "invalid-connection-name" || state === "inventory-race"
            ? port.completeFinalization(
                "1".repeat(32),
                new AbortController().signal,
              )
            : port.claimRecoveryIntent(recoveryClaimContext());
        await expect(operation).rejects.toThrow(
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

  it("claims each requested connection independently when two intents coexist", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-lifecycle-multi-"));
    chmodSync(root, 0o700);
    try {
      const secondConnectionId = `destination-connection-v1-${"9".repeat(64)}`;
      const initial = [
        directFixture(root),
        directFixture(root, secondConnectionId, "2".repeat(32)),
      ];
      for (const fixture of initial)
        for (const directory of [
          fixture.inspected.namespace.lifecycleDirectory,
          fixture.inspected.namespace.backupsDirectory,
        ])
          mkdirSync(directory, { recursive: true, mode: 0o700 });
      const first = directFixture(root);
      const second = directFixture(root, secondConnectionId, "2".repeat(32));
      for (const fixture of [first, second])
        await first.port.publishIntent(
          fixture.intent,
          `${JSON.stringify(fixture.intent)}\n`,
          new AbortController().signal,
        );

      const firstClaim = await first.port.claimRecoveryIntent(
        recoveryClaimContext(first.intent.transactionId, connectionId),
      );
      expect(firstClaim.canonicalBytes).toBe(
        `${JSON.stringify(first.intent)}\n`,
      );
      await first.port.completeFinalization(
        first.intent.transactionId,
        new AbortController().signal,
      );
      const secondClaim = await first.port.claimRecoveryIntent(
        recoveryClaimContext(second.intent.transactionId, secondConnectionId),
      );
      expect(secondClaim.canonicalBytes).toBe(
        `${JSON.stringify(second.intent)}\n`,
      );
      const restarted = createLocalSqliteProductionLifecyclePort({
        home: first.home,
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      });
      await restarted.completeFinalization(
        second.intent.transactionId,
        new AbortController().signal,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only an exact ownership receipt during delete completion", async () => {
    for (const state of [
      "absent",
      "malformed",
      "mismatched",
      "exact",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "agentscope-delete-completion-"));
      chmodSync(root, 0o700);
      try {
        const fixture = directFixture(root);
        const intent = Object.freeze({
          ...fixture.intent,
          operation: "delete" as const,
        });
        await fixture.port.publishIntent(
          intent,
          `${JSON.stringify(intent)}\n`,
          new AbortController().signal,
        );
        const receiptPath = join(
          fixture.inspected.namespace.lifecycleDirectory,
          "ownership-receipt-v1.json",
        );
        if (state === "malformed")
          writeFileSync(receiptPath, "malformed", { mode: 0o600 });
        if (state === "mismatched" || state === "exact") {
          const receipt = ownershipReceiptFor(
            intent,
            state === "mismatched"
              ? { connectionId: `destination-connection-v1-${"9".repeat(64)}` }
              : {},
          );
          writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, {
            mode: 0o600,
          });
        }
        const completion = fixture.port.completeFinalization(
          intent.transactionId,
          new AbortController().signal,
        );
        if (state === "malformed" || state === "mismatched")
          await expect(completion).rejects.toThrow(
            "destination.local-sqlite.lifecycle-reconciliation-required",
          );
        else {
          await expect(completion).resolves.toBeUndefined();
          expect(existsSync(receiptPath)).toBe(false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
