import {
  commitLocalResourceConfiguration,
  defineLocalResourceLifecycleHandler,
  isLocalResourceLifecycleCapability,
  isLocalResourceConfigurationCommitError,
  type LocalResourceLifecycleApplyResult,
  type LocalResourceLifecycleCapability,
  type LocalResourceLifecycleContext,
  type LocalResourceLifecycleHandler,
  type LocalResourceLifecyclePlanEvidence,
  type LocalResourceLifecycleRecoveryContext,
  type LocalResourceMaintenanceContext,
  type LocalResourceRetainedDeleteAuthority,
} from "@agentscope/destinations-core";

import {
  LOCAL_SQLITE_DESTINATION_TYPE,
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  localSqliteLifecycleArtifactGrammarFingerprintForTesting,
} from "./capability.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import type { LocalSqliteExclusiveFenceAuthority } from "./fence.js";
import {
  applyLocalSqliteMaintenance,
  inspectLocalSqliteDoctor,
  recoverLocalSqliteMaintenance,
  type LocalSqliteMaintenancePort,
} from "./maintenance.js";

export type LocalSqliteLifecycleIntent = Readonly<{
  recordVersion: 1;
  operation: "configure" | "delete" | "unconfigure";
  transactionId: string;
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
  expectedConfigurationGeneration: number;
  candidateConfigurationGeneration: number;
  expectedConfigurationDigest: string;
  candidateConfigurationDigest: string;
  retainedReceiptDigest: string | null;
  retainedDatabaseFamilyPhysicalIdentity: string | null;
}>;

export type LocalSqliteOwnershipReceipt = Readonly<{
  recordVersion: 1;
  destinationType: typeof LOCAL_SQLITE_DESTINATION_TYPE;
  connectionId: string;
  connectionDigest: string;
  namespaceFingerprint: string;
  physicalEvidenceFingerprint: string;
  databaseFamilyPhysicalIdentity: string;
  destinationFormat: string;
  migrationManifestId: string;
  protocolCompatibilityId: string;
  lifecycleFingerprint: string;
  recoveryHandlerId: string;
  capabilityVersion: 1;
  artifactGrammarVersion: 1;
  artifactGrammarFingerprint: string;
  originatingConfigurationGeneration: number;
  originatingConfigurationDigest: string;
  transactionId: string;
}>;

export type LocalSqliteLifecyclePort = Readonly<{
  inspect(
    context: LocalResourceLifecycleContext,
  ): Promise<LocalResourceLifecyclePlanEvidence>;
  inspectRetainedDelete(
    connectionId: string,
    signal: AbortSignal,
  ): Promise<null | Readonly<{
    connectionId: string;
    connectionName: "retained";
    planEvidence: LocalResourceLifecyclePlanEvidence;
    retainedAuthority: LocalResourceRetainedDeleteAuthority;
  }>>;
  publishIntent(
    intent: LocalSqliteLifecycleIntent,
    canonicalBytes: string,
    signal: AbortSignal,
  ): Promise<void>;
  acquireExclusiveFence(
    intent: LocalSqliteLifecycleIntent,
    signal: AbortSignal,
  ): Promise<LocalSqliteExclusiveFenceAuthority>;
  revalidatePhysicalEvidence(
    intent: LocalSqliteLifecycleIntent,
    evidence: LocalResourceLifecyclePlanEvidence,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  stageConfigure(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  activateConfigure(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  inspectOwnedDatabase(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<Readonly<{ databaseFamilyPhysicalIdentity: string }>>;
  publishOwnershipReceipt(
    receipt: LocalSqliteOwnershipReceipt,
    canonicalBytes: string,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  authenticateOwnershipReceipt(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
    authority?: LocalResourceRetainedDeleteAuthority,
  ): Promise<void>;
  claimRecoveryIntent(signal: AbortSignal): Promise<
    Readonly<{
      canonicalBytes: string;
      fence: LocalSqliteExclusiveFenceAuthority;
    }>
  >;
  rollbackPrepared(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  verifyRetainedDatabase(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  deleteOwnedDatabaseFamily(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  finalize(
    intent: LocalSqliteLifecycleIntent,
    fence: LocalSqliteExclusiveFenceAuthority,
    signal: AbortSignal,
  ): Promise<void>;
  completeFinalization(
    transactionId: string,
    signal: AbortSignal,
  ): Promise<void>;
}>;

const lifecycleIntents = new WeakSet<object>();
const ownershipReceipts = new WeakSet<object>();

export type LocalSqliteLifecycleFailureCode =
  "busy" | "outcome-unknown" | "reconciliation-required" | "unavailable";

export class LocalSqliteLifecycleError extends Error {
  public constructor(public readonly code: LocalSqliteLifecycleFailureCode) {
    super(`destination.local-sqlite.lifecycle-${code}`);
    this.name = "LocalSqliteLifecycleError";
  }
}

const connectionDigest = (connectionId: string): string => {
  if (!/^destination-connection-v1-[0-9a-f]{64}$/u.test(connectionId))
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return createHash("sha256")
    .update(
      JSON.stringify({
        connectionId,
        destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
      }),
    )
    .digest("hex");
};

const intentKeys = Object.freeze([
  "artifactGrammarFingerprint",
  "artifactGrammarVersion",
  "candidateConfigurationDigest",
  "candidateConfigurationGeneration",
  "capabilityVersion",
  "connectionDigest",
  "connectionId",
  "destinationFormat",
  "destinationType",
  "expectedConfigurationDigest",
  "expectedConfigurationGeneration",
  "lifecycleFingerprint",
  "migrationManifestId",
  "namespaceFingerprint",
  "operation",
  "owner",
  "physicalEvidenceFingerprint",
  "protocolCompatibilityId",
  "recordVersion",
  "recoveryHandlerId",
  "retainedDatabaseFamilyPhysicalIdentity",
  "retainedReceiptDigest",
  "transactionId",
] as const);

const decodeExactIntent = (
  bytes: unknown,
  // eslint-disable-next-line complexity -- canonical durable intent validation is deliberately all-and-only.
): LocalSqliteLifecycleIntent | undefined => {
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
      Reflect.ownKeys(descriptors).length !== intentKeys.length ||
      intentKeys.some((key) => {
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
    const retainedReceiptDigest = record.retainedReceiptDigest;
    const retainedIdentity = record.retainedDatabaseFamilyPhysicalIdentity;
    if (
      record.recordVersion !== 1 ||
      !["configure", "delete", "unconfigure"].includes(
        record.operation as string,
      ) ||
      typeof record.transactionId !== "string" ||
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.transactionId) ||
      record.destinationType !== LOCAL_SQLITE_DESTINATION_TYPE ||
      typeof record.connectionId !== "string" ||
      connectionDigest(record.connectionId) !== record.connectionDigest ||
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
      typeof record.namespaceFingerprint !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.namespaceFingerprint) ||
      typeof record.physicalEvidenceFingerprint !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.physicalEvidenceFingerprint) ||
      typeof record.lifecycleFingerprint !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.lifecycleFingerprint) ||
      typeof record.recoveryHandlerId !== "string" ||
      record.artifactGrammarFingerprint !==
        LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT ||
      record.artifactGrammarVersion !== 1 ||
      record.capabilityVersion !== 1 ||
      record.destinationFormat !== LOCAL_SQLITE_DESTINATION_FORMAT ||
      record.migrationManifestId !== LOCAL_SQLITE_MIGRATION_MANIFEST_ID ||
      record.protocolCompatibilityId !==
        LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID ||
      !Number.isSafeInteger(record.expectedConfigurationGeneration) ||
      (record.expectedConfigurationGeneration as number) < 0 ||
      !Number.isSafeInteger(record.candidateConfigurationGeneration) ||
      (record.candidateConfigurationGeneration as number) <=
        (record.expectedConfigurationGeneration as number) ||
      typeof record.expectedConfigurationDigest !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.expectedConfigurationDigest) ||
      typeof record.candidateConfigurationDigest !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.candidateConfigurationDigest) ||
      !(
        (retainedReceiptDigest === null && retainedIdentity === null) ||
        (typeof retainedReceiptDigest === "string" &&
          /^sha256-[0-9a-f]{64}$/u.test(retainedReceiptDigest) &&
          typeof retainedIdentity === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/u.test(retainedIdentity))
      )
    )
      return undefined;
    if (`${JSON.stringify(value)}\n` !== bytes) return undefined;
    const intent = Object.freeze(value) as LocalSqliteLifecycleIntent;
    lifecycleIntents.add(intent);
    return intent;
  } catch {
    return undefined;
  }
};

export const decodeLocalSqliteLifecycleIntent = (
  bytes: unknown,
): LocalSqliteLifecycleIntent | undefined => decodeExactIntent(bytes);

const receiptKeys = Object.freeze([
  "artifactGrammarFingerprint",
  "artifactGrammarVersion",
  "capabilityVersion",
  "connectionDigest",
  "connectionId",
  "databaseFamilyPhysicalIdentity",
  "destinationFormat",
  "destinationType",
  "lifecycleFingerprint",
  "migrationManifestId",
  "namespaceFingerprint",
  "originatingConfigurationDigest",
  "originatingConfigurationGeneration",
  "physicalEvidenceFingerprint",
  "protocolCompatibilityId",
  "recordVersion",
  "recoveryHandlerId",
  "transactionId",
] as const);

export const decodeLocalSqliteOwnershipReceipt = (
  bytes: unknown,
  // eslint-disable-next-line complexity -- canonical ownership authority validation is deliberately all-and-only.
): LocalSqliteOwnershipReceipt | undefined => {
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
      record.destinationType !== LOCAL_SQLITE_DESTINATION_TYPE ||
      typeof record.connectionId !== "string" ||
      connectionDigest(record.connectionId) !== record.connectionDigest ||
      typeof record.namespaceFingerprint !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.namespaceFingerprint) ||
      typeof record.physicalEvidenceFingerprint !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.physicalEvidenceFingerprint) ||
      typeof record.databaseFamilyPhysicalIdentity !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,191}$/u.test(
        record.databaseFamilyPhysicalIdentity,
      ) ||
      record.destinationFormat !== LOCAL_SQLITE_DESTINATION_FORMAT ||
      record.migrationManifestId !== LOCAL_SQLITE_MIGRATION_MANIFEST_ID ||
      record.protocolCompatibilityId !==
        LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID ||
      typeof record.lifecycleFingerprint !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.lifecycleFingerprint) ||
      typeof record.recoveryHandlerId !== "string" ||
      record.capabilityVersion !== 1 ||
      record.artifactGrammarVersion !== 1 ||
      record.artifactGrammarFingerprint !==
        LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT ||
      !Number.isSafeInteger(record.originatingConfigurationGeneration) ||
      (record.originatingConfigurationGeneration as number) < 0 ||
      typeof record.originatingConfigurationDigest !== "string" ||
      !/^sha256-[0-9a-f]{64}$/u.test(record.originatingConfigurationDigest) ||
      typeof record.transactionId !== "string" ||
      !/^(?!0{32}$)[0-9a-f]{32}$/u.test(record.transactionId) ||
      `${JSON.stringify(value)}\n` !== bytes
    )
      return undefined;
    const receipt = Object.freeze(value) as LocalSqliteOwnershipReceipt;
    ownershipReceipts.add(receipt);
    return receipt;
  } catch {
    return undefined;
  }
};

export const encodeLocalSqliteLifecycleIntent = (
  intent: LocalSqliteLifecycleIntent,
): string => {
  if (!lifecycleIntents.has(intent))
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return `${JSON.stringify(intent)}\n`;
};

export const encodeLocalSqliteOwnershipReceipt = (
  receipt: LocalSqliteOwnershipReceipt,
): string => {
  if (!ownershipReceipts.has(receipt))
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return `${JSON.stringify(receipt)}\n`;
};

const intentFor = (
  capability: LocalResourceLifecycleCapability,
  context: LocalResourceLifecycleContext &
    Readonly<{ retainedAuthority?: LocalResourceRetainedDeleteAuthority }>,
  evidence: LocalResourceLifecyclePlanEvidence,
): LocalSqliteLifecycleIntent => {
  const intent = Object.freeze({
    recordVersion: 1,
    operation: context.operation,
    transactionId: context.operationId,
    destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
    connectionId: context.connectionId,
    connectionDigest: connectionDigest(context.connectionId),
    owner: Object.freeze({ ...context.owner }),
    namespaceFingerprint: evidence.namespaceFingerprint,
    physicalEvidenceFingerprint: evidence.physicalEvidenceFingerprint,
    lifecycleFingerprint: capability.fingerprint,
    recoveryHandlerId: capability.recoveryHandlerId,
    artifactGrammarFingerprint:
      LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
    artifactGrammarVersion: 1,
    capabilityVersion: 1,
    destinationFormat: LOCAL_SQLITE_DESTINATION_FORMAT,
    migrationManifestId: LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
    protocolCompatibilityId: LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
    expectedConfigurationGeneration: context.expectedConfigurationGeneration,
    candidateConfigurationGeneration: context.candidateConfigurationGeneration,
    expectedConfigurationDigest: context.expectedConfigurationDigest,
    candidateConfigurationDigest: context.candidateConfigurationDigest,
    retainedReceiptDigest: context.retainedAuthority?.receiptDigest ?? null,
    retainedDatabaseFamilyPhysicalIdentity:
      context.retainedAuthority?.databaseFamilyPhysicalIdentity ?? null,
  });
  lifecycleIntents.add(intent);
  return intent;
};

const receiptFor = async (
  port: LocalSqliteLifecyclePort,
  intent: LocalSqliteLifecycleIntent,
  fence: LocalSqliteExclusiveFenceAuthority,
  signal: AbortSignal,
): Promise<LocalSqliteOwnershipReceipt> => {
  const evidence = await port.inspectOwnedDatabase(intent, fence, signal);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    Object.getPrototypeOf(evidence) !== Object.prototype
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
  const descriptors = Object.getOwnPropertyDescriptors(evidence);
  const identity = descriptors.databaseFamilyPhysicalIdentity?.value as unknown;
  if (
    Reflect.ownKeys(descriptors).length !== 1 ||
    !descriptors.databaseFamilyPhysicalIdentity ||
    !("value" in descriptors.databaseFamilyPhysicalIdentity) ||
    typeof identity !== "string" ||
    identity.length < 1 ||
    identity.length > 192 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u.test(identity)
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
  const receipt = Object.freeze({
    recordVersion: 1,
    destinationType: intent.destinationType,
    connectionId: intent.connectionId,
    connectionDigest: intent.connectionDigest,
    namespaceFingerprint: intent.namespaceFingerprint,
    physicalEvidenceFingerprint: intent.physicalEvidenceFingerprint,
    databaseFamilyPhysicalIdentity: identity,
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
  });
  ownershipReceipts.add(receipt);
  return receipt;
};

const failed = (
  error: unknown,
  committed: boolean,
): LocalResourceLifecycleApplyResult => {
  if (isLocalResourceConfigurationCommitError(error))
    return Object.freeze({
      ok: false,
      state: "configuration-committed",
      code: "outcome-unknown",
    });
  if (error instanceof LocalSqliteLifecycleError)
    return Object.freeze({
      ok: false,
      state:
        error.code === "reconciliation-required"
          ? "reconciliation-required"
          : committed
            ? "configuration-committed"
            : "prepared",
      code: error.code,
    });
  return Object.freeze({
    ok: false,
    state: committed ? "configuration-committed" : "prepared",
    code: "outcome-unknown",
  });
};

const policyEvidenceMatchesContext = (
  context: LocalResourceLifecycleContext | LocalResourceMaintenanceContext,
  evidence: LocalResourceLifecyclePlanEvidence,
): boolean =>
  evidence.retentionPolicy.maximumAgeNanoseconds ===
    context.settings.maximumAgeNanoseconds &&
  evidence.retentionPolicy.maximumTraceCount ===
    context.settings.maximumTraceCount &&
  evidence.retentionPolicy.maximumPayloadBytes ===
    context.settings.maximumPayloadBytes &&
  evidence.retentionPolicy.physicalCleanupTrigger ===
    "next-authorized-mutation";

const signalAborted = (signal: AbortSignal): boolean => {
  try {
    return signal.aborted;
  } catch {
    /* v8 ignore next -- destination-core supplies only its owned native
       AbortSignal to every Local lifecycle callback. */
    return true;
  }
};

const requireActive = (signal: AbortSignal): void => {
  if (signalAborted(signal)) throw new LocalSqliteLifecycleError("unavailable");
};

const applyWithPort = async (
  capability: LocalResourceLifecycleCapability,
  port: LocalSqliteLifecyclePort,
  context: LocalResourceLifecycleContext &
    Readonly<{
      planEvidence: LocalResourceLifecyclePlanEvidence;
      configurationAuthority: Parameters<
        typeof commitLocalResourceConfiguration
      >[0];
      retainedAuthority?: LocalResourceRetainedDeleteAuthority;
    }>,
): Promise<LocalResourceLifecycleApplyResult> => {
  const intent = intentFor(capability, context, context.planEvidence);
  let committed = false;
  let retainedAuthority: LocalResourceRetainedDeleteAuthority | undefined;
  try {
    /* v8 ignore next 2 -- the destination-core bounded invoker rejects the
       same branded context signal before entering this handler. */
    if (signalAborted(context.signal))
      throw new LocalSqliteLifecycleError("unavailable");
    await port.publishIntent(
      intent,
      encodeLocalSqliteLifecycleIntent(intent),
      context.signal,
    );
    requireActive(context.signal);
    const fence = await port.acquireExclusiveFence(intent, context.signal);
    requireActive(context.signal);
    await port.revalidatePhysicalEvidence(
      intent,
      context.planEvidence,
      fence,
      context.signal,
    );
    requireActive(context.signal);
    if (context.operation === "configure")
      await port.stageConfigure(intent, fence, context.signal);
    else if (context.operation === "delete" && context.retainedAuthority) {
      await port.authenticateOwnershipReceipt(
        intent,
        fence,
        context.signal,
        context.retainedAuthority,
      );
    } else {
      const receipt = await receiptFor(port, intent, fence, context.signal);
      requireActive(context.signal);
      const canonicalReceipt = encodeLocalSqliteOwnershipReceipt(receipt);
      await port.publishOwnershipReceipt(
        receipt,
        canonicalReceipt,
        fence,
        context.signal,
      );
      retainedAuthority = Object.freeze({
        receiptDigest: `sha256-${createHash("sha256").update(canonicalReceipt).digest("hex")}`,
        databaseFamilyPhysicalIdentity: receipt.databaseFamilyPhysicalIdentity,
      });
    }
    requireActive(context.signal);
    await commitLocalResourceConfiguration(context.configurationAuthority, {
      destinationType: context.destinationType,
      connectionId: context.connectionId,
      operationId: context.operationId,
      lifecycleFingerprint: capability.fingerprint,
      recoveryHandlerId: capability.recoveryHandlerId,
    });
    committed = true;
    requireActive(context.signal);
    if (context.operation === "configure")
      await port.activateConfigure(intent, fence, context.signal);
    else if (context.operation === "unconfigure")
      await port.verifyRetainedDatabase(intent, fence, context.signal);
    else await port.deleteOwnedDatabaseFamily(intent, fence, context.signal);
    requireActive(context.signal);
    await port.finalize(intent, fence, context.signal);
    requireActive(context.signal);
    if (context.operation === "unconfigure")
      return Object.freeze({
        ok: true,
        state: "retained",
        retainedAuthority: retainedAuthority!,
      });
    return Object.freeze({
      ok: true,
      state: context.operation === "configure" ? "configured" : "deleted",
    });
  } catch (error) {
    return failed(error, committed);
  }
};

const recoveryIntentMatches = (
  capability: LocalResourceLifecycleCapability,
  context: LocalResourceLifecycleRecoveryContext,
  intent: LocalSqliteLifecycleIntent,
): boolean =>
  intent.operation === context.operation &&
  intent.transactionId === context.operationId &&
  intent.destinationType === context.destinationType &&
  intent.connectionId === context.connectionId &&
  intent.lifecycleFingerprint === capability.fingerprint &&
  intent.recoveryHandlerId === capability.recoveryHandlerId &&
  intent.expectedConfigurationGeneration ===
    context.expectedConfigurationGeneration &&
  intent.expectedConfigurationDigest === context.expectedConfigurationDigest &&
  intent.candidateConfigurationGeneration ===
    context.authorizedCandidates[context.authorizedCandidates.length - 1]
      ?.generation &&
  intent.candidateConfigurationDigest ===
    context.authorizedCandidates[context.authorizedCandidates.length - 1]
      ?.digest;

const recoverWithPort = async (
  capability: LocalResourceLifecycleCapability,
  port: LocalSqliteLifecyclePort,
  context: LocalResourceLifecycleRecoveryContext,
): Promise<LocalResourceLifecycleApplyResult> => {
  let committed = context.configurationState !== "prior";
  let retainedAuthority: LocalResourceRetainedDeleteAuthority | undefined;
  try {
    /* v8 ignore next 2 -- the destination-core bounded invoker rejects the
       same branded recovery signal before entering this handler. */
    if (signalAborted(context.signal))
      throw new LocalSqliteLifecycleError("unavailable");
    const claimed = await port.claimRecoveryIntent(context.signal);
    requireActive(context.signal);
    const intent = decodeLocalSqliteLifecycleIntent(claimed.canonicalBytes);
    if (!intent || !recoveryIntentMatches(capability, context, intent))
      throw new LocalSqliteLifecycleError("reconciliation-required");
    if (context.configurationState === "prior") {
      await port.rollbackPrepared(intent, claimed.fence, context.signal);
      requireActive(context.signal);
      await port.finalize(intent, claimed.fence, context.signal);
      requireActive(context.signal);
      return Object.freeze({ ok: true, state: "rolled-back" });
    }
    if (context.configurationState === "intermediate") {
      if (!context.configurationAuthority)
        throw new LocalSqliteLifecycleError("reconciliation-required");
      await commitLocalResourceConfiguration(context.configurationAuthority, {
        destinationType: context.destinationType,
        connectionId: context.connectionId,
        operationId: context.operationId,
        lifecycleFingerprint: capability.fingerprint,
        recoveryHandlerId: capability.recoveryHandlerId,
      });
      committed = true;
      requireActive(context.signal);
    }
    if (context.operation === "configure")
      await port.activateConfigure(intent, claimed.fence, context.signal);
    else if (context.operation === "unconfigure") {
      await port.verifyRetainedDatabase(intent, claimed.fence, context.signal);
      requireActive(context.signal);
      const receipt = await receiptFor(
        port,
        intent,
        claimed.fence,
        context.signal,
      );
      const canonicalReceipt = encodeLocalSqliteOwnershipReceipt(receipt);
      retainedAuthority = Object.freeze({
        receiptDigest: `sha256-${createHash("sha256").update(canonicalReceipt).digest("hex")}`,
        databaseFamilyPhysicalIdentity: receipt.databaseFamilyPhysicalIdentity,
      });
    } else {
      const authority =
        intent.retainedReceiptDigest === null
          ? undefined
          : Object.freeze({
              receiptDigest: intent.retainedReceiptDigest,
              databaseFamilyPhysicalIdentity:
                intent.retainedDatabaseFamilyPhysicalIdentity!,
            });
      await port.authenticateOwnershipReceipt(
        intent,
        claimed.fence,
        context.signal,
        authority,
      );
      requireActive(context.signal);
      await port.deleteOwnedDatabaseFamily(
        intent,
        claimed.fence,
        context.signal,
      );
    }
    requireActive(context.signal);
    await port.finalize(intent, claimed.fence, context.signal);
    requireActive(context.signal);
    if (context.operation === "unconfigure")
      return Object.freeze({
        ok: true,
        state: "retained",
        retainedAuthority: retainedAuthority!,
      });
    return Object.freeze({
      ok: true,
      state: context.operation === "configure" ? "configured" : "deleted",
    });
  } catch (error) {
    return failed(error, committed);
  }
};

const createHandler = (
  capability: LocalResourceLifecycleCapability,
  port: LocalSqliteLifecyclePort | undefined,
  maintenancePort?: LocalSqliteMaintenancePort,
  maximumSnapshotBytes = LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  // eslint-disable-next-line max-lines-per-function -- one handler binds the complete versioned Local SQLite lifecycle family.
): LocalResourceLifecycleHandler => {
  if (
    !isLocalResourceLifecycleCapability(capability) ||
    capability.destinationType !== LOCAL_SQLITE_DESTINATION_TYPE ||
    capability.artifactGrammarFingerprint !==
      localSqliteLifecycleArtifactGrammarFingerprintForTesting(
        maximumSnapshotBytes,
      )
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return defineLocalResourceLifecycleHandler({
    capability,
    complete: async (operation, operationId, signal) => {
      if (operation === "backup" || operation === "restore") {
        if (!maintenancePort)
          throw new LocalSqliteLifecycleError("unavailable");
        await maintenancePort.completeMaintenanceFinalization(
          operationId,
          signal,
        );
      } else {
        if (!port) throw new LocalSqliteLifecycleError("unavailable");
        await port.completeFinalization(operationId, signal);
      }
      requireActive(signal);
    },
    inspectPlan: async (context) => {
      if (!port) throw new LocalSqliteLifecycleError("unavailable");
      const evidence = await port.inspect(context);
      if (!policyEvidenceMatchesContext(context, evidence))
        throw new LocalSqliteLifecycleError("reconciliation-required");
      return evidence;
    },
    inspectRetainedDelete: async (connectionId, signal) => {
      if (!port) throw new LocalSqliteLifecycleError("unavailable");
      const result = await port.inspectRetainedDelete(connectionId, signal);
      return result === null
        ? null
        : Object.freeze({
            destinationType: LOCAL_SQLITE_DESTINATION_TYPE,
            connectionId: result.connectionId,
            connectionName: "retained" as const,
            planEvidence: result.planEvidence,
            retainedAuthority: result.retainedAuthority,
          });
    },
    apply: (context) => {
      if (!port)
        return Promise.resolve(
          Object.freeze({
            ok: false as const,
            state: "unchanged" as const,
            code: "unavailable" as const,
          }),
        );
      return applyWithPort(capability, port, context);
    },
    recover: (context) =>
      port
        ? recoverWithPort(capability, port, context)
        : Promise.resolve(
            Object.freeze({
              ok: false as const,
              state: "unchanged" as const,
              code: "unavailable" as const,
            }),
          ),
    inspectMaintenancePlan: async (context) => {
      if (!maintenancePort) throw new LocalSqliteLifecycleError("unavailable");
      const evidence = await maintenancePort.inspectMaintenance(context);
      if (!policyEvidenceMatchesContext(context, evidence.planEvidence))
        throw new LocalSqliteLifecycleError("reconciliation-required");
      return evidence;
    },
    applyMaintenance: (context) =>
      maintenancePort
        ? applyLocalSqliteMaintenance(
            capability.fingerprint,
            capability.recoveryHandlerId,
            maximumSnapshotBytes,
            maintenancePort,
            context,
          )
        : Promise.resolve(
            Object.freeze({
              ok: false as const,
              state: "unchanged" as const,
              code: "unavailable" as const,
            }),
          ),
    recoverMaintenance: (context) =>
      maintenancePort
        ? recoverLocalSqliteMaintenance(
            capability.fingerprint,
            capability.recoveryHandlerId,
            maximumSnapshotBytes,
            maintenancePort,
            context,
          )
        : Promise.resolve(
            Object.freeze({
              ok: false as const,
              state: "unchanged" as const,
              code: "unavailable" as const,
            }),
          ),
    inspectDoctor: async (context) => {
      if (!maintenancePort) throw new LocalSqliteLifecycleError("unavailable");
      const inspection = await inspectLocalSqliteDoctor(
        maintenancePort,
        context,
      );
      if (
        inspection.retentionPolicy.maximumAgeNanoseconds !==
          context.settings.maximumAgeNanoseconds ||
        inspection.retentionPolicy.maximumTraceCount !==
          context.settings.maximumTraceCount ||
        inspection.retentionPolicy.maximumPayloadBytes !==
          context.settings.maximumPayloadBytes
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
      return inspection;
    },
  });
};

export const createLocalSqliteLifecycleHandler = (
  capability: LocalResourceLifecycleCapability,
): LocalResourceLifecycleHandler => createHandler(capability, undefined);

export const createLocalSqliteLifecycleHandlerForTesting = (
  capability: LocalResourceLifecycleCapability,
  port: LocalSqliteLifecyclePort,
  maintenancePort?: LocalSqliteMaintenancePort,
  maximumSnapshotBytes = LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
): LocalResourceLifecycleHandler =>
  createHandler(capability, port, maintenancePort, maximumSnapshotBytes);
import { createHash } from "node:crypto";
