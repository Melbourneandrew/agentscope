import { createHash } from "node:crypto";

import type {
  LocalResourceBackupAuthority,
  LocalResourceDoctorContext,
  LocalResourceDoctorInspection,
  LocalResourceMaintenanceContext,
  LocalResourceMaintenancePlanEvidence,
  LocalResourceMaintenanceRecoveryContext,
  LocalResourceMaintenanceResult,
} from "@agentscope/destinations-core";

import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  localSqliteLifecycleArtifactGrammarFingerprintForTesting,
} from "./capability.js";
import type { LocalSqliteExclusiveFenceAuthority } from "./fence.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";

export type LocalSqliteMaintenanceIntent = Readonly<{
  recordVersion: 1;
  operation: "backup" | "restore";
  transactionId: string;
  backupId: string;
  destinationType: typeof LOCAL_SQLITE_DESTINATION_TYPE;
  connectionId: string;
  connectionDigest: string;
  owner: Readonly<{
    processId: number;
    processStartIdentity: string;
  }>;
  namespaceFingerprint: string;
  physicalEvidenceFingerprint: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  artifactGrammarFingerprint: string;
  artifactGrammarVersion: 1;
  capabilityVersion: 1;
  destinationFormat: string;
  migrationManifestId: string;
  protocolCompatibilityId: string;
  configurationGeneration: number;
  configurationDigest: string;
  maximumAgeNanoseconds: string;
  maximumTraceCount: number;
  maximumPayloadBytes: number;
  selectedReceiptDigest: string | null;
  selectedSnapshotPhysicalIdentity: string | null;
}>;

export type LocalSqliteBackupReceipt = Readonly<{
  recordVersion: 1;
  backupId: string;
  destinationType: typeof LOCAL_SQLITE_DESTINATION_TYPE;
  connectionId: string;
  connectionDigest: string;
  namespaceFingerprint: string;
  physicalEvidenceFingerprint: string;
  snapshotPhysicalIdentity: string;
  snapshotBytes: number;
  destinationFormat: string;
  migrationManifestId: string;
  protocolCompatibilityId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  capabilityVersion: 1;
  artifactGrammarVersion: 1;
  artifactGrammarFingerprint: string;
  configurationGeneration: number;
  configurationDigest: string;
  transactionId: string;
}>;

export type LocalSqliteBackupInventoryEntry = Readonly<{
  role:
    | "published-snapshot"
    | "backup-receipt"
    | "database-candidate"
    | "rollback-preimage"
    | "lifecycle-metadata";
  artifactId: string;
  physicalIdentity: string;
  bytes: number;
  sparse: boolean;
}>;

export type LocalSqliteBackupInventoryEvidence = Readonly<{
  entries: readonly LocalSqliteBackupInventoryEntry[];
  hasCapacity: boolean;
}>;

export type LocalSqliteVerifiedSnapshotEvidence = Readonly<{
  snapshotPhysicalIdentity: string;
  snapshotBytes: number;
  destinationFormat: string;
  lifecycleCapabilityVersion: 1;
  lifecycleFingerprint: string;
  migrationManifestId: string;
  protocolCompatibilityId: string;
  recoveryHandlerId: string;
}>;

export type LocalSqliteMaintenanceRecoveryPhase =
  | "intent-only"
  | "backup-candidate"
  | "backup-published"
  | "restore-candidate"
  | "restore-replaced"
  | "restore-rolled-back"
  | "restore-verified";

export type LocalSqliteMaintenancePort = Readonly<{
  inspectMaintenance(
    context: LocalResourceMaintenanceContext,
  ): Promise<LocalResourceMaintenancePlanEvidence>;
  publishMaintenanceIntent(
    intent: LocalSqliteMaintenanceIntent,
    canonicalBytes: string,
    signal: AbortSignal,
  ): Promise<void>;
  acquireExclusiveFence(
    intent: LocalSqliteMaintenanceIntent,
    signal: AbortSignal,
  ): Promise<LocalSqliteExclusiveFenceAuthority>;
  revalidatePhysicalEvidence(
    intent: LocalSqliteMaintenanceIntent,
    evidence: LocalResourceMaintenancePlanEvidence,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  inspectBackupInventory(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<LocalSqliteBackupInventoryEvidence>;
  cleanupRetention(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  createBackupCandidate(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  verifyBackupCandidate(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<LocalSqliteVerifiedSnapshotEvidence>;
  publishBackup(
    intent: LocalSqliteMaintenanceIntent,
    receipt: LocalSqliteBackupReceipt,
    canonicalReceipt: string,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  readPublishedBackupReceipt(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<string>;
  verifyPublishedBackup(
    intent: LocalSqliteMaintenanceIntent,
    receipt: LocalSqliteBackupReceipt,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<LocalSqliteVerifiedSnapshotEvidence>;
  readSelectedBackupReceipt(
    intent: LocalSqliteMaintenanceIntent,
    authority: LocalResourceBackupAuthority,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<string>;
  createRestoreCandidate(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  verifyRestoreCandidate(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  enforceRestoreRetention(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  replaceActiveWithRestoreCandidate(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  verifyRestoredActive(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<boolean>;
  rollbackRestoredActive(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  verifyRolledBackActive(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  removeRollbackPreimage(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  claimMaintenanceIntent(
    context: LocalResourceMaintenanceRecoveryContext,
  ): Promise<
    Readonly<{
      canonicalBytes: string;
      fence: LocalSqliteExclusiveFenceAuthority;
    }>
  >;
  inspectRecoveryPhase(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<LocalSqliteMaintenanceRecoveryPhase>;
  rollbackPreparedMaintenance(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  finalizeMaintenance(
    intent: LocalSqliteMaintenanceIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  completeMaintenanceFinalization(
    operationId: string,
    signal: AbortSignal,
  ): Promise<void>;
  inspectDoctor(
    context: LocalResourceDoctorContext,
  ): Promise<LocalResourceDoctorInspection>;
}>;

const intents = new WeakSet<object>();
const receipts = new WeakSet<object>();

export class LocalSqliteMaintenanceError extends Error {
  public constructor(
    public readonly code:
      | "busy"
      | "capacity"
      | "outcome-unknown"
      | "reconciliation-required"
      | "unavailable",
  ) {
    super(`destination.local-sqlite.maintenance-${code}`);
    this.name = "LocalSqliteMaintenanceError";
  }
}

const connectionDigest = (connectionId: string): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        connectionId,
        destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      }),
    )
    .digest("hex");

const active = (signal: AbortSignal): void => {
  if (signal.aborted) throw new LocalSqliteMaintenanceError("unavailable");
};

const exactIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 192 &&
  /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(value);

const exactDigest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256-[0-9a-f]{64}$/u.test(value);

const intentFor = (
  context: LocalResourceMaintenanceContext,
  evidence: LocalResourceMaintenancePlanEvidence,
  lifecycleFingerprint: string,
  recoveryHandlerId: string,
  artifactGrammarFingerprint: string,
): LocalSqliteMaintenanceIntent => {
  const selected = evidence.selectedBackupAuthority;
  const intent = Object.freeze({
    recordVersion: 1 as const,
    operation: context.operation,
    transactionId: context.operationId,
    backupId: context.resourceSelector,
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    connectionId: context.connectionId,
    connectionDigest: connectionDigest(context.connectionId),
    owner: Object.freeze({ ...context.owner }),
    namespaceFingerprint: evidence.planEvidence.namespaceFingerprint,
    physicalEvidenceFingerprint:
      evidence.planEvidence.physicalEvidenceFingerprint,
    lifecycleFingerprint,
    recoveryHandlerId,
    artifactGrammarFingerprint,
    artifactGrammarVersion: 1 as const,
    capabilityVersion: 1 as const,
    destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
    migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
    protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    configurationGeneration: context.configurationGeneration,
    configurationDigest: context.configurationDigest,
    maximumAgeNanoseconds:
      evidence.planEvidence.retentionPolicy.maximumAgeNanoseconds,
    maximumTraceCount: evidence.planEvidence.retentionPolicy.maximumTraceCount,
    maximumPayloadBytes:
      evidence.planEvidence.retentionPolicy.maximumPayloadBytes,
    selectedReceiptDigest: selected?.receiptDigest ?? null,
    selectedSnapshotPhysicalIdentity:
      selected?.snapshotPhysicalIdentity ?? null,
  });
  intents.add(intent);
  return intent;
};

const canonicalIntentKeys = Object.freeze([
  "artifactGrammarFingerprint",
  "artifactGrammarVersion",
  "backupId",
  "capabilityVersion",
  "configurationDigest",
  "configurationGeneration",
  "connectionDigest",
  "connectionId",
  "destinationFormat",
  "destinationType",
  "lifecycleFingerprint",
  "maximumAgeNanoseconds",
  "maximumPayloadBytes",
  "maximumTraceCount",
  "migrationManifestId",
  "namespaceFingerprint",
  "operation",
  "owner",
  "physicalEvidenceFingerprint",
  "protocolCompatibilityId",
  "recordVersion",
  "recoveryHandlerId",
  "selectedReceiptDigest",
  "selectedSnapshotPhysicalIdentity",
  "transactionId",
]);

export const decodeLocalSqliteMaintenanceIntent = (
  bytes: unknown,
  artifactGrammarFingerprint: string = LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  // eslint-disable-next-line complexity -- one closed canonical persisted-record grammar is validated atomically.
): LocalSqliteMaintenanceIntent | undefined => {
  if (
    typeof bytes !== "string" ||
    Buffer.byteLength(bytes, "utf8") > 12_288 ||
    !bytes.endsWith("\n")
  )
    return undefined;
  try {
    const value: unknown = JSON.parse(bytes);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== canonicalIntentKeys.length ||
      canonicalIntentKeys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !("value" in descriptor);
      })
    )
      return undefined;
    const record = value as Record<string, unknown>;
    const owner = record.owner as Record<string, unknown> | null;
    const ownerDescriptors =
      typeof owner === "object" && owner !== null
        ? Object.getOwnPropertyDescriptors(owner)
        : {};
    const selectedReceiptDigest = record.selectedReceiptDigest;
    const selectedIdentity = record.selectedSnapshotPhysicalIdentity;
    if (
      record.recordVersion !== 1 ||
      !["backup", "restore"].includes(record.operation as string) ||
      typeof record.transactionId !== "string" ||
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.transactionId) ||
      typeof record.backupId !== "string" ||
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.backupId) ||
      record.destinationType !== LOCAL_SQLITE_DESTINATION_TYPE ||
      typeof record.connectionId !== "string" ||
      !/^destination-connection-v1-[0-9a-f]{64}$/u.test(record.connectionId) ||
      record.connectionDigest !== connectionDigest(record.connectionId) ||
      typeof owner !== "object" ||
      owner === null ||
      Object.keys(ownerDescriptors).sort().join(",") !==
        "processId,processStartIdentity" ||
      Reflect.ownKeys(ownerDescriptors).length !== 2 ||
      Object.values(ownerDescriptors).some(
        (descriptor) => !("value" in descriptor),
      ) ||
      !Number.isSafeInteger(owner.processId) ||
      (owner.processId as number) < 1 ||
      typeof owner.processStartIdentity !== "string" ||
      !/^process-start-v1-[0-9a-f]{64}$/u.test(owner.processStartIdentity) ||
      !exactDigest(record.namespaceFingerprint) ||
      !exactDigest(record.physicalEvidenceFingerprint) ||
      !exactDigest(record.lifecycleFingerprint) ||
      typeof record.recoveryHandlerId !== "string" ||
      record.recoveryHandlerId.length < 1 ||
      record.recoveryHandlerId.length > 256 ||
      record.artifactGrammarFingerprint !== artifactGrammarFingerprint ||
      record.artifactGrammarVersion !== 1 ||
      record.capabilityVersion !== 1 ||
      record.destinationFormat !== LOCAL_SQLITE_DESTINATION_FORMAT ||
      record.migrationManifestId !== LOCAL_SQLITE_MIGRATION_MANIFEST_ID ||
      record.protocolCompatibilityId !==
        LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID ||
      !Number.isSafeInteger(record.configurationGeneration) ||
      (record.configurationGeneration as number) < 0 ||
      !exactDigest(record.configurationDigest) ||
      typeof record.maximumAgeNanoseconds !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(record.maximumAgeNanoseconds) ||
      !Number.isSafeInteger(record.maximumTraceCount) ||
      (record.maximumTraceCount as number) < 1 ||
      !Number.isSafeInteger(record.maximumPayloadBytes) ||
      (record.maximumPayloadBytes as number) < 1 ||
      !(
        (record.operation === "backup" &&
          selectedReceiptDigest === null &&
          selectedIdentity === null) ||
        (record.operation === "restore" &&
          exactDigest(selectedReceiptDigest) &&
          exactIdentity(selectedIdentity))
      ) ||
      `${JSON.stringify(value)}\n` !== bytes
    )
      return undefined;
    const intent = Object.freeze(value) as LocalSqliteMaintenanceIntent;
    intents.add(intent);
    return intent;
  } catch {
    return undefined;
  }
};

export const encodeLocalSqliteMaintenanceIntent = (
  intent: LocalSqliteMaintenanceIntent,
): string => {
  if (!intents.has(intent))
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  return `${JSON.stringify(intent)}\n`;
};

const receiptFor = (
  intent: LocalSqliteMaintenanceIntent,
  evidence: LocalSqliteVerifiedSnapshotEvidence,
  maximumSnapshotBytes: number,
): LocalSqliteBackupReceipt => {
  if (
    !exactIdentity(evidence.snapshotPhysicalIdentity) ||
    !Number.isSafeInteger(evidence.snapshotBytes) ||
    evidence.snapshotBytes < 1 ||
    evidence.snapshotBytes > maximumSnapshotBytes ||
    evidence.destinationFormat !== intent.destinationFormat ||
    evidence.lifecycleCapabilityVersion !== intent.capabilityVersion ||
    evidence.lifecycleFingerprint !== intent.lifecycleFingerprint ||
    evidence.migrationManifestId !== intent.migrationManifestId ||
    evidence.protocolCompatibilityId !== intent.protocolCompatibilityId ||
    evidence.recoveryHandlerId !== intent.recoveryHandlerId
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const receipt = Object.freeze({
    recordVersion: 1 as const,
    backupId: intent.backupId,
    destinationType: intent.destinationType,
    connectionId: intent.connectionId,
    connectionDigest: intent.connectionDigest,
    namespaceFingerprint: intent.namespaceFingerprint,
    physicalEvidenceFingerprint: intent.physicalEvidenceFingerprint,
    snapshotPhysicalIdentity: evidence.snapshotPhysicalIdentity,
    snapshotBytes: evidence.snapshotBytes,
    destinationFormat: intent.destinationFormat,
    migrationManifestId: intent.migrationManifestId,
    protocolCompatibilityId: intent.protocolCompatibilityId,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    recoveryHandlerId: intent.recoveryHandlerId,
    capabilityVersion: 1 as const,
    artifactGrammarVersion: 1 as const,
    artifactGrammarFingerprint: intent.artifactGrammarFingerprint,
    configurationGeneration: intent.configurationGeneration,
    configurationDigest: intent.configurationDigest,
    transactionId: intent.transactionId,
  });
  receipts.add(receipt);
  return receipt;
};

export const encodeLocalSqliteBackupReceipt = (
  receipt: LocalSqliteBackupReceipt,
): string => {
  if (!receipts.has(receipt))
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  return `${JSON.stringify(receipt)}\n`;
};

const receiptKeys = Object.freeze([
  "artifactGrammarFingerprint",
  "artifactGrammarVersion",
  "backupId",
  "capabilityVersion",
  "configurationDigest",
  "configurationGeneration",
  "connectionDigest",
  "connectionId",
  "destinationFormat",
  "destinationType",
  "lifecycleFingerprint",
  "migrationManifestId",
  "namespaceFingerprint",
  "physicalEvidenceFingerprint",
  "protocolCompatibilityId",
  "recordVersion",
  "recoveryHandlerId",
  "snapshotBytes",
  "snapshotPhysicalIdentity",
  "transactionId",
]);

export const decodeLocalSqliteBackupReceipt = (
  bytes: unknown,
  maximumSnapshotBytes = 0,
  artifactGrammarFingerprint: string = LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  // eslint-disable-next-line complexity -- one closed canonical persisted-record grammar is validated atomically.
): LocalSqliteBackupReceipt | undefined => {
  if (
    typeof bytes !== "string" ||
    Buffer.byteLength(bytes, "utf8") > 8_192 ||
    !bytes.endsWith("\n")
  )
    return undefined;
  try {
    const value: unknown = JSON.parse(bytes);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== receiptKeys.length ||
      receiptKeys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor || !("value" in descriptor);
      })
    )
      return undefined;
    const record = value as Record<string, unknown>;
    if (
      record.recordVersion !== 1 ||
      typeof record.backupId !== "string" ||
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.backupId) ||
      record.destinationType !== LOCAL_SQLITE_DESTINATION_TYPE ||
      typeof record.connectionId !== "string" ||
      !/^destination-connection-v1-[0-9a-f]{64}$/u.test(record.connectionId) ||
      record.connectionDigest !== connectionDigest(record.connectionId) ||
      !exactDigest(record.namespaceFingerprint) ||
      !exactDigest(record.physicalEvidenceFingerprint) ||
      !exactIdentity(record.snapshotPhysicalIdentity) ||
      !Number.isSafeInteger(record.snapshotBytes) ||
      (record.snapshotBytes as number) < 1 ||
      (record.snapshotBytes as number) > maximumSnapshotBytes ||
      record.destinationFormat !== LOCAL_SQLITE_DESTINATION_FORMAT ||
      record.migrationManifestId !== LOCAL_SQLITE_MIGRATION_MANIFEST_ID ||
      record.protocolCompatibilityId !==
        LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID ||
      !exactDigest(record.lifecycleFingerprint) ||
      typeof record.recoveryHandlerId !== "string" ||
      record.recoveryHandlerId.length < 1 ||
      record.recoveryHandlerId.length > 256 ||
      record.capabilityVersion !== 1 ||
      record.artifactGrammarVersion !== 1 ||
      record.artifactGrammarFingerprint !== artifactGrammarFingerprint ||
      !Number.isSafeInteger(record.configurationGeneration) ||
      (record.configurationGeneration as number) < 0 ||
      !exactDigest(record.configurationDigest) ||
      typeof record.transactionId !== "string" ||
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.transactionId) ||
      `${JSON.stringify(value)}\n` !== bytes
    )
      return undefined;
    const receipt = Object.freeze(value) as LocalSqliteBackupReceipt;
    receipts.add(receipt);
    return receipt;
  } catch {
    return undefined;
  }
};

const authorityFor = (
  receipt: LocalSqliteBackupReceipt,
  canonicalReceipt: string,
): LocalResourceBackupAuthority =>
  Object.freeze({
    backupId: receipt.backupId,
    receiptDigest: `sha256-${createHash("sha256").update(canonicalReceipt).digest("hex")}`,
    snapshotPhysicalIdentity: receipt.snapshotPhysicalIdentity,
  });

const receiptMatchesIntent = (
  receipt: LocalSqliteBackupReceipt,
  intent: LocalSqliteMaintenanceIntent,
): boolean =>
  JSON.stringify([
    receipt.connectionId,
    receipt.connectionDigest,
    receipt.namespaceFingerprint,
    receipt.physicalEvidenceFingerprint,
    receipt.lifecycleFingerprint,
    receipt.recoveryHandlerId,
    receipt.capabilityVersion,
    receipt.artifactGrammarVersion,
    receipt.artifactGrammarFingerprint,
    receipt.destinationFormat,
    receipt.migrationManifestId,
    receipt.protocolCompatibilityId,
  ]) ===
  JSON.stringify([
    intent.connectionId,
    intent.connectionDigest,
    intent.namespaceFingerprint,
    intent.physicalEvidenceFingerprint,
    intent.lifecycleFingerprint,
    intent.recoveryHandlerId,
    intent.capabilityVersion,
    intent.artifactGrammarVersion,
    intent.artifactGrammarFingerprint,
    intent.destinationFormat,
    intent.migrationManifestId,
    intent.protocolCompatibilityId,
  ]);

type InventorySummary = Readonly<{
  backupDirectoryEntries: number;
  metadataBytes: number;
  publishedBytes: number;
  publishedCount: number;
}>;

const validateInventory = (
  evidence: LocalSqliteBackupInventoryEvidence,
  requirements: Readonly<{
    requireCapacity: boolean;
    maximumSnapshotBytes: number;
    requiredCandidateCount?: number;
    requiredPreimageCount?: number;
    requiredCandidateId?: string;
  }>,
  // eslint-disable-next-line max-lines-per-function, complexity -- one bounded all-artifact inventory and its checked arithmetic are one fail-closed authority.
): InventorySummary => {
  const {
    requireCapacity,
    maximumSnapshotBytes,
    requiredCandidateCount = 0,
    requiredPreimageCount = 0,
    requiredCandidateId,
  } = requirements;
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Object.getPrototypeOf(evidence) !== Object.prototype
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const descriptors = Object.getOwnPropertyDescriptors(evidence);
  const keys = ["entries", "hasCapacity"];
  if (
    Object.keys(descriptors).sort().join(",") !== keys.sort().join(",") ||
    Reflect.ownKeys(descriptors).length !== keys.length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const entries = descriptors.entries?.value as unknown;
  if (
    !Array.isArray(entries) ||
    entries.length > 128 ||
    Reflect.ownKeys(entries).length !== entries.length + 1 ||
    typeof descriptors.hasCapacity?.value !== "boolean"
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const roles = new Set([
    "published-snapshot",
    "backup-receipt",
    "database-candidate",
    "rollback-preimage",
    "lifecycle-metadata",
  ]);
  const physicalIdentities = new Set<string>();
  const publishedIds = new Set<string>();
  const receiptIds = new Set<string>();
  let publishedBytes = 0;
  let metadataBytes = 0;
  let backupDirectoryEntries = 0;
  let candidateCount = 0;
  let candidateId: string | undefined;
  let preimageCount = 0;
  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const entryDescriptors = Object.getOwnPropertyDescriptors(entry);
    const entryKeys = [
      "artifactId",
      "bytes",
      "physicalIdentity",
      "role",
      "sparse",
    ];
    if (
      Reflect.ownKeys(entryDescriptors).length !== entryKeys.length ||
      entryKeys.some((key) => !(key in entryDescriptors)) ||
      Object.values(entryDescriptors).some(
        (descriptor) => !("value" in descriptor),
      )
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const record = entry as Record<string, unknown>;
    if (
      typeof record.role !== "string" ||
      !roles.has(record.role) ||
      !exactIdentity(record.artifactId) ||
      !exactIdentity(record.physicalIdentity) ||
      physicalIdentities.has(record.physicalIdentity) ||
      !Number.isSafeInteger(record.bytes) ||
      (record.bytes as number) < 0 ||
      record.sparse !== false
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    physicalIdentities.add(record.physicalIdentity);
    const bytes = record.bytes as number;
    if (
      record.role !== "lifecycle-metadata" &&
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.artifactId)
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    if (
      (record.role === "published-snapshot" ||
        record.role === "database-candidate" ||
        record.role === "rollback-preimage") &&
      bytes > maximumSnapshotBytes
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    if (record.role === "published-snapshot") {
      if (publishedIds.has(record.artifactId))
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      publishedIds.add(record.artifactId);
      publishedBytes += bytes;
      backupDirectoryEntries += 1;
    } else if (record.role === "backup-receipt") {
      if (receiptIds.has(record.artifactId))
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      receiptIds.add(record.artifactId);
      metadataBytes += bytes;
      backupDirectoryEntries += 1;
    } else if (record.role === "database-candidate") {
      candidateCount += 1;
      candidateId = record.artifactId;
    } else if (record.role === "rollback-preimage") {
      preimageCount += 1;
    } else {
      metadataBytes += bytes;
    }
    if (!Number.isSafeInteger(publishedBytes + metadataBytes))
      throw new LocalSqliteMaintenanceError("reconciliation-required");
  }
  if (
    publishedIds.size > 8 ||
    backupDirectoryEntries > 32 ||
    publishedBytes > 8 * maximumSnapshotBytes ||
    metadataBytes > 65_536 ||
    candidateCount !== requiredCandidateCount ||
    preimageCount !== requiredPreimageCount ||
    (requiredCandidateId !== undefined &&
      candidateId !== requiredCandidateId) ||
    publishedIds.size !== receiptIds.size ||
    [...publishedIds].some((id) => !receiptIds.has(id))
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  if (requireCapacity && descriptors.hasCapacity?.value !== true)
    throw new LocalSqliteMaintenanceError("capacity");
  if (
    requireCapacity &&
    (publishedIds.size >= 8 || backupDirectoryEntries > 30)
  )
    throw new LocalSqliteMaintenanceError("capacity");
  return Object.freeze({
    backupDirectoryEntries,
    metadataBytes,
    publishedBytes,
    publishedCount: publishedIds.size,
  });
};

const provePublicationCapacity = (
  summary: InventorySummary,
  snapshotBytes: number,
  canonicalReceipt: string,
  maximumSnapshotBytes: number,
): void => {
  const receiptBytes = Buffer.byteLength(canonicalReceipt, "utf8");
  if (
    summary.publishedCount + 1 > 8 ||
    summary.backupDirectoryEntries + 2 > 32 ||
    summary.publishedBytes + snapshotBytes > 8 * maximumSnapshotBytes ||
    summary.metadataBytes + receiptBytes > 65_536 ||
    !Number.isSafeInteger(summary.publishedBytes + snapshotBytes) ||
    !Number.isSafeInteger(summary.metadataBytes + receiptBytes)
  )
    throw new LocalSqliteMaintenanceError("capacity");
};

const failed = (error: unknown): LocalResourceMaintenanceResult => {
  const code =
    error instanceof LocalSqliteMaintenanceError
      ? error.code
      : "outcome-unknown";
  return Object.freeze({
    ok: false,
    state:
      code === "reconciliation-required"
        ? "reconciliation-required"
        : "prepared",
    code,
  });
};

/* eslint-disable max-params -- publication and restore keep the exact fence, cancellation, inventory, and manifest authorities separate. */
const publishBackup = async (
  port: LocalSqliteMaintenancePort,
  intent: LocalSqliteMaintenanceIntent,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
  inventory: InventorySummary,
  maximumSnapshotBytes: number,
): Promise<LocalResourceMaintenanceResult> => {
  await port.cleanupRetention(intent, fence, signal);
  active(signal);
  await port.createBackupCandidate(intent, fence, signal);
  active(signal);
  const verified = await port.verifyBackupCandidate(intent, fence, signal);
  active(signal);
  const receipt = receiptFor(intent, verified, maximumSnapshotBytes);
  const canonicalReceipt = encodeLocalSqliteBackupReceipt(receipt);
  provePublicationCapacity(
    inventory,
    verified.snapshotBytes,
    canonicalReceipt,
    maximumSnapshotBytes,
  );
  await port.publishBackup(intent, receipt, canonicalReceipt, fence, signal);
  active(signal);
  return Object.freeze({
    ok: true,
    state: "backed-up",
    backupAuthority: authorityFor(receipt, canonicalReceipt),
  });
};

const publishExistingBackupCandidate = async (
  port: LocalSqliteMaintenancePort,
  intent: LocalSqliteMaintenanceIntent,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
  inventory: InventorySummary,
  maximumSnapshotBytes: number,
): Promise<LocalResourceMaintenanceResult> => {
  const verified = await port.verifyBackupCandidate(intent, fence, signal);
  active(signal);
  const receipt = receiptFor(intent, verified, maximumSnapshotBytes);
  const canonicalReceipt = encodeLocalSqliteBackupReceipt(receipt);
  provePublicationCapacity(
    inventory,
    verified.snapshotBytes,
    canonicalReceipt,
    maximumSnapshotBytes,
  );
  await port.publishBackup(intent, receipt, canonicalReceipt, fence, signal);
  active(signal);
  return Object.freeze({
    ok: true,
    state: "backed-up",
    backupAuthority: authorityFor(receipt, canonicalReceipt),
  });
};

const finishRestoreReplacement = async (
  port: LocalSqliteMaintenancePort,
  intent: LocalSqliteMaintenanceIntent,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
): Promise<LocalResourceMaintenanceResult> => {
  const verified = await port.verifyRestoredActive(intent, fence, signal);
  if (typeof verified !== "boolean")
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  active(signal);
  if (!verified) {
    await port.rollbackRestoredActive(intent, fence, signal);
    active(signal);
    await port.verifyRolledBackActive(intent, fence, signal);
    active(signal);
    throw new LocalSqliteMaintenanceError("unavailable");
  }
  await port.removeRollbackPreimage(intent, fence, signal);
  active(signal);
  return Object.freeze({ ok: true, state: "restored" });
};

const replaceVerifiedRestoreCandidate = async (
  port: LocalSqliteMaintenancePort,
  intent: LocalSqliteMaintenanceIntent,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
): Promise<LocalResourceMaintenanceResult> => {
  await port.verifyRestoreCandidate(intent, fence, signal);
  active(signal);
  await port.enforceRestoreRetention(intent, fence, signal);
  active(signal);
  await port.verifyRestoreCandidate(intent, fence, signal);
  active(signal);
  await port.replaceActiveWithRestoreCandidate(intent, fence, signal);
  active(signal);
  return finishRestoreReplacement(port, intent, fence, signal);
};

const restore = async (
  port: LocalSqliteMaintenancePort,
  intent: LocalSqliteMaintenanceIntent,
  authority: LocalResourceBackupAuthority,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
  maximumSnapshotBytes: number,
  artifactGrammarFingerprint: string,
): Promise<LocalResourceMaintenanceResult> => {
  const canonicalReceipt = await port.readSelectedBackupReceipt(
    intent,
    authority,
    fence,
    signal,
  );
  const receipt = decodeLocalSqliteBackupReceipt(
    canonicalReceipt,
    maximumSnapshotBytes,
    artifactGrammarFingerprint,
  );
  if (
    !receipt ||
    `sha256-${createHash("sha256").update(canonicalReceipt).digest("hex")}` !==
      authority.receiptDigest ||
    receipt.backupId !== authority.backupId ||
    receipt.snapshotPhysicalIdentity !== authority.snapshotPhysicalIdentity ||
    !receiptMatchesIntent(receipt, intent)
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  active(signal);
  await port.createRestoreCandidate(intent, fence, signal);
  active(signal);
  return replaceVerifiedRestoreCandidate(port, intent, fence, signal);
};
/* eslint-enable max-params */

export const applyLocalSqliteMaintenance = async (
  lifecycleFingerprint: string,
  recoveryHandlerId: string,
  maximumSnapshotBytes: number,
  port: LocalSqliteMaintenancePort,
  context: LocalResourceMaintenanceContext &
    Readonly<{ planEvidence: LocalResourceMaintenancePlanEvidence }>,
): Promise<LocalResourceMaintenanceResult> => {
  const artifactGrammarFingerprint =
    localSqliteLifecycleArtifactGrammarFingerprintForTesting(
      maximumSnapshotBytes,
    );
  const intent = intentFor(
    context,
    context.planEvidence,
    lifecycleFingerprint,
    recoveryHandlerId,
    artifactGrammarFingerprint,
  );
  try {
    await port.publishMaintenanceIntent(
      intent,
      encodeLocalSqliteMaintenanceIntent(intent),
      context.signal,
    );
    active(context.signal);
    const fence = await port.acquireExclusiveFence(intent, context.signal);
    active(context.signal);
    await port.revalidatePhysicalEvidence(
      intent,
      context.planEvidence,
      fence,
      context.signal,
    );
    active(context.signal);
    const inventory = await port.inspectBackupInventory(
      intent,
      fence,
      context.signal,
    );
    const inventorySummary = validateInventory(inventory, {
      requireCapacity: context.operation === "backup",
      maximumSnapshotBytes,
    });
    active(context.signal);
    const result =
      context.operation === "backup"
        ? await publishBackup(
            port,
            intent,
            fence,
            context.signal,
            inventorySummary,
            maximumSnapshotBytes,
          )
        : await restore(
            port,
            intent,
            context.planEvidence.selectedBackupAuthority!,
            fence,
            context.signal,
            maximumSnapshotBytes,
            artifactGrammarFingerprint,
          );
    await port.finalizeMaintenance(intent, fence, context.signal);
    active(context.signal);
    return result;
  } catch (error) {
    return failed(error);
  }
};

const recoveryMatches = (
  context: LocalResourceMaintenanceRecoveryContext,
  intent: LocalSqliteMaintenanceIntent,
  lifecycleFingerprint: string,
  recoveryHandlerId: string,
): boolean =>
  intent.operation === context.operation &&
  intent.transactionId === context.operationId &&
  intent.backupId === context.resourceSelector &&
  intent.destinationType === context.destinationType &&
  intent.connectionId === context.connectionId &&
  intent.lifecycleFingerprint === lifecycleFingerprint &&
  intent.recoveryHandlerId === recoveryHandlerId &&
  intent.configurationGeneration === context.configurationGeneration &&
  intent.configurationDigest === context.configurationDigest;

type RecoveryOperation = Readonly<{
  port: LocalSqliteMaintenancePort;
  intent: LocalSqliteMaintenanceIntent;
  fence: LocalSqliteExclusiveFenceAuthority;
  signal: AbortSignal;
  maximumSnapshotBytes: number;
  artifactGrammarFingerprint: string;
}>;

const recoverPublishedBackup = async ({
  port,
  intent,
  fence,
  signal,
  maximumSnapshotBytes,
  artifactGrammarFingerprint,
}: RecoveryOperation): Promise<LocalResourceMaintenanceResult> => {
  const canonicalReceipt = await port.readPublishedBackupReceipt(
    intent,
    fence,
    signal,
  );
  const receipt = decodeLocalSqliteBackupReceipt(
    canonicalReceipt,
    maximumSnapshotBytes,
    artifactGrammarFingerprint,
  );
  if (
    !receipt ||
    receipt.backupId !== intent.backupId ||
    receipt.transactionId !== intent.transactionId ||
    !receiptMatchesIntent(receipt, intent) ||
    receipt.configurationGeneration !== intent.configurationGeneration ||
    receipt.configurationDigest !== intent.configurationDigest
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const verified = await port.verifyPublishedBackup(
    intent,
    receipt,
    fence,
    signal,
  );
  const expectedReceipt = receiptFor(intent, verified, maximumSnapshotBytes);
  if (
    expectedReceipt.snapshotPhysicalIdentity !==
      receipt.snapshotPhysicalIdentity ||
    expectedReceipt.snapshotBytes !== receipt.snapshotBytes ||
    expectedReceipt.destinationFormat !== receipt.destinationFormat ||
    expectedReceipt.migrationManifestId !== receipt.migrationManifestId ||
    expectedReceipt.protocolCompatibilityId !== receipt.protocolCompatibilityId
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  active(signal);
  return Object.freeze({
    ok: true,
    state: "backed-up",
    backupAuthority: authorityFor(receipt, canonicalReceipt),
  });
};

const recoverBackup = async (
  operation: RecoveryOperation,
  phase: LocalSqliteMaintenanceRecoveryPhase,
): Promise<LocalResourceMaintenanceResult> => {
  const {
    port,
    intent,
    fence,
    signal,
    maximumSnapshotBytes,
    artifactGrammarFingerprint,
  } = operation;
  if (phase === "backup-published")
    return recoverPublishedBackup({
      port,
      intent,
      fence,
      signal,
      maximumSnapshotBytes,
      artifactGrammarFingerprint,
    });
  if (phase !== "backup-candidate")
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const inventory = validateInventory(
    await port.inspectBackupInventory(intent, fence, signal),
    {
      requireCapacity: true,
      maximumSnapshotBytes,
      requiredCandidateCount: 1,
      requiredCandidateId: intent.backupId,
    },
  );
  return publishExistingBackupCandidate(
    port,
    intent,
    fence,
    signal,
    inventory,
    maximumSnapshotBytes,
  );
};

const recoverRestore = async (
  port: LocalSqliteMaintenancePort,
  intent: LocalSqliteMaintenanceIntent,
  phase: LocalSqliteMaintenanceRecoveryPhase,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
): Promise<LocalResourceMaintenanceResult> => {
  if (phase === "restore-rolled-back") {
    await port.verifyRolledBackActive(intent, fence, signal);
    active(signal);
    return Object.freeze({ ok: true, state: "rolled-back" });
  }
  if (phase === "restore-verified" || phase === "restore-replaced")
    return finishRestoreReplacement(port, intent, fence, signal);
  if (phase === "restore-candidate")
    return replaceVerifiedRestoreCandidate(port, intent, fence, signal);
  throw new LocalSqliteMaintenanceError("reconciliation-required");
};

export const recoverLocalSqliteMaintenance = async (
  lifecycleFingerprint: string,
  recoveryHandlerId: string,
  maximumSnapshotBytes: number,
  port: LocalSqliteMaintenancePort,
  context: LocalResourceMaintenanceRecoveryContext,
): Promise<LocalResourceMaintenanceResult> => {
  try {
    const artifactGrammarFingerprint =
      localSqliteLifecycleArtifactGrammarFingerprintForTesting(
        maximumSnapshotBytes,
      );
    const claimed = await port.claimMaintenanceIntent(context);
    active(context.signal);
    const intent = decodeLocalSqliteMaintenanceIntent(
      claimed.canonicalBytes,
      artifactGrammarFingerprint,
    );
    if (
      !intent ||
      !recoveryMatches(context, intent, lifecycleFingerprint, recoveryHandlerId)
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const phase = await port.inspectRecoveryPhase(
      intent,
      claimed.fence,
      context.signal,
    );
    active(context.signal);
    let result: LocalResourceMaintenanceResult;
    if (phase === "intent-only") {
      await port.rollbackPreparedMaintenance(
        intent,
        claimed.fence,
        context.signal,
      );
      result = Object.freeze({ ok: true, state: "rolled-back" });
    } else if (intent.operation === "backup")
      result = await recoverBackup(
        {
          port,
          intent,
          fence: claimed.fence,
          signal: context.signal,
          maximumSnapshotBytes,
          artifactGrammarFingerprint,
        },
        phase,
      );
    else
      result = await recoverRestore(
        port,
        intent,
        phase,
        claimed.fence,
        context.signal,
      );
    active(context.signal);
    await port.finalizeMaintenance(intent, claimed.fence, context.signal);
    active(context.signal);
    return result;
  } catch (error) {
    return failed(error);
  }
};

export const inspectLocalSqliteDoctor = async (
  port: LocalSqliteMaintenancePort,
  context: LocalResourceDoctorContext,
): Promise<LocalResourceDoctorInspection> => port.inspectDoctor(context);
