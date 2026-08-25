import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT } from "../lifecycle/capability.js";
import { encodeLocalSqliteFenceRecord } from "../lifecycle/fence.js";
import type { LocalSqliteMaintenanceIntent } from "../lifecycle/maintenance.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import { createLocalSqliteFilesystemGatePort } from "./filesystem-port.js";
import { createLocalSqliteProductionMaintenancePort } from "./maintenance-port.js";

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const opener = Object.freeze({
  open: () => {
    throw new Error("native opener must not run");
  },
});

const maintenanceClaimContext = (operationId = "1".repeat(32)) =>
  ({
    connectionId,
    operationId,
    signal: new AbortController().signal,
  }) as never;

const maintenanceIntentFor = (
  root: string,
  selectedConnectionId: string,
  transactionId: string,
  backupId: string,
): LocalSqliteMaintenanceIntent => {
  const namespace = planLocalSqliteNamespace({
    agentscopeHome: root,
    connectionId: selectedConnectionId,
    platform: process.platform === "win32" ? "win32" : "posix",
  });
  const capability = localSqliteDestinationDescriptor.localResourceLifecycle!;
  return Object.freeze({
    recordVersion: 1,
    operation: "backup",
    transactionId,
    backupId,
    destinationType: localSqliteDestinationDescriptor.destinationType,
    connectionId: selectedConnectionId,
    connectionDigest: namespace.connectionDigest,
    owner: Object.freeze({
      processId: process.pid,
      processStartIdentity: `process-start-v1-${"3".repeat(64)}`,
    }),
    namespaceFingerprint: namespace.fingerprint,
    physicalEvidenceFingerprint: `sha256-${"4".repeat(64)}`,
    lifecycleFingerprint: capability.fingerprint,
    recoveryHandlerId: capability.recoveryHandlerId,
    artifactGrammarFingerprint:
      LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
    artifactGrammarVersion: 1,
    capabilityVersion: 1,
    destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
    migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
    protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    configurationGeneration: 1,
    configurationDigest: `sha256-${"5".repeat(64)}`,
    maximumAgeNanoseconds: "1",
    maximumTraceCount: 1,
    maximumPayloadBytes: 1,
    selectedReceiptDigest: null,
    selectedSnapshotPhysicalIdentity: null,
  }) as LocalSqliteMaintenanceIntent;
};

// The hostile matrix intentionally shares one exact namespace/cleanup discipline.
// eslint-disable-next-line max-lines-per-function
describe("production Local SQLite maintenance adversarial boundaries", () => {
  it("adopts an exact claim-only maintenance fence without creating a second inode", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "agentscope-maintenance-claim-only-"),
    );
    chmodSync(root, 0o700);
    try {
      const intent = maintenanceIntentFor(
        root,
        connectionId,
        "1".repeat(32),
        "3".repeat(32),
      );
      const namespace = planLocalSqliteNamespace({
        agentscopeHome: root,
        connectionId,
        platform: process.platform === "win32" ? "win32" : "posix",
      });
      for (const directory of [
        namespace.lifecycleDirectory,
        namespace.backupsDirectory,
      ])
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      const port = createLocalSqliteProductionMaintenancePort({
        home: Object.freeze({ root, platform: process.platform }),
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      });
      await port.publishMaintenanceIntent(
        intent,
        `${JSON.stringify(intent)}\n`,
        new AbortController().signal,
      );
      const gate = createLocalSqliteFilesystemGatePort(
        namespace.lifecycleDirectory,
        {
          allowPathFallbackForTesting: true,
          afterNamespaceClaimForTesting: () => {
            rmSync(join(namespace.lifecycleDirectory, "exclusive-fence-v1"));
            throw new Error("synthetic claim-only interruption");
          },
        },
      );
      const created = gate.createFenceDurably({
        filename: "exclusive-fence-v1",
        content: encodeLocalSqliteFenceRecord({
          transactionId: intent.transactionId,
          lifecycleFingerprint: intent.lifecycleFingerprint,
          lifecycleGeneration: intent.capabilityVersion,
          purpose: "lifecycle",
          owner: { pid: 2_147_483_647, startIdentity: "1".repeat(32) },
        })!,
      }) as { state: "created"; physicalIdentity: string };
      expect(() =>
        gate.removeArtifactIfIdentity({
          filename: "exclusive-fence-v1",
          physicalIdentity: created.physicalIdentity,
        }),
      ).toThrow("synthetic claim-only interruption");
      const recovery = createLocalSqliteProductionMaintenancePort({
        home: Object.freeze({ root, platform: process.platform }),
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      }).claimMaintenanceIntent(maintenanceClaimContext());
      if (process.platform === "linux")
        await expect(recovery).resolves.toMatchObject({
          fence: { physicalIdentity: created.physicalIdentity },
        });
      else
        await expect(recovery).rejects.toThrow(
          "destination.local-sqlite.maintenance-busy",
        );
      expect(
        readdirSync(namespace.lifecycleDirectory).filter(
          (name) =>
            name === "exclusive-fence-v1" ||
            name.startsWith("namespace-claim-v1-"),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("claims each requested connection independently when two maintenance intents coexist", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-maintenance-multi-"));
    chmodSync(root, 0o700);
    try {
      const secondConnectionId = `destination-connection-v1-${"9".repeat(64)}`;
      const intents = [
        maintenanceIntentFor(
          root,
          connectionId,
          "1".repeat(32),
          "3".repeat(32),
        ),
        maintenanceIntentFor(
          root,
          secondConnectionId,
          "2".repeat(32),
          "4".repeat(32),
        ),
      ];
      for (const intent of intents) {
        const namespace = planLocalSqliteNamespace({
          agentscopeHome: root,
          connectionId: intent.connectionId,
          platform: process.platform === "win32" ? "win32" : "posix",
        });
        for (const directory of [
          namespace.lifecycleDirectory,
          namespace.backupsDirectory,
        ])
          mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      const port = createLocalSqliteProductionMaintenancePort({
        home: Object.freeze({ root, platform: process.platform }),
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      });
      for (const intent of intents)
        await port.publishMaintenanceIntent(
          intent,
          `${JSON.stringify(intent)}\n`,
          new AbortController().signal,
        );
      for (const [index, intent] of intents.entries()) {
        const claimed = await port.claimMaintenanceIntent({
          connectionId: intent.connectionId,
          operationId: intent.transactionId,
          owner: intent.owner,
          signal: new AbortController().signal,
        } as never);
        expect(claimed.canonicalBytes).toBe(`${JSON.stringify(intent)}\n`);
        if (index === 0)
          await port.completeMaintenanceFinalization(
            intent.transactionId,
            new AbortController().signal,
          );
        else {
          const restarted = createLocalSqliteProductionMaintenancePort({
            home: Object.freeze({ root, platform: process.platform }),
            filesystemProfile: "local-ext4",
            opener,
            allowPathFallbackForTesting: true,
          });
          await restarted.completeMaintenanceFinalization(
            intent.transactionId,
            new AbortController().signal,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // eslint-disable-next-line max-lines-per-function -- one table proves every direct and global recovery-inventory failure under the same bounded fixture.
  it("rejects malformed and racing maintenance-intent inventories", async () => {
    for (const state of [
      "invalid-settings",
      "invalid-connection-name",
      "missing-lifecycle",
      "missing-intent",
      "malformed-intent",
      "intent-race",
      "inventory-race",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "agentscope-maintenance-scan-"));
      chmodSync(root, 0o700);
      try {
        const home = Object.freeze({ root, platform: process.platform });
        const namespace = planLocalSqliteNamespace({
          agentscopeHome: root,
          connectionId,
          platform: process.platform === "win32" ? "win32" : "posix",
        });
        if (state !== "invalid-settings") {
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
          const intent = maintenanceIntentFor(
            root,
            connectionId,
            "1".repeat(32),
            "3".repeat(32),
          );
          writeFileSync(
            join(namespace.lifecycleDirectory, "intent-v1.json"),
            `${JSON.stringify(intent)}\n`,
            { mode: 0o600 },
          );
        }
        const port = createLocalSqliteProductionMaintenancePort({
          home,
          filesystemProfile: "local-ext4",
          opener,
          allowPathFallbackForTesting: true,
          ...(state === "inventory-race" || state === "intent-race"
            ? {
                maintenanceAfterFirstIntentScanForTesting: () => {
                  if (state === "inventory-race")
                    mkdirSync(
                      join(namespace.destinationTypeDirectory, "f".repeat(64)),
                      { mode: 0o700 },
                    );
                  else {
                    const changed = maintenanceIntentFor(
                      root,
                      connectionId,
                      "2".repeat(32),
                      "3".repeat(32),
                    );
                    writeFileSync(
                      join(namespace.lifecycleDirectory, "intent-v1.json"),
                      `${JSON.stringify(changed)}\n`,
                      { mode: 0o600 },
                    );
                  }
                },
              }
            : {}),
        });
        if (state === "invalid-settings") {
          await expect(
            port.inspectMaintenance({
              connectionId,
              settings: {
                maximumAgeNanoseconds: 1,
                maximumPayloadBytes: "1",
                maximumTraceCount: "1",
              },
              signal: new AbortController().signal,
            } as never),
          ).rejects.toThrow(
            "destination.local-sqlite.maintenance-reconciliation-required",
          );
        } else {
          const operation =
            state === "invalid-connection-name" || state === "inventory-race"
              ? port.completeMaintenanceFinalization(
                  "1".repeat(32),
                  new AbortController().signal,
                )
              : port.claimMaintenanceIntent(maintenanceClaimContext());
          await expect(operation).rejects.toThrow(
            "destination.local-sqlite.maintenance-reconciliation-required",
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  // Fence publication, Doctor observation, release, and malformed replay form one
  // ordered authority test and cannot be split without weakening the transition.
  // eslint-disable-next-line max-lines-per-function
  it("rejects invalid settings/abort and maps competing or malformed fences", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "agentscope-maintenance-negative-"),
    );
    chmodSync(root, 0o700);
    try {
      const home = Object.freeze({ root, platform: process.platform });
      const port = createLocalSqliteProductionMaintenancePort({
        home,
        filesystemProfile: "local-ext4",
        opener,
        allowPathFallbackForTesting: true,
      });
      await expect(
        port.inspectMaintenance({
          connectionId,
          settings: null,
          signal: new AbortController().signal,
        } as never),
      ).rejects.toThrow(
        "destination.local-sqlite.maintenance-reconciliation-required",
      );
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        port.inspectMaintenance({
          connectionId,
          settings: {},
          signal: aborted.signal,
        } as never),
      ).rejects.toThrow("destination.local-sqlite.maintenance-unavailable");
      await expect(
        port.claimMaintenanceIntent(maintenanceClaimContext()),
      ).rejects.toThrow(
        "destination.local-sqlite.maintenance-reconciliation-required",
      );
      await expect(
        port.inspectDoctor({
          connectionId,
          settings: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          signal: new AbortController().signal,
        } as never),
      ).resolves.toMatchObject({
        state: "reconciliation-required",
        backupState: "unavailable",
      });

      const namespace = planLocalSqliteNamespace({
        agentscopeHome: root,
        connectionId,
        platform: process.platform === "win32" ? "win32" : "posix",
      });
      mkdirSync(namespace.lifecycleDirectory, {
        recursive: true,
        mode: 0o700,
      });
      mkdirSync(namespace.backupsDirectory, { recursive: true, mode: 0o700 });
      chmodSync(join(root, "destinations"), 0o700);
      chmodSync(namespace.destinationTypeDirectory, 0o700);
      chmodSync(namespace.connectionNamespace, 0o700);
      chmodSync(namespace.lifecycleDirectory, 0o700);
      chmodSync(namespace.backupsDirectory, 0o700);
      const capability =
        localSqliteDestinationDescriptor.localResourceLifecycle!;
      const intent = Object.freeze({
        recordVersion: 1,
        operation: "backup",
        transactionId: "1".repeat(32),
        backupId: "2".repeat(32),
        destinationType: localSqliteDestinationDescriptor.destinationType,
        connectionId,
        connectionDigest: namespace.connectionDigest,
        owner: Object.freeze({
          processId: process.pid,
          processStartIdentity: `process-start-v1-${"3".repeat(64)}`,
        }),
        namespaceFingerprint: namespace.fingerprint,
        physicalEvidenceFingerprint: `sha256-${"4".repeat(64)}`,
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        artifactGrammarFingerprint:
          LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
        artifactGrammarVersion: 1,
        capabilityVersion: 1,
        destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
        migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
        protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
        configurationGeneration: 1,
        configurationDigest: `sha256-${"5".repeat(64)}`,
        maximumAgeNanoseconds: "1",
        maximumTraceCount: 1,
        maximumPayloadBytes: 1,
        selectedReceiptDigest: null,
        selectedSnapshotPhysicalIdentity: null,
      }) as LocalSqliteMaintenanceIntent;
      await port.publishMaintenanceIntent(
        intent,
        "{}\n",
        new AbortController().signal,
      );
      const fence = await port.acquireExclusiveFence(
        intent,
        new AbortController().signal,
      );
      await expect(
        port.acquireExclusiveFence(intent, new AbortController().signal),
      ).rejects.toThrow("destination.local-sqlite.maintenance-busy");
      await expect(
        port.inspectDoctor({
          connectionId,
          settings: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          signal: new AbortController().signal,
        } as never),
      ).resolves.toMatchObject({
        state: "available",
        lifecycleState: "busy",
      });
      await port.finalizeMaintenance(
        intent,
        fence,
        new AbortController().signal,
      );
      writeFileSync(
        join(namespace.lifecycleDirectory, "exclusive-fence-v1"),
        "malformed",
        { mode: 0o600 },
      );
      await expect(
        port.acquireExclusiveFence(intent, new AbortController().signal),
      ).rejects.toThrow(
        "destination.local-sqlite.maintenance-reconciliation-required",
      );
      await expect(
        port.inspectDoctor({
          connectionId,
          settings: {
            maximumAgeNanoseconds: "1",
            maximumPayloadBytes: 1,
            maximumTraceCount: 1,
          },
          signal: new AbortController().signal,
        } as never),
      ).resolves.toMatchObject({
        state: "reconciliation-required",
        lifecycleState: "reconciliation-required",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
