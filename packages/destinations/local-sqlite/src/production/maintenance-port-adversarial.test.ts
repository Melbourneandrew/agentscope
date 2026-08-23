import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT } from "../lifecycle/capability.js";
import type { LocalSqliteMaintenanceIntent } from "../lifecycle/maintenance.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import { createLocalSqliteProductionMaintenancePort } from "./maintenance-port.js";

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const opener = Object.freeze({
  open: () => {
    throw new Error("native opener must not run");
  },
});

// The hostile matrix intentionally shares one exact namespace/cleanup discipline.
// eslint-disable-next-line max-lines-per-function
describe("production Local SQLite maintenance adversarial boundaries", () => {
  it("rejects malformed and racing maintenance-intent inventories", async () => {
    for (const state of [
      "invalid-settings",
      "invalid-connection-name",
      "missing-lifecycle",
      "missing-intent",
      "malformed-intent",
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
        const port = createLocalSqliteProductionMaintenancePort({
          home,
          filesystemProfile: "local-ext4",
          opener,
          allowPathFallbackForTesting: true,
          ...(state === "inventory-race"
            ? {
                maintenanceAfterFirstIntentScanForTesting: () => {
                  mkdirSync(
                    join(namespace.destinationTypeDirectory, "f".repeat(64)),
                    { mode: 0o700 },
                  );
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
          await expect(
            port.claimMaintenanceIntent(new AbortController().signal),
          ).rejects.toThrow(
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
        port.claimMaintenanceIntent(new AbortController().signal),
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
        state: "reconciliation-required",
        lifecycleState: "reconciliation-required",
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
