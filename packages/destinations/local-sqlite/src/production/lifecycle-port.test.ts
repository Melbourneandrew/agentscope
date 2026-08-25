/* eslint-disable max-lines-per-function -- the real lifecycle sequence retains one home and authority ledger. */
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  applyLocalResourceLifecyclePlan,
  applyLocalResourceMaintenancePlan,
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  completeLocalResourceLifecycle,
  inspectLocalResourceLifecyclePlan,
  inspectLocalResourceMaintenancePlan,
  recoverLocalResourceLifecycle,
  recoverLocalResourceMaintenance,
} from "@agentscope/destinations-core";
import {
  bindLocalResourceConfigurationAuthorityForTesting,
  bindLocalResourceLifecycleContextForTesting,
  bindLocalResourceMaintenanceContextForTesting,
  bindLocalResourceLifecycleRecoveryContextForTesting,
  bindLocalResourceHomeAuthorityForTesting,
  bindLocalResourceMaintenanceRecoveryContextForTesting,
  createLocalResourceLifecycleDeadlineForTesting,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";

import { createLocalSqliteLifecycleHandlerForTesting } from "../lifecycle/configuration.js";
import { decodeLocalSqliteMaintenanceIntent } from "../lifecycle/maintenance.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import { localSqliteDestinationDescriptor } from "./descriptor.js";
import { localSqliteNamespaceClaimName } from "./owned-filesystem.js";
import { bindLocalSqliteProductionRuntimeForTesting } from "./runtime.js";
import type {
  OwnedSqliteConnection,
  OwnedSqliteStatement,
} from "./sqlite-port.js";

const wrapStatement = (
  database: DatabaseSync,
  sql: string,
): OwnedSqliteStatement => {
  const statement = database.prepare(sql);
  return {
    all: (...parameters) => statement.all(...(parameters as never[])),
    get: (...parameters) => statement.get(...(parameters as never[])),
    iterate: (...parameters) => statement.iterate(...(parameters as never[])),
    run: (...parameters) => statement.run(...(parameters as never[])),
  };
};

const opener = Object.freeze({
  open: (filename: string): OwnedSqliteConnection => {
    const database = new DatabaseSync(filename);
    return {
      close: () => {
        database.close();
      },
      backup: (path) => backup(database, path),
      exec: (sql) => {
        database.exec(sql);
      },
      get inTransaction() {
        return database.isTransaction;
      },
      pragma: (source) => {
        database.exec(`PRAGMA ${source}`);
      },
      prepare: (sql) => wrapStatement(database, sql),
    };
  },
});

const connectionId = `destination-connection-v1-${"2".repeat(64)}`;
const settings = Object.freeze({
  maximumAgeNanoseconds: "2592000000000000",
  maximumPayloadBytes: 1_000_000,
  maximumTraceCount: 10_000,
});

describe("production Local SQLite lifecycle port", () => {
  it("configures, backs up, restores, retains, and receipt-bound deletes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentscope-local-production-"));
    chmodSync(root, 0o700);
    try {
      const home = Object.freeze({
        root,
        platform: process.platform,
      });
      const runtime = bindLocalSqliteProductionRuntimeForTesting(
        bindLocalResourceHomeAuthorityForTesting(home),
        opener,
      );
      const registry = compileDestinationRegistry([
        localSqliteDestinationDescriptor,
      ]);
      const capability =
        localSqliteDestinationDescriptor.localResourceLifecycle!;
      const handlers = compileLocalResourceLifecycleHandlerRegistry(registry, [
        createLocalSqliteLifecycleHandlerForTesting(
          capability,
          runtime.lifecyclePort,
          runtime.maintenancePort,
          runtime.maximumSnapshotBytes,
        ),
      ]);

      const execute = async (
        operation: "configure" | "delete" | "unconfigure",
        operationId: string,
        expectedGeneration: number,
        retainedAuthority?: Readonly<{
          receiptDigest: string;
          databaseFamilyPhysicalIdentity: string;
        }>,
        targetHandlers = handlers,
      ) => {
        const context = bindLocalResourceLifecycleContextForTesting({
          operation,
          operationId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          connectionName: "local",
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          settings,
          expectedConfigurationGeneration: expectedGeneration,
          candidateConfigurationGeneration: expectedGeneration + 1,
          expectedConfigurationDigest: `sha256-${String(expectedGeneration).padStart(64, "3")}`,
          candidateConfigurationDigest: `sha256-${String(expectedGeneration + 1).padStart(64, "4")}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
        const evidence = await inspectLocalResourceLifecyclePlan(
          targetHandlers,
          context,
        );
        const authority = bindLocalResourceConfigurationAuthorityForTesting({
          destinationType: context.destinationType,
          connectionId,
          operationId,
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          priorGeneration: expectedGeneration,
          candidateGeneration: expectedGeneration + 1,
          candidateDigest: context.candidateConfigurationDigest,
          commit: () =>
            Promise.resolve({
              priorGeneration: expectedGeneration,
              committedGeneration: expectedGeneration + 1,
              candidateDigest: context.candidateConfigurationDigest,
            }),
        });
        const result = await applyLocalResourceLifecyclePlan(
          targetHandlers,
          context,
          evidence,
          authority,
          retainedAuthority,
        );
        if (result.ok)
          await completeLocalResourceLifecycle(targetHandlers, context);
        return result;
      };

      const configureOperationId = "1".repeat(32);
      const configureCrashHandlers =
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerForTesting(capability, {
            ...runtime.lifecyclePort,
            finalize: () =>
              Promise.reject(new Error("synthetic post-activation crash")),
          }),
        ]);
      await expect(
        execute(
          "configure",
          configureOperationId,
          1,
          undefined,
          configureCrashHandlers,
        ),
      ).resolves.toMatchObject({
        ok: false,
        state: "configuration-committed",
      });
      const configureRecoveryInput = {
        operation: "configure",
        operationId: configureOperationId,
        destinationType: localSqliteDestinationDescriptor.destinationType,
        connectionId,
        owner: {
          processId: process.pid,
          processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
        },
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        expectedConfigurationGeneration: 1,
        expectedConfigurationDigest: `sha256-${"1".padStart(64, "3")}`,
        authorizedCandidates: [
          {
            generation: 2,
            digest: `sha256-${"2".padStart(64, "4")}`,
          },
        ],
        configurationState: "committed",
        signal: new AbortController().signal,
        deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
      } as const;
      const namespace = planLocalSqliteNamespace({
        agentscopeHome: home.root,
        connectionId,
        platform: process.platform === "win32" ? "win32" : "posix",
      });
      const phasePath = join(
        namespace.lifecycleDirectory,
        "operation-phase-v1.json",
      );
      const exactPhaseBytes = readFileSync(phasePath, "utf8");
      renameSync(
        namespace.databasePath,
        join(
          namespace.connectionNamespace,
          `configure-${configureOperationId}.sqlite`,
        ),
      );
      writeFileSync(
        phasePath,
        `${JSON.stringify({
          ...(JSON.parse(exactPhaseBytes) as Record<string, unknown>),
          artifactPhysicalIdentity: "dev:substituted",
        })}\n`,
        { mode: 0o600 },
      );
      await expect(
        recoverLocalResourceLifecycle(
          handlers,
          bindLocalResourceLifecycleRecoveryContextForTesting(
            configureRecoveryInput,
          ),
        ),
      ).resolves.toEqual({
        ok: false,
        state: "reconciliation-required",
        code: "reconciliation-required",
      });
      writeFileSync(phasePath, exactPhaseBytes, { mode: 0o600 });
      linkSync(
        join(
          namespace.connectionNamespace,
          `configure-${configureOperationId}.sqlite`,
        ),
        namespace.databasePath,
      );
      const configureRecoveryContext =
        bindLocalResourceLifecycleRecoveryContextForTesting(
          configureRecoveryInput,
        );
      await expect(
        recoverLocalResourceLifecycle(handlers, configureRecoveryContext),
      ).resolves.toEqual({ ok: true, state: "configured" });
      rmSync(phasePath);
      expect(
        existsSync(join(namespace.lifecycleDirectory, "intent-v1.json")),
      ).toBe(true);
      await completeLocalResourceLifecycle(handlers, configureRecoveryContext);
      expect(
        existsSync(join(namespace.lifecycleDirectory, "intent-v1.json")),
      ).toBe(false);
      expect(existsSync(namespace.databasePath)).toBe(true);

      const maintenanceContext = (
        operation: "backup" | "restore",
        operationId: string,
        resourceSelector: string,
      ) =>
        bindLocalResourceMaintenanceContextForTesting({
          operation,
          operationId,
          resourceSelector,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          connectionName: "local",
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          settings,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      const recoveryContextForMaintenance = (
        operation: "backup" | "restore",
        operationId: string,
        resourceSelector: string,
      ) =>
        bindLocalResourceMaintenanceRecoveryContextForTesting({
          operation,
          operationId,
          resourceSelector,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      const inspectClaimedMaintenancePhase = async (
        context: ReturnType<typeof recoveryContextForMaintenance>,
      ) => {
        const claimed =
          await runtime.maintenancePort.claimMaintenanceIntent(context);
        const intent = decodeLocalSqliteMaintenanceIntent(
          claimed.canonicalBytes,
        );
        if (intent === undefined)
          throw new Error("production maintenance intent did not decode");
        return runtime.maintenancePort.inspectRecoveryPhase(
          intent,
          claimed.fence,
          new AbortController().signal,
        );
      };
      const backupId = "4".repeat(32);
      const backupContext = maintenanceContext("backup", backupId, backupId);
      const backupEvidence = await inspectLocalResourceMaintenancePlan(
        handlers,
        backupContext,
      );
      const backupCrashHandlers = compileLocalResourceLifecycleHandlerRegistry(
        registry,
        [
          createLocalSqliteLifecycleHandlerForTesting(
            capability,
            runtime.lifecyclePort,
            {
              ...runtime.maintenancePort,
              publishBackup: async (...arguments_) => {
                await runtime.maintenancePort.publishBackup(...arguments_);
                rmSync(phasePath);
                throw new Error("synthetic post-receipt pre-phase crash");
              },
            },
            runtime.maximumSnapshotBytes,
          ),
        ],
      );
      await expect(
        applyLocalResourceMaintenancePlan(
          backupCrashHandlers,
          backupContext,
          backupEvidence,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      await expect(
        inspectClaimedMaintenancePhase(
          recoveryContextForMaintenance("backup", backupId, backupId),
        ),
      ).resolves.toBe("backup-published");
      const backupRecoveryContext =
        bindLocalResourceMaintenanceRecoveryContextForTesting({
          operation: "backup",
          operationId: backupId,
          resourceSelector: backupId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      const backedUp = await recoverLocalResourceMaintenance(
        handlers,
        backupRecoveryContext,
      );
      expect(backedUp).toMatchObject({ ok: true, state: "backed-up" });
      expect(existsSync(phasePath)).toBe(true);
      await expect(
        inspectClaimedMaintenancePhase(backupRecoveryContext),
      ).resolves.toBe("backup-published");
      rmSync(phasePath);
      await completeLocalResourceLifecycle(handlers, backupRecoveryContext);

      const candidateOnlyBackupId = "a".repeat(32);
      const candidateOnlyBackupContext = maintenanceContext(
        "backup",
        candidateOnlyBackupId,
        candidateOnlyBackupId,
      );
      const candidateOnlyBackupEvidence =
        await inspectLocalResourceMaintenancePlan(
          handlers,
          candidateOnlyBackupContext,
        );
      const candidateOnlyBackupHandlers =
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerForTesting(
            capability,
            runtime.lifecyclePort,
            {
              ...runtime.maintenancePort,
              publishBackup: () =>
                Promise.reject(new Error("synthetic pre-publish crash")),
            },
            runtime.maximumSnapshotBytes,
          ),
        ]);
      await expect(
        applyLocalResourceMaintenancePlan(
          candidateOnlyBackupHandlers,
          candidateOnlyBackupContext,
          candidateOnlyBackupEvidence,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      await expect(
        inspectClaimedMaintenancePhase(
          recoveryContextForMaintenance(
            "backup",
            candidateOnlyBackupId,
            candidateOnlyBackupId,
          ),
        ),
      ).resolves.toBe("backup-candidate");
      linkSync(
        join(
          namespace.backupsDirectory,
          `candidate-${candidateOnlyBackupId}.sqlite`,
        ),
        join(
          namespace.backupsDirectory,
          `backup-${candidateOnlyBackupId}.sqlite`,
        ),
      );
      const candidateOnlyBackupRecoveryContext =
        bindLocalResourceMaintenanceRecoveryContextForTesting({
          operation: "backup",
          operationId: candidateOnlyBackupId,
          resourceSelector: candidateOnlyBackupId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      await expect(
        recoverLocalResourceMaintenance(
          handlers,
          candidateOnlyBackupRecoveryContext,
        ),
      ).resolves.toMatchObject({ ok: true, state: "backed-up" });
      await completeLocalResourceLifecycle(
        handlers,
        candidateOnlyBackupRecoveryContext,
      );

      const candidateOnlyRestoreId = "b".repeat(32);
      const candidateOnlyRestoreContext = maintenanceContext(
        "restore",
        candidateOnlyRestoreId,
        backupId,
      );
      const candidateOnlyRestoreEvidence =
        await inspectLocalResourceMaintenancePlan(
          handlers,
          candidateOnlyRestoreContext,
        );
      const candidateOnlyRestoreHandlers =
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerForTesting(
            capability,
            runtime.lifecyclePort,
            {
              ...runtime.maintenancePort,
              replaceActiveWithRestoreCandidate: () =>
                Promise.reject(new Error("synthetic pre-replacement crash")),
            },
            runtime.maximumSnapshotBytes,
          ),
        ]);
      await expect(
        applyLocalResourceMaintenancePlan(
          candidateOnlyRestoreHandlers,
          candidateOnlyRestoreContext,
          candidateOnlyRestoreEvidence,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      await expect(
        inspectClaimedMaintenancePhase(
          recoveryContextForMaintenance(
            "restore",
            candidateOnlyRestoreId,
            backupId,
          ),
        ),
      ).resolves.toBe("restore-candidate");
      const claimedCandidateRestore =
        await runtime.maintenancePort.claimMaintenanceIntent(
          recoveryContextForMaintenance(
            "restore",
            candidateOnlyRestoreId,
            backupId,
          ),
        );
      const candidateRestoreIntent = decodeLocalSqliteMaintenanceIntent(
        claimedCandidateRestore.canonicalBytes,
      );
      if (candidateRestoreIntent === undefined)
        throw new Error("restore candidate intent did not decode");
      const candidateInventory =
        await runtime.maintenancePort.inspectBackupInventory(
          candidateRestoreIntent,
          claimedCandidateRestore.fence,
          new AbortController().signal,
        );
      expect(
        candidateInventory.entries.some(
          ({ role }) => role === "database-candidate",
        ),
      ).toBe(true);
      await runtime.maintenancePort.replaceActiveWithRestoreCandidate(
        candidateRestoreIntent,
        claimedCandidateRestore.fence,
        new AbortController().signal,
      );
      await expect(
        runtime.maintenancePort.inspectRecoveryPhase(
          candidateRestoreIntent,
          claimedCandidateRestore.fence,
          new AbortController().signal,
        ),
      ).resolves.toBe("restore-replaced");
      const replacedInventory =
        await runtime.maintenancePort.inspectBackupInventory(
          candidateRestoreIntent,
          claimedCandidateRestore.fence,
          new AbortController().signal,
        );
      expect(
        replacedInventory.entries.some(
          ({ role }) => role === "rollback-preimage",
        ),
      ).toBe(true);
      const candidateOnlyRestoreRecoveryContext =
        bindLocalResourceMaintenanceRecoveryContextForTesting({
          operation: "restore",
          operationId: candidateOnlyRestoreId,
          resourceSelector: backupId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      await expect(
        recoverLocalResourceMaintenance(
          handlers,
          candidateOnlyRestoreRecoveryContext,
        ),
      ).resolves.toMatchObject({ ok: true, state: "restored" });
      await completeLocalResourceLifecycle(
        handlers,
        candidateOnlyRestoreRecoveryContext,
      );

      const restoreContext = maintenanceContext(
        "restore",
        "5".repeat(32),
        backupId,
      );
      const restoreEvidence = await inspectLocalResourceMaintenancePlan(
        handlers,
        restoreContext,
      );
      const restoreCrashHandlers = compileLocalResourceLifecycleHandlerRegistry(
        registry,
        [
          createLocalSqliteLifecycleHandlerForTesting(
            capability,
            runtime.lifecyclePort,
            {
              ...runtime.maintenancePort,
              finalizeMaintenance: () =>
                Promise.reject(new Error("synthetic post-restore crash")),
            },
            runtime.maximumSnapshotBytes,
          ),
        ],
      );
      await expect(
        applyLocalResourceMaintenancePlan(
          restoreCrashHandlers,
          restoreContext,
          restoreEvidence,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      await expect(
        inspectClaimedMaintenancePhase(
          recoveryContextForMaintenance("restore", "5".repeat(32), backupId),
        ),
      ).resolves.toBe("restore-verified");
      const restoreRecoveryInput = {
        operation: "restore",
        operationId: "5".repeat(32),
        resourceSelector: backupId,
        destinationType: localSqliteDestinationDescriptor.destinationType,
        connectionId,
        owner: {
          processId: process.pid,
          processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
        },
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        configurationGeneration: 2,
        configurationDigest: `sha256-${"8".repeat(64)}`,
        signal: new AbortController().signal,
        deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
      } as const;
      const exactRestorePhaseBytes = readFileSync(phasePath, "utf8");
      writeFileSync(
        phasePath,
        `${JSON.stringify({
          ...(JSON.parse(exactRestorePhaseBytes) as Record<string, unknown>),
          artifactPhysicalIdentity: "dev:substituted",
        })}\n`,
        { mode: 0o600 },
      );
      await expect(
        recoverLocalResourceMaintenance(
          handlers,
          bindLocalResourceMaintenanceRecoveryContextForTesting(
            restoreRecoveryInput,
          ),
        ),
      ).resolves.toEqual({
        ok: false,
        state: "reconciliation-required",
        code: "reconciliation-required",
      });
      writeFileSync(phasePath, exactRestorePhaseBytes, { mode: 0o600 });
      const restoreRecoveryContext =
        bindLocalResourceMaintenanceRecoveryContextForTesting(
          restoreRecoveryInput,
        );
      await expect(
        recoverLocalResourceMaintenance(handlers, restoreRecoveryContext),
      ).resolves.toEqual({ ok: true, state: "restored" });
      rmSync(phasePath);
      await completeLocalResourceLifecycle(handlers, restoreRecoveryContext);

      const rollbackRestoreId = "8".repeat(32);
      const rollbackRestoreContext = maintenanceContext(
        "restore",
        rollbackRestoreId,
        backupId,
      );
      const rollbackRestoreEvidence = await inspectLocalResourceMaintenancePlan(
        handlers,
        rollbackRestoreContext,
      );
      const rollbackRestoreHandlers =
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerForTesting(
            capability,
            runtime.lifecyclePort,
            {
              ...runtime.maintenancePort,
              verifyRestoredActive: () => {
                linkSync(
                  join(
                    namespace.connectionNamespace,
                    `rollback-preimage-${rollbackRestoreId}.sqlite`,
                  ),
                  join(
                    namespace.connectionNamespace,
                    `restore-${rollbackRestoreId}.sqlite`,
                  ),
                );
                return Promise.resolve(false);
              },
            },
            runtime.maximumSnapshotBytes,
          ),
        ]);
      await expect(
        applyLocalResourceMaintenancePlan(
          rollbackRestoreHandlers,
          rollbackRestoreContext,
          rollbackRestoreEvidence,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      const claimedRollback =
        await runtime.maintenancePort.claimMaintenanceIntent(
          recoveryContextForMaintenance("restore", rollbackRestoreId, backupId),
        );
      const rollbackIntent = decodeLocalSqliteMaintenanceIntent(
        claimedRollback.canonicalBytes,
      );
      if (rollbackIntent === undefined)
        throw new Error("rollback maintenance intent did not decode");
      const redundantRestoreName = `restore-${rollbackRestoreId}.sqlite`;
      const redundantRestorePath = join(
        namespace.connectionNamespace,
        redundantRestoreName,
      );
      const rollbackPreimagePath = join(
        namespace.connectionNamespace,
        `rollback-preimage-${rollbackRestoreId}.sqlite`,
      );
      const preimageStat = statSync(rollbackPreimagePath);
      expect(statSync(namespace.databasePath)).toMatchObject({
        dev: preimageStat.dev,
        ino: preimageStat.ino,
      });
      expect(statSync(redundantRestorePath).ino).not.toBe(preimageStat.ino);
      const redundantRestoreClaimPath = join(
        namespace.connectionNamespace,
        localSqliteNamespaceClaimName(redundantRestoreName),
      );
      renameSync(namespace.databasePath, redundantRestoreClaimPath);
      renameSync(redundantRestorePath, namespace.databasePath);
      expect(statSync(redundantRestoreClaimPath)).toMatchObject({
        dev: preimageStat.dev,
        ino: preimageStat.ino,
      });
      expect(statSync(namespace.databasePath).ino).not.toBe(preimageStat.ino);
      expect(existsSync(redundantRestorePath)).toBe(false);
      await runtime.maintenancePort.rollbackRestoredActive(
        rollbackIntent,
        claimedRollback.fence,
        new AbortController().signal,
      );
      expect(existsSync(redundantRestoreClaimPath)).toBe(false);
      expect(statSync(namespace.databasePath)).toMatchObject({
        dev: preimageStat.dev,
        ino: preimageStat.ino,
      });
      expect(statSync(redundantRestorePath).ino).not.toBe(preimageStat.ino);
      rmSync(namespace.databasePath);
      await runtime.maintenancePort.rollbackRestoredActive(
        rollbackIntent,
        claimedRollback.fence,
        new AbortController().signal,
      );
      rmSync(namespace.databasePath);
      renameSync(
        join(
          namespace.connectionNamespace,
          `restore-${rollbackRestoreId}.sqlite`,
        ),
        namespace.databasePath,
      );
      await runtime.maintenancePort.rollbackRestoredActive(
        rollbackIntent,
        claimedRollback.fence,
        new AbortController().signal,
      );
      await runtime.maintenancePort.rollbackRestoredActive(
        rollbackIntent,
        claimedRollback.fence,
        new AbortController().signal,
      );
      expect(JSON.parse(readFileSync(phasePath, "utf8"))).toMatchObject({
        operation: "restore",
        phase: "restore-rolled-back",
        transactionId: rollbackRestoreId,
      });
      rmSync(phasePath);
      await expect(
        inspectClaimedMaintenancePhase(
          recoveryContextForMaintenance("restore", rollbackRestoreId, backupId),
        ),
      ).resolves.toBe("restore-rolled-back");
      const rollbackRecoveryContext =
        bindLocalResourceMaintenanceRecoveryContextForTesting({
          operation: "restore",
          operationId: rollbackRestoreId,
          resourceSelector: backupId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      await expect(
        recoverLocalResourceMaintenance(handlers, rollbackRecoveryContext),
      ).resolves.toEqual({ ok: true, state: "rolled-back" });
      rmSync(phasePath);
      await completeLocalResourceLifecycle(handlers, rollbackRecoveryContext);

      const maintenanceCrashId = "7".repeat(32);
      const intentOnlyMaintenanceHandlers =
        compileLocalResourceLifecycleHandlerRegistry(registry, [
          createLocalSqliteLifecycleHandlerForTesting(
            capability,
            runtime.lifecyclePort,
            {
              ...runtime.maintenancePort,
              acquireExclusiveFence: () =>
                Promise.reject(new Error("synthetic pre-fence crash")),
            },
            runtime.maximumSnapshotBytes,
          ),
        ]);
      const maintenanceCrashContext = maintenanceContext(
        "backup",
        maintenanceCrashId,
        maintenanceCrashId,
      );
      const maintenanceCrashEvidence =
        await inspectLocalResourceMaintenancePlan(
          intentOnlyMaintenanceHandlers,
          maintenanceCrashContext,
        );
      await expect(
        applyLocalResourceMaintenancePlan(
          intentOnlyMaintenanceHandlers,
          maintenanceCrashContext,
          maintenanceCrashEvidence,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      await expect(
        inspectClaimedMaintenancePhase(
          recoveryContextForMaintenance(
            "backup",
            maintenanceCrashId,
            maintenanceCrashId,
          ),
        ),
      ).resolves.toBe("intent-only");
      const maintenanceRecoveryContext =
        bindLocalResourceMaintenanceRecoveryContextForTesting({
          operation: "backup",
          operationId: maintenanceCrashId,
          resourceSelector: maintenanceCrashId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          configurationGeneration: 2,
          configurationDigest: `sha256-${"8".repeat(64)}`,
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      await expect(
        recoverLocalResourceMaintenance(handlers, maintenanceRecoveryContext),
      ).resolves.toEqual({ ok: true, state: "rolled-back" });
      await completeLocalResourceLifecycle(
        handlers,
        maintenanceRecoveryContext,
      );

      const unconfigured = await execute("unconfigure", "2".repeat(32), 2);
      expect(unconfigured).toMatchObject({ ok: true, state: "retained" });
      if (!unconfigured.ok || unconfigured.state !== "retained")
        throw new Error("retained authority missing");
      const retained = await runtime.lifecyclePort.inspectRetainedDelete(
        connectionId,
        new AbortController().signal,
      );
      expect(retained?.retainedAuthority).toEqual(
        unconfigured.retainedAuthority,
      );

      const deleteOperationId = "3".repeat(32);
      const deleteCrashHandlers = compileLocalResourceLifecycleHandlerRegistry(
        registry,
        [
          createLocalSqliteLifecycleHandlerForTesting(capability, {
            ...runtime.lifecyclePort,
            finalize: () =>
              Promise.reject(new Error("synthetic post-delete crash")),
          }),
        ],
      );
      await expect(
        execute(
          "delete",
          deleteOperationId,
          3,
          retained!.retainedAuthority,
          deleteCrashHandlers,
        ),
      ).resolves.toMatchObject({
        ok: false,
        state: "configuration-committed",
      });
      const deleteRecoveryContext =
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "delete",
          operationId: deleteOperationId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 3,
          expectedConfigurationDigest: `sha256-${"3".padStart(64, "3")}`,
          authorizedCandidates: [
            {
              generation: 4,
              digest: `sha256-${"4".padStart(64, "4")}`,
            },
          ],
          configurationState: "committed",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      await expect(
        recoverLocalResourceLifecycle(handlers, deleteRecoveryContext),
      ).resolves.toEqual({ ok: true, state: "deleted" });
      rmSync(join(namespace.lifecycleDirectory, "ownership-receipt-v1.json"));
      rmSync(phasePath);
      await completeLocalResourceLifecycle(handlers, deleteRecoveryContext);
      expect(
        await runtime.lifecyclePort.inspectRetainedDelete(
          connectionId,
          new AbortController().signal,
        ),
      ).toBeNull();
      expect(existsSync(namespace.databasePath)).toBe(false);
      expect(existsSync(join(root, "destinations"))).toBe(true);

      const intentOnlyHandlers = compileLocalResourceLifecycleHandlerRegistry(
        registry,
        [
          createLocalSqliteLifecycleHandlerForTesting(capability, {
            ...runtime.lifecyclePort,
            acquireExclusiveFence: () =>
              Promise.reject(new Error("synthetic pre-fence crash")),
          }),
        ],
      );
      const crashOperationId = "6".repeat(32);
      await expect(
        execute(
          "configure",
          crashOperationId,
          4,
          undefined,
          intentOnlyHandlers,
        ),
      ).resolves.toMatchObject({ ok: false, state: "prepared" });
      const lifecycleRecoveryContext =
        bindLocalResourceLifecycleRecoveryContextForTesting({
          operation: "configure",
          operationId: crashOperationId,
          destinationType: localSqliteDestinationDescriptor.destinationType,
          connectionId,
          owner: {
            processId: process.pid,
            processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
          },
          lifecycleFingerprint: capability.fingerprint,
          recoveryHandlerId: capability.recoveryHandlerId,
          expectedConfigurationGeneration: 4,
          expectedConfigurationDigest: `sha256-${"4".padStart(64, "3")}`,
          authorizedCandidates: [
            {
              generation: 5,
              digest: `sha256-${"5".padStart(64, "4")}`,
            },
          ],
          configurationState: "prior",
          signal: new AbortController().signal,
          deadline: createLocalResourceLifecycleDeadlineForTesting(60_000),
        });
      await expect(
        recoverLocalResourceLifecycle(handlers, lifecycleRecoveryContext),
      ).resolves.toEqual({ ok: true, state: "rolled-back" });
      await completeLocalResourceLifecycle(handlers, lifecycleRecoveryContext);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
