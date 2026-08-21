import { createHash } from "node:crypto";

import {
  applyLocalResourceMaintenancePlan,
  compileDestinationRegistry,
  compileLocalResourceLifecycleHandlerRegistry,
  completeLocalResourceLifecycle,
  createDestinationReporter,
  createReporterReceipt,
  defineDestinationDescriptor,
  defineLocalResourceLifecycleDeclaration,
  inspectLocalResourceDoctor,
  inspectLocalResourceMaintenancePlan,
  recoverLocalResourceMaintenance,
  type LocalResourceMaintenanceContext,
  type LocalResourceMaintenancePlanEvidence,
  type LocalResourceDoctorInspection,
} from "@agentscope/destinations-core";
import {
  bindLocalResourceDoctorContextForTesting,
  bindLocalResourceMaintenanceContextForTesting,
  bindLocalResourceMaintenanceRecoveryContextForTesting,
  createLocalResourceLifecycleDeadlineForTesting,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR,
  LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES,
  localSqliteLifecycleDeclaration,
  localSqliteLifecycleArtifactGrammarFingerprintForTesting,
} from "./capability.js";
import {
  createLocalSqliteLifecycleHandler,
  createLocalSqliteLifecycleHandlerForTesting,
  type LocalSqliteLifecyclePort,
} from "./configuration.js";
import {
  applyLocalSqliteMaintenance,
  decodeLocalSqliteBackupReceipt,
  decodeLocalSqliteMaintenanceIntent,
  encodeLocalSqliteBackupReceipt,
  encodeLocalSqliteMaintenanceIntent,
  LocalSqliteMaintenanceError,
  type LocalSqliteMaintenancePort,
  type LocalSqliteMaintenanceRecoveryPhase,
} from "./maintenance.js";
import {
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";

const settings = Object.freeze({
  maximumAgeNanoseconds: "2592000000000000",
  maximumPayloadBytes: 1_000_000,
  maximumTraceCount: 10_000,
});
const settingsSchema = z.strictObject({
  maximumAgeNanoseconds: z.string(),
  maximumPayloadBytes: z.number().int(),
  maximumTraceCount: z.number().int(),
});
void settingsSchema.shape;

const testArtifactGrammarFingerprint =
  localSqliteLifecycleArtifactGrammarFingerprintForTesting(
    LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES,
  );
const testLifecycleDeclaration = defineLocalResourceLifecycleDeclaration({
  artifactGrammarFingerprint: testArtifactGrammarFingerprint,
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
  recoveryHandlerId: `${LOCAL_SQLITE_DESTINATION_TYPE}/lifecycle-v1`,
  settingKeys: [
    "maximumAgeNanoseconds",
    "maximumPayloadBytes",
    "maximumTraceCount",
  ],
  settingsVersion: 1,
});

const registryFor = (
  declaration: ReturnType<typeof defineLocalResourceLifecycleDeclaration>,
) =>
  compileDestinationRegistry([
    defineDestinationDescriptor({
      commandName: "local-sqlite",
      createReporter: () =>
        createDestinationReporter({
          report: () => Promise.resolve(createReporterReceipt("accepted")),
        }),
      credentialSlots: [],
      defaultSettings: settings,
      deliveryIdentitySupport: "duplicates-possible",
      descriptorVersion: 1,
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      documentationPath: "/docs/local-sqlite",
      localResourceLifecycle: declaration,
      settingsSchema,
      settingsVersion: 1,
      transport: { kind: "local" },
    }),
  ]);
const destinationRegistry = registryFor(testLifecycleDeclaration);
const capability = destinationRegistry.descriptors[0]!.localResourceLifecycle!;
const productionRegistry = registryFor(localSqliteLifecycleDeclaration);
const productionCapability =
  productionRegistry.descriptors[0]!.localResourceLifecycle!;
const decodeIntent = (bytes: unknown) =>
  decodeLocalSqliteMaintenanceIntent(bytes, testArtifactGrammarFingerprint);
const decodeReceipt = (bytes: unknown) =>
  decodeLocalSqliteBackupReceipt(
    bytes,
    LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES,
    testArtifactGrammarFingerprint,
  );

const fence = Object.freeze({
  state: "exclusive" as const,
  filename: "exclusive-fence-v1" as const,
  physicalIdentity: "dev:1:ino:9",
  record: Object.freeze({
    transactionId: "1".repeat(32),
    lifecycleFingerprint: capability.fingerprint,
    lifecycleGeneration: 1,
    purpose: "lifecycle" as const,
  }),
  deadLeaseNames: Object.freeze([]),
});

const planEvidence = Object.freeze({
  namespaceFingerprint: `sha256-${"5".repeat(64)}`,
  physicalEvidenceFingerprint: `sha256-${"6".repeat(64)}`,
  displayPath: "/owned/local-sqlite/backups",
  persistentDataNotice: true as const,
  retentionPolicy: Object.freeze({
    ...settings,
    physicalCleanupTrigger: "next-authorized-mutation" as const,
  }),
});

const authority = Object.freeze({
  backupId: "2".repeat(32),
  receiptDigest: `sha256-${createHash("sha256").update(receiptBytes()).digest("hex")}`,
  snapshotPhysicalIdentity: "dev:1:ino:20",
});

const context = (
  operation: "backup" | "restore",
  signal = new AbortController().signal,
): LocalResourceMaintenanceContext =>
  bindLocalResourceMaintenanceContextForTesting({
    operation,
    operationId: operation === "backup" ? "2".repeat(32) : "3".repeat(32),
    resourceSelector: "2".repeat(32),
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    connectionId: `destination-connection-v1-${"4".repeat(64)}`,
    connectionName: "local",
    owner: {
      processId: 123,
      processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
    },
    settings,
    configurationGeneration: 7,
    configurationDigest: `sha256-${"3".repeat(64)}`,
    signal,
    deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
  });

const lifecyclePort = (): LocalSqliteLifecyclePort => ({
  inspect: () => Promise.resolve(planEvidence),
  inspectRetainedDelete: () => Promise.resolve(null),
  publishIntent: () => Promise.resolve(),
  acquireExclusiveFence: () => Promise.resolve(fence),
  revalidatePhysicalEvidence: () => Promise.resolve(),
  stageConfigure: () => Promise.resolve(),
  activateConfigure: () => Promise.resolve(),
  inspectOwnedDatabase: () =>
    Promise.resolve({ databaseFamilyPhysicalIdentity: "dev:1:ino:2" }),
  publishOwnershipReceipt: () => Promise.resolve(),
  authenticateOwnershipReceipt: () => Promise.resolve(),
  claimRecoveryIntent: () => Promise.reject(new Error("unused")),
  rollbackPrepared: () => Promise.resolve(),
  verifyRetainedDatabase: () => Promise.resolve(),
  deleteOwnedDatabaseFamily: () => Promise.resolve(),
  finalize: () => Promise.resolve(),
  completeFinalization: () => Promise.resolve(),
});

type PortOptions = Readonly<{
  failAt?: string;
  failUnknownAt?: string;
  phase?: LocalSqliteMaintenanceRecoveryPhase;
  restoredActive?: boolean;
  inventory?: unknown;
  claimBytes?: string;
  publishedReceiptBytes?: string;
  verifiedSnapshot?: unknown;
  verifiedPublishedSnapshot?: unknown;
  inspectedPlan?: LocalResourceMaintenancePlanEvidence;
  doctor?: LocalResourceDoctorInspection;
}>;

/* eslint-disable max-lines-per-function -- one exact fake port keeps phase state and the full callback ledger together. */
const maintenancePort = (
  events: string[],
  options: PortOptions = {},
): LocalSqliteMaintenancePort => {
  let intentBytes = "";
  let publishedReceipt = "";
  const step = (name: string) => () => {
    events.push(name);
    if (options.failUnknownAt === name)
      return Promise.reject(new Error("untrusted failure"));
    if (options.failAt === name)
      return Promise.reject(new LocalSqliteMaintenanceError("busy"));
    return Promise.resolve();
  };
  return {
    inspectMaintenance: (value) => {
      events.push("inspect");
      return Promise.resolve(
        options.inspectedPlan ??
          Object.freeze({
            planEvidence,
            resourceSelector: value.resourceSelector,
            selectedBackupAuthority:
              value.operation === "restore" ? authority : null,
          }),
      );
    },
    publishMaintenanceIntent: (_intent, bytes) => {
      events.push("intent");
      intentBytes = bytes;
      return Promise.resolve();
    },
    acquireExclusiveFence: () => {
      events.push("fence");
      return Promise.resolve(fence);
    },
    revalidatePhysicalEvidence: step("revalidate"),
    inspectBackupInventory: () => {
      events.push("inventory");
      return Promise.resolve(
        (options.inventory === undefined
          ? {
              entries:
                options.phase === "backup-candidate"
                  ? [inventoryEntry("database-candidate", 2)]
                  : [],
              hasCapacity: true,
            }
          : options.inventory) as never,
      );
    },
    cleanupRetention: step("cleanup-retention"),
    createBackupCandidate: step("backup-candidate"),
    verifyBackupCandidate: () => {
      events.push("verify-backup");
      return Promise.resolve(
        (options.verifiedSnapshot ?? {
          snapshotPhysicalIdentity: "dev:1:ino:20",
          snapshotBytes: 4_096,
          destinationFormat: "agentscope.local-sqlite.v1",
          migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
          protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
        }) as never,
      );
    },
    publishBackup: (_intent, _receipt, bytes) => {
      events.push("publish-backup");
      publishedReceipt = bytes;
      return Promise.resolve();
    },
    readPublishedBackupReceipt: () => {
      events.push("read-published");
      return Promise.resolve(
        options.publishedReceiptBytes ?? (publishedReceipt || receiptBytes()),
      );
    },
    verifyPublishedBackup: () => {
      events.push("verify-published");
      return Promise.resolve(
        (options.verifiedPublishedSnapshot ?? {
          snapshotPhysicalIdentity: "dev:1:ino:20",
          snapshotBytes: 4_096,
          destinationFormat: "agentscope.local-sqlite.v1",
          migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
          protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
        }) as never,
      );
    },
    readSelectedBackupReceipt: () => {
      events.push("authenticate-backup");
      return Promise.resolve(options.publishedReceiptBytes ?? receiptBytes());
    },
    createRestoreCandidate: step("restore-candidate"),
    verifyRestoreCandidate: step("verify-restore"),
    enforceRestoreRetention: step("restore-retention"),
    replaceActiveWithRestoreCandidate: step("replace-active"),
    verifyRestoredActive: () => {
      events.push("verify-active");
      return Promise.resolve(options.restoredActive ?? true);
    },
    rollbackRestoredActive: step("rollback-active"),
    verifyRolledBackActive: step("verify-rollback"),
    removeRollbackPreimage: step("remove-preimage"),
    claimMaintenanceIntent: () => {
      events.push("claim");
      const recoveryOperation = options.phase?.startsWith("restore")
        ? "restore"
        : "backup";
      return Promise.resolve({
        canonicalBytes:
          options.claimBytes ??
          (intentBytes || intentBytesFor(recoveryOperation)),
        fence,
      });
    },
    inspectRecoveryPhase: () => {
      events.push("phase");
      return Promise.resolve(options.phase ?? "intent-only");
    },
    rollbackPreparedMaintenance: step("rollback"),
    finalizeMaintenance: step("finalize"),
    completeMaintenanceFinalization: step("complete"),
    inspectDoctor: () => {
      events.push("doctor");
      return Promise.resolve(options.doctor ?? doctorInspection());
    },
  };
};
/* eslint-enable max-lines-per-function */

const intentBytesFor = (operation: "backup" | "restore" = "backup"): string =>
  maintenanceIntentFixture(operation);

const maintenanceIntentFixture = (operation: "backup" | "restore"): string => {
  const selected = operation === "restore";
  const connectionId = `destination-connection-v1-${"4".repeat(64)}`;
  const digest = createConnectionDigest(connectionId);
  const value = {
    recordVersion: 1,
    operation,
    transactionId: operation === "backup" ? "2".repeat(32) : "3".repeat(32),
    backupId: "2".repeat(32),
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    connectionId,
    connectionDigest: digest,
    owner: {
      processId: 123,
      processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
    },
    namespaceFingerprint: planEvidence.namespaceFingerprint,
    physicalEvidenceFingerprint: planEvidence.physicalEvidenceFingerprint,
    lifecycleFingerprint: capability.fingerprint,
    recoveryHandlerId: capability.recoveryHandlerId,
    artifactGrammarFingerprint: capability.artifactGrammarFingerprint,
    artifactGrammarVersion: 1,
    capabilityVersion: 1,
    destinationFormat: "agentscope.local-sqlite.v1",
    migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
    protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    configurationGeneration: 7,
    configurationDigest: `sha256-${"3".repeat(64)}`,
    maximumAgeNanoseconds: settings.maximumAgeNanoseconds,
    maximumTraceCount: settings.maximumTraceCount,
    maximumPayloadBytes: settings.maximumPayloadBytes,
    selectedReceiptDigest: selected ? authority.receiptDigest : null,
    selectedSnapshotPhysicalIdentity: selected
      ? authority.snapshotPhysicalIdentity
      : null,
  };
  return `${JSON.stringify(value)}\n`;
};

function createConnectionDigest(connectionId: string): string {
  // Keep the test fixture causally checked by the production decoder.
  const fixture = `${JSON.stringify({ connectionId, destinationType: LOCAL_SQLITE_DESTINATION_TYPE })}`;
  return createHash("sha256").update(fixture).digest("hex");
}

const rewriteCanonical = (
  bytes: string,
  mutate: (record: Record<string, unknown>) => void,
): string => {
  const record = JSON.parse(bytes) as Record<string, unknown>;
  mutate(record);
  return `${JSON.stringify(record)}\n`;
};

const inventoryEntry = (
  role:
    | "published-snapshot"
    | "backup-receipt"
    | "database-candidate"
    | "rollback-preimage"
    | "lifecycle-metadata",
  index: number,
  bytes = 1,
  physicalIdentity = `dev:1:ino:${index}`,
) => ({
  role,
  artifactId:
    role === "lifecycle-metadata"
      ? `artifact-${index}`
      : index.toString(16).repeat(32).slice(0, 32),
  physicalIdentity,
  bytes,
  sparse: false,
});

function receiptBytes(): string {
  const value = {
    recordVersion: 1,
    backupId: "2".repeat(32),
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    connectionId: `destination-connection-v1-${"4".repeat(64)}`,
    connectionDigest: createConnectionDigest(
      `destination-connection-v1-${"4".repeat(64)}`,
    ),
    namespaceFingerprint: planEvidence.namespaceFingerprint,
    physicalEvidenceFingerprint: planEvidence.physicalEvidenceFingerprint,
    snapshotPhysicalIdentity: "dev:1:ino:20",
    snapshotBytes: 4_096,
    destinationFormat: "agentscope.local-sqlite.v1",
    migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
    protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    lifecycleFingerprint: capability.fingerprint,
    recoveryHandlerId: capability.recoveryHandlerId,
    capabilityVersion: 1,
    artifactGrammarVersion: 1,
    artifactGrammarFingerprint: capability.artifactGrammarFingerprint,
    configurationGeneration: 7,
    configurationDigest: `sha256-${"3".repeat(64)}`,
    transactionId: "2".repeat(32),
  };
  return `${JSON.stringify(value)}\n`;
}

const doctorInspection = () =>
  Object.freeze({
    state: "available" as const,
    lifecycleState: "clean" as const,
    databaseState: "present" as const,
    backupState: "available" as const,
    sharedLeaseCount: 0,
    publishedBackupCount: 1,
    retentionPolicy: planEvidence.retentionPolicy,
    databaseDerivedRetention: Object.freeze({
      cutoff: "unavailable" as const,
      clockContinuity: "unavailable" as const,
      rowCount: "unavailable" as const,
      payloadBytes: "unavailable" as const,
    }),
  });

const registryWith = (port: LocalSqliteMaintenancePort) =>
  compileLocalResourceLifecycleHandlerRegistry(destinationRegistry, [
    createLocalSqliteLifecycleHandlerForTesting(
      capability,
      lifecyclePort(),
      port,
      LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES,
    ),
  ]);

// eslint-disable-next-line max-lines-per-function -- ordered apply paths share one exact port ledger.
describe("Local SQLite maintenance lifecycle", () => {
  it("backs up through retention cleanup, verified candidate, and durable receipt", async () => {
    const events: string[] = [];
    const value = context("backup");
    const result = await applyLocalResourceMaintenancePlan(
      registryWith(maintenancePort(events)),
      value,
      await inspectLocalResourceMaintenancePlan(
        registryWith(maintenancePort([])),
        value,
      ),
    );
    expect(result).toMatchObject({ ok: true, state: "backed-up" });
    expect(events).toEqual([
      "intent",
      "fence",
      "revalidate",
      "inventory",
      "cleanup-retention",
      "backup-candidate",
      "verify-backup",
      "publish-backup",
      "finalize",
    ]);
  });

  it("restores only after receipt authentication and verifies before and after replacement", async () => {
    const events: string[] = [];
    const value = context("restore");
    const port = maintenancePort(events);
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    const result = await applyLocalResourceMaintenancePlan(
      registry,
      value,
      evidence,
    );
    expect(result).toEqual({ ok: true, state: "restored" });
    expect(events).toEqual([
      "inspect",
      "intent",
      "fence",
      "revalidate",
      "inventory",
      "authenticate-backup",
      "restore-candidate",
      "verify-restore",
      "restore-retention",
      "verify-restore",
      "replace-active",
      "verify-active",
      "remove-preimage",
      "finalize",
    ]);
  });

  it("restores the rollback preimage when reopened candidate verification fails", async () => {
    const events: string[] = [];
    const value = context("restore");
    const port = maintenancePort(events, { restoredActive: false });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toEqual({ ok: false, state: "prepared", code: "unavailable" });
    expect(events).toContain("rollback-active");
    expect(events).toContain("verify-rollback");
    expect(events).not.toContain("remove-preimage");
  });

  it("rejects a restore whose durable receipt does not match its authority", async () => {
    const value = context("restore");
    const port = maintenancePort([], { publishedReceiptBytes: "{}\n" });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toMatchObject({
      ok: false,
      code: "reconciliation-required",
    });
  });

  it("refuses a full valid inventory before candidate mutation", async () => {
    const events: string[] = [];
    const value = context("backup");
    const port = maintenancePort(events, {
      inventory: { entries: [], hasCapacity: false },
    });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toMatchObject({ ok: false, code: "capacity" });
    expect(events).not.toContain("backup-candidate");

    const fullEntries = Array.from({ length: 8 }, (_, index) => [
      inventoryEntry("published-snapshot", index + 1),
      inventoryEntry("backup-receipt", index + 1, 1, `dev:2:ino:${index + 1}`),
    ]).flat();
    const contradictoryEvents: string[] = [];
    const contradictoryPort = maintenancePort(contradictoryEvents, {
      inventory: { entries: fullEntries, hasCapacity: true },
    });
    const contradictoryRegistry = registryWith(contradictoryPort);
    const contradictoryEvidence = await inspectLocalResourceMaintenancePlan(
      contradictoryRegistry,
      value,
    );
    await expect(
      applyLocalResourceMaintenancePlan(
        contradictoryRegistry,
        value,
        contradictoryEvidence,
      ),
    ).resolves.toMatchObject({ ok: false, code: "capacity" });
    expect(contradictoryEvents).not.toContain("backup-candidate");
  });

  it("rechecks candidate and receipt bytes against the admitted inventory", async () => {
    const events: string[] = [];
    const value = context("backup");
    const port = maintenancePort(events, {
      inventory: {
        entries: [inventoryEntry("lifecycle-metadata", 1, 65_536)],
        hasCapacity: true,
      },
    });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toMatchObject({ ok: false, code: "capacity" });
    expect(events).toContain("verify-backup");
    expect(events).not.toContain("publish-backup");
  });

  it("fails closed on malformed or over-budget inventory", async () => {
    const value = context("backup");
    for (const entries of [
      [
        inventoryEntry("database-candidate", 1),
        inventoryEntry("database-candidate", 2),
      ],
      [inventoryEntry("published-snapshot", 1, 17_179_869_185)],
      [
        inventoryEntry("published-snapshot", 1),
        inventoryEntry("backup-receipt", 2),
      ],
      [
        inventoryEntry("published-snapshot", 1),
        inventoryEntry("backup-receipt", 1, 1, "dev:1:ino:1"),
      ],
      [{ ...inventoryEntry("published-snapshot", 1), sparse: true }],
      [
        {
          ...inventoryEntry("published-snapshot", 1),
          artifactId: "not-a-backup-id",
        },
      ],
      [
        inventoryEntry("published-snapshot", 1),
        inventoryEntry("published-snapshot", 1, 1, "dev:9:ino:1"),
      ],
      [
        inventoryEntry("backup-receipt", 1),
        inventoryEntry("backup-receipt", 1, 1, "dev:9:ino:2"),
      ],
    ]) {
      const port = maintenancePort([], {
        inventory: { entries, hasCapacity: true },
      });
      const registry = registryWith(port);
      const evidence = await inspectLocalResourceMaintenancePlan(
        registry,
        value,
      );
      await expect(
        applyLocalResourceMaintenancePlan(registry, value, evidence),
      ).resolves.toMatchObject({
        ok: false,
        code: "reconciliation-required",
      });
    }
  });

  it("maps a typed pre-publication failure without claiming success", async () => {
    const value = context("backup");
    const port = maintenancePort([], { failAt: "backup-candidate" });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toEqual({ ok: false, state: "prepared", code: "busy" });
  });

  it("maps an untyped port failure to outcome unknown", async () => {
    const value = context("backup");
    const port = maintenancePort([], { failUnknownAt: "backup-candidate" });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toEqual({
      ok: false,
      state: "prepared",
      code: "outcome-unknown",
    });
  });
});

// eslint-disable-next-line max-lines-per-function -- the recovery matrix shares one exact recovery authority and adversarial variants.
describe("Local SQLite maintenance recovery", () => {
  it.each([
    ["intent-only", "rolled-back"],
    ["backup-candidate", "backed-up"],
    ["backup-published", "backed-up"],
  ] as const)("recovers backup phase %s", async (phase, state) => {
    const events: string[] = [];
    const port = maintenancePort(events, { phase });
    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "backup",
      operationId: "2".repeat(32),
      resourceSelector: "2".repeat(32),
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    const result = await recoverLocalResourceMaintenance(
      registryWith(port),
      recovery,
    );
    expect(result).toMatchObject({ ok: true, state });
    expect(events.at(-1)).toBe("finalize");
  });

  it("rejects drifted published snapshots, receipt transactions, and candidate selectors", async () => {
    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "backup",
      operationId: "2".repeat(32),
      resourceSelector: "2".repeat(32),
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    for (const options of [
      {
        phase: "backup-published" as const,
        verifiedPublishedSnapshot: {
          snapshotPhysicalIdentity: "dev:1:ino:999",
          snapshotBytes: 4_096,
          destinationFormat: "agentscope.local-sqlite.v1",
          migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
          protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
        },
      },
      {
        phase: "backup-published" as const,
        publishedReceiptBytes: rewriteCanonical(receiptBytes(), (record) => {
          record.transactionId = "6".repeat(32);
        }),
      },
      {
        phase: "backup-candidate" as const,
        inventory: {
          entries: [inventoryEntry("database-candidate", 3)],
          hasCapacity: true,
        },
      },
    ])
      await expect(
        recoverLocalResourceMaintenance(
          registryWith(maintenancePort([], options)),
          recovery,
        ),
      ).resolves.toMatchObject({
        ok: false,
        code: "reconciliation-required",
      });
  });

  it.each([
    "restore-candidate",
    "restore-replaced",
    "restore-verified",
  ] as const)(
    "recovers restore phase %s without losing the active preimage",
    async (phase) => {
      const events: string[] = [];
      const port = maintenancePort(events, { phase });
      const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
        operation: "restore",
        operationId: "3".repeat(32),
        resourceSelector: "2".repeat(32),
        destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
        connectionId: `destination-connection-v1-${"4".repeat(64)}`,
        owner: {
          processId: 123,
          processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
        },
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
        configurationGeneration: 7,
        configurationDigest: `sha256-${"3".repeat(64)}`,
        signal: new AbortController().signal,
        deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
      });
      await expect(
        recoverLocalResourceMaintenance(registryWith(port), recovery),
      ).resolves.toEqual({ ok: true, state: "restored" });
      expect(events.at(-1)).toBe("finalize");
    },
  );

  it("authenticates an already rolled-back restore during recovery", async () => {
    const events: string[] = [];
    const port = maintenancePort(events, { phase: "restore-rolled-back" });
    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "restore",
      operationId: "3".repeat(32),
      resourceSelector: "2".repeat(32),
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      recoverLocalResourceMaintenance(registryWith(port), recovery),
    ).resolves.toEqual({ ok: true, state: "rolled-back" });
    expect(events).toContain("verify-rollback");
    expect(events.at(-1)).toBe("finalize");
  });

  it("revalidates a previously verified restore before deleting its preimage", async () => {
    const events: string[] = [];
    const port = maintenancePort(events, {
      phase: "restore-verified",
      restoredActive: false,
    });
    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "restore",
      operationId: "3".repeat(32),
      resourceSelector: "2".repeat(32),
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      recoverLocalResourceMaintenance(registryWith(port), recovery),
    ).resolves.toEqual({ ok: false, state: "prepared", code: "unavailable" });
    expect(events).toContain("verify-active");
    expect(events).toContain("rollback-active");
    expect(events).not.toContain("remove-preimage");
  });

  it("rejects a backup-only phase for a restore intent", async () => {
    const port = maintenancePort([], {
      phase: "backup-candidate",
      claimBytes: intentBytesFor("restore"),
    });
    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "restore",
      operationId: "3".repeat(32),
      resourceSelector: "2".repeat(32),
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      recoverLocalResourceMaintenance(registryWith(port), recovery),
    ).resolves.toMatchObject({
      ok: false,
      code: "reconciliation-required",
    });
  });
});

// eslint-disable-next-line max-lines-per-function -- hostile persisted DTO and inventory cases share exact canonical fixtures.
describe("Local SQLite maintenance evidence and Doctor", () => {
  it("rejects noncanonical intent and receipt bytes", () => {
    const intent = intentBytesFor();
    const receipt = receiptBytes();
    expect(decodeIntent(intent)).toBeDefined();
    expect(decodeReceipt(receipt)).toBeDefined();
    expect(decodeIntent(intent.trim())).toBeUndefined();
    expect(decodeReceipt(receipt.replace("\n", ""))).toBeUndefined();
    expect(() => encodeLocalSqliteMaintenanceIntent({} as never)).toThrow(
      LocalSqliteMaintenanceError,
    );
    expect(() => encodeLocalSqliteBackupReceipt({} as never)).toThrow(
      LocalSqliteMaintenanceError,
    );
  });

  it("rejects malformed canonical records and incompatible snapshot evidence", async () => {
    const intent = intentBytesFor();
    const receipt = receiptBytes();
    for (const value of [
      "{\n",
      "null\n",
      "[]\n",
      rewriteCanonical(intent, (record) => delete record.backupId),
      rewriteCanonical(intent, (record) => {
        record.owner = null;
      }),
      rewriteCanonical(intent, (record) => {
        record.connectionDigest = "bad";
      }),
    ])
      expect(decodeIntent(value)).toBeUndefined();
    for (const value of [
      "{\n",
      "null\n",
      "[]\n",
      rewriteCanonical(receipt, (record) => delete record.backupId),
      rewriteCanonical(receipt, (record) => {
        record.snapshotBytes = 0;
      }),
    ])
      expect(decodeReceipt(value)).toBeUndefined();

    const value = context("backup");
    const port = maintenancePort([], {
      verifiedSnapshot: {
        snapshotPhysicalIdentity: "bad identity",
        snapshotBytes: 0,
        destinationFormat: "wrong",
        migrationManifestId: "wrong",
        protocolCompatibilityId: "wrong",
      },
    });
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).resolves.toMatchObject({
      ok: false,
      code: "reconciliation-required",
    });
  });

  it("rejects hostile bounded inventory shapes, aliases, and arithmetic", async () => {
    const value = context("backup");
    const paired = [
      inventoryEntry("published-snapshot", 1),
      { ...inventoryEntry("backup-receipt", 2), artifactId: "artifact-1" },
    ];
    const inventories: unknown[] = [
      null,
      { entries: [], hasCapacity: true, extra: true },
      { entries: "not-array", hasCapacity: true },
      {
        entries: new Array(129).fill(inventoryEntry("lifecycle-metadata", 1)),
        hasCapacity: true,
      },
      { entries: [null], hasCapacity: true },
      {
        entries: [{ ...inventoryEntry("lifecycle-metadata", 1), extra: true }],
        hasCapacity: true,
      },
      {
        entries: [inventoryEntry("lifecycle-metadata", 1, -1)],
        hasCapacity: true,
      },
      {
        entries: [inventoryEntry("lifecycle-metadata", 1, 65_537)],
        hasCapacity: true,
      },
      {
        entries: [
          inventoryEntry("lifecycle-metadata", 1, Number.MAX_SAFE_INTEGER),
          inventoryEntry("lifecycle-metadata", 2, 1),
        ],
        hasCapacity: true,
      },
      {
        entries: [inventoryEntry("database-candidate", 1, 17_179_869_185)],
        hasCapacity: true,
      },
      {
        entries: [inventoryEntry("database-candidate", 1)],
        hasCapacity: true,
      },
      {
        entries: [
          inventoryEntry("rollback-preimage", 1),
          inventoryEntry("rollback-preimage", 2),
        ],
        hasCapacity: true,
      },
      {
        entries: [
          ...paired,
          {
            ...inventoryEntry("published-snapshot", 3),
            artifactId: "artifact-1",
          },
        ],
        hasCapacity: true,
      },
      {
        entries: [
          inventoryEntry("published-snapshot", 1),
          inventoryEntry("backup-receipt", 2),
        ],
        hasCapacity: true,
      },
      {
        entries: [
          ...paired,
          { ...inventoryEntry("backup-receipt", 3), artifactId: "artifact-1" },
        ],
        hasCapacity: true,
      },
    ];
    for (const inventory of inventories) {
      const port = maintenancePort([], { inventory });
      const registry = registryWith(port);
      const evidence = await inspectLocalResourceMaintenancePlan(
        registry,
        value,
      );
      await expect(
        applyLocalResourceMaintenancePlan(registry, value, evidence),
      ).resolves.toMatchObject({
        ok: false,
        code: "reconciliation-required",
      });
    }
  });

  it("fails closed on aborted work and mismatched recovery evidence", async () => {
    const controller = new AbortController();
    const value = context("backup", controller.signal);
    const port = maintenancePort([]);
    const registry = registryWith(port);
    const evidence = await inspectLocalResourceMaintenancePlan(registry, value);
    controller.abort();
    await expect(
      applyLocalResourceMaintenancePlan(registry, value, evidence),
    ).rejects.toBeDefined();

    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "backup",
      operationId: "2".repeat(32),
      resourceSelector: "2".repeat(32),
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      owner: {
        processId: 123,
        processStartIdentity: `process-start-v1-${"7".repeat(64)}`,
      },
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    for (const options of [
      { claimBytes: "{}\n" },
      { claimBytes: intentBytesFor("restore") },
      {
        phase: "restore-candidate" as const,
        claimBytes: intentBytesFor("backup"),
      },
      {
        phase: "backup-candidate" as const,
        claimBytes: intentBytesFor("restore"),
      },
      { phase: "backup-published" as const, publishedReceiptBytes: "{}\n" },
    ])
      await expect(
        recoverLocalResourceMaintenance(
          registryWith(maintenancePort([], options)),
          recovery,
        ),
      ).resolves.toMatchObject({
        ok: false,
        code: "reconciliation-required",
      });
  });

  it("checks cancellation between port phases and rejects nonboolean reopen proof", async () => {
    const controller = new AbortController();
    const value = context("backup", controller.signal);
    const port = maintenancePort([]);
    const originalPublish = port.publishMaintenanceIntent;
    const cancellingPort = Object.freeze({
      ...port,
      publishMaintenanceIntent: async (
        ...args: Parameters<typeof originalPublish>
      ) => {
        await originalPublish(...args);
        controller.abort();
      },
    });
    await expect(
      applyLocalSqliteMaintenance(
        capability.fingerprint,
        capability.recoveryHandlerId,
        LOCAL_SQLITE_TEST_MAXIMUM_SNAPSHOT_BYTES,
        cancellingPort,
        Object.freeze({
          ...value,
          planEvidence: Object.freeze({
            planEvidence,
            resourceSelector: value.resourceSelector,
            selectedBackupAuthority: null,
          }),
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });

    const restoreValue = context("restore");
    const nonbooleanPort = Object.freeze({
      ...maintenancePort([]),
      verifyRestoredActive: () => Promise.resolve("yes" as never),
    });
    const registry = registryWith(nonbooleanPort);
    const evidence = await inspectLocalResourceMaintenancePlan(
      registry,
      restoreValue,
    );
    await expect(
      applyLocalResourceMaintenancePlan(registry, restoreValue, evidence),
    ).resolves.toMatchObject({
      ok: false,
      code: "reconciliation-required",
    });
  });

  it("Doctor uses only the nonmutating inspection port and fixes database-derived facts unavailable", async () => {
    const events: string[] = [];
    const port = maintenancePort(events);
    const doctorContext = bindLocalResourceDoctorContextForTesting({
      destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      connectionId: `destination-connection-v1-${"4".repeat(64)}`,
      connectionName: "CANARY_CONNECTION_NAME",
      settings,
      configurationGeneration: 7,
      configurationDigest: `sha256-${"3".repeat(64)}`,
      signal: new AbortController().signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    const result = await inspectLocalResourceDoctor(
      registryWith(port),
      doctorContext,
    );
    expect(result).toEqual(doctorInspection());
    expect(JSON.stringify(result)).not.toContain("CANARY_CONNECTION_NAME");
    expect(JSON.stringify(result)).not.toContain(doctorContext.connectionId);
    expect(events).toEqual(["doctor"]);
  });

  it("completes a maintenance finalization through the maintenance port", async () => {
    const events: string[] = [];
    await completeLocalResourceLifecycle(
      registryWith(maintenancePort(events)),
      context("backup"),
    );
    expect(events).toEqual(["complete"]);
  });

  it("keeps production unavailable without an admitted native maintenance port", async () => {
    const registry = compileLocalResourceLifecycleHandlerRegistry(
      productionRegistry,
      [createLocalSqliteLifecycleHandler(productionCapability)],
    );
    const value = context("backup");
    await expect(
      inspectLocalResourceMaintenancePlan(registry, value),
    ).rejects.toBeDefined();
    await expect(
      applyLocalResourceMaintenancePlan(
        registry,
        value,
        Object.freeze({
          planEvidence,
          resourceSelector: value.resourceSelector,
          selectedBackupAuthority: null,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await expect(
      completeLocalResourceLifecycle(registry, value),
    ).rejects.toBeDefined();
    const recovery = bindLocalResourceMaintenanceRecoveryContextForTesting({
      operation: "backup",
      operationId: value.operationId,
      resourceSelector: value.resourceSelector,
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      owner: value.owner,
      lifecycleFingerprint: productionCapability.fingerprint,
      recoveryHandlerId: productionCapability.recoveryHandlerId,
      configurationGeneration: value.configurationGeneration,
      configurationDigest: value.configurationDigest,
      signal: value.signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      recoverLocalResourceMaintenance(registry, recovery),
    ).resolves.toMatchObject({ ok: false, code: "unavailable" });

    const doctor = bindLocalResourceDoctorContextForTesting({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      connectionName: value.connectionName,
      settings,
      configurationGeneration: value.configurationGeneration,
      configurationDigest: value.configurationDigest,
      signal: value.signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      inspectLocalResourceDoctor(registry, doctor),
    ).rejects.toBeDefined();
  });

  it("rejects plan and Doctor retention evidence that differs from settings", async () => {
    const mismatchedPlan = Object.freeze({
      planEvidence: Object.freeze({
        ...planEvidence,
        retentionPolicy: Object.freeze({
          ...planEvidence.retentionPolicy,
          maximumTraceCount: settings.maximumTraceCount + 1,
        }),
      }),
      resourceSelector: "2".repeat(32),
      selectedBackupAuthority: null,
    });
    await expect(
      inspectLocalResourceMaintenancePlan(
        registryWith(maintenancePort([], { inspectedPlan: mismatchedPlan })),
        context("backup"),
      ),
    ).rejects.toBeDefined();
    const inspection = doctorInspection();
    const mismatchedDoctor = Object.freeze({
      ...inspection,
      retentionPolicy: Object.freeze({
        ...inspection.retentionPolicy,
        maximumPayloadBytes: settings.maximumPayloadBytes + 1,
      }),
    });
    const value = context("backup");
    const doctor = bindLocalResourceDoctorContextForTesting({
      destinationType: value.destinationType,
      connectionId: value.connectionId,
      connectionName: value.connectionName,
      settings,
      configurationGeneration: value.configurationGeneration,
      configurationDigest: value.configurationDigest,
      signal: value.signal,
      deadline: createLocalResourceLifecycleDeadlineForTesting(10_000),
    });
    await expect(
      inspectLocalResourceDoctor(
        registryWith(maintenancePort([], { doctor: mismatchedDoctor })),
        doctor,
      ),
    ).rejects.toBeDefined();
  });
});
