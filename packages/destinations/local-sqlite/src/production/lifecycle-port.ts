/* eslint-disable max-lines-per-function, @typescript-eslint/require-await -- synchronous owned-filesystem steps implement an asynchronous lifecycle port. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type {
  LocalResourceLifecycleContext,
  LocalResourceLifecyclePlanEvidence,
} from "@agentscope/destinations-core";

import {
  decodeLocalSqliteLifecycleIntent,
  decodeLocalSqliteOwnershipReceipt,
  LocalSqliteLifecycleError,
  type LocalSqliteLifecycleIntent,
  type LocalSqliteLifecyclePort,
  type LocalSqliteOwnershipReceipt,
} from "../lifecycle/configuration.js";
import {
  acquireLocalSqliteExclusiveFence,
  decodeLocalSqliteFenceRecord,
  releaseLocalSqliteExclusiveFence,
  resumeLocalSqliteLifecycleFence,
  type LocalSqliteExclusiveFenceAuthority,
} from "../lifecycle/fence.js";
import {
  compileLocalSqlitePhysicalNamespaceEvidence,
  planLocalSqliteNamespace,
  type LocalSqliteNamespacePlan,
  type LocalSqlitePhysicalNamespaceEvidence,
} from "../lifecycle/namespace.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
  runLocalSqliteMigrations,
} from "../migrations.js";
import {
  LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  localSqliteLifecycleDeclaration,
} from "../lifecycle/capability.js";
import {
  boundedOwnedNames,
  createOwnedExclusiveFile,
  decodeLocalSqliteNamespaceClaimName,
  openOwnedDirectory,
  openOwnedFile,
  inspectOwnedFileRetirement,
  readOwnedRetirementUtf8,
  readOwnedUtf8,
  retireOwnedFile,
  renameOwnedFile,
  statOwnedFile,
  writeOwnedExclusive,
  type OwnedAtomicExchange,
  type OwnedFile,
} from "./owned-filesystem.js";
import {
  createLocalSqliteFilesystemGatePort,
  currentProcessStartIdentity,
  ensurePrivateDirectory,
} from "./filesystem-port.js";
import {
  createOwnedMigrationDatabase,
  type OwnedSqliteConnection,
} from "./sqlite-port.js";
import {
  decodeLocalSqliteOperationPhase,
  encodeLocalSqliteOperationPhase,
  LOCAL_SQLITE_OPERATION_PHASE_NAME,
  type LocalSqliteOperationPhase,
} from "./operation-phase.js";

export type OwnedSqliteOpener = Readonly<{
  open: (
    filename: string,
    options?: Readonly<Record<string, unknown>>,
  ) => OwnedSqliteConnection;
  openDescriptor?: (
    descriptor: number,
    options?: Readonly<Record<string, unknown>>,
  ) => OwnedSqliteConnection;
  exchangeOwnedFiles?: OwnedAtomicExchange;
  lockOwnedFile?: (descriptor: number) => "acquired" | "busy";
  unlockOwnedFile?: (descriptor: number) => void;
}>;

export const openOwnedSqliteDescriptor = (
  opener: OwnedSqliteOpener,
  file: OwnedFile,
  options: Readonly<Record<string, unknown>>,
  allowPathFallbackForTesting: boolean,
): OwnedSqliteConnection => {
  /* v8 ignore start -- descriptor-native opening is executed by the exact
     Linux candidate verifier; source tests use the explicit path fallback. */
  if (opener.openDescriptor !== undefined)
    return opener.openDescriptor(file.descriptor, options);
  /* v8 ignore stop */
  /* v8 ignore else -- production reaches the descriptor opener above; only
     the restricted source binder may select the explicit path fallback. */
  if (allowPathFallbackForTesting)
    return opener.open(file.descriptorPath, options);
  /* v8 ignore next -- production runtime cannot be constructed without the
     manifest-authenticated descriptor opener. */
  throw new Error("destination.local-sqlite.native-unavailable");
};

export type LocalSqliteProductionHome = Readonly<{
  root: string;
  platform: NodeJS.Platform;
}>;

const intentName = "intent-v1.json";
const receiptName = "ownership-receipt-v1.json";
const fenceName = "exclusive-fence-v1";
const maximumMetadataBytes = 65_536;
const missing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const optionalOwnedStat = (
  directory: ReturnType<typeof openOwnedDirectory>,
  name: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
) => {
  try {
    return statOwnedFile(directory, name, maximumBytes);
  } catch (error) {
    /* v8 ignore next -- non-ENOENT propagation is exercised by the owned-filesystem
       boundary; this helper only translates the single optional-file outcome. */
    if (missing(error)) return undefined;
    /* v8 ignore next -- see the owned-filesystem boundary rationale above. */
    throw error;
  }
};

const lifecyclePhaseFor = (
  intent: LocalSqliteLifecycleIntent,
  phase: "configured-active" | "database-deleted",
  artifactPhysicalIdentity: string,
): LocalSqliteOperationPhase =>
  Object.freeze({
    schemaVersion: 1,
    operation: phase === "configured-active" ? "configure" : "delete",
    phase,
    transactionId: intent.transactionId,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    artifactGrammarFingerprint: intent.artifactGrammarFingerprint,
    artifactPhysicalIdentity,
  });

const operationPhaseMatchesLifecycleIntent = (
  phase: LocalSqliteOperationPhase,
  intent: LocalSqliteLifecycleIntent,
): boolean =>
  phase.transactionId === intent.transactionId &&
  phase.lifecycleFingerprint === intent.lifecycleFingerprint &&
  phase.artifactGrammarFingerprint === intent.artifactGrammarFingerprint &&
  phase.operation === intent.operation &&
  ((intent.operation === "configure" && phase.phase === "configured-active") ||
    (intent.operation === "delete" && phase.phase === "database-deleted"));

const readLifecycleOperationPhase = (
  lifecycle: ReturnType<typeof openOwnedDirectory>,
  intent: LocalSqliteLifecycleIntent,
): LocalSqliteOperationPhase | undefined => {
  const retirement = inspectOwnedFileRetirement(
    lifecycle,
    LOCAL_SQLITE_OPERATION_PHASE_NAME,
    maximumMetadataBytes,
  );
  if (retirement === undefined) return undefined;
  const phase = decodeLocalSqliteOperationPhase(
    readOwnedRetirementUtf8(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      maximumMetadataBytes,
    ).content,
  );
  if (
    phase === undefined ||
    !operationPhaseMatchesLifecycleIntent(phase, intent)
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return phase;
};

const publishLifecycleOperationPhase = (
  lifecycle: ReturnType<typeof openOwnedDirectory>,
  phase: LocalSqliteOperationPhase,
): void => {
  const canonical = encodeLocalSqliteOperationPhase(phase);
  const existing = optionalOwnedStat(
    lifecycle,
    LOCAL_SQLITE_OPERATION_PHASE_NAME,
    maximumMetadataBytes,
  );
  /* v8 ignore else -- same-canonical phase replay is exercised by the built crash
     verifier; source integration covers the first durable publication. */
  if (existing === undefined) {
    writeOwnedExclusive(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      Buffer.from(canonical, "utf8"),
      maximumMetadataBytes,
    );
    return;
  }
  /* v8 ignore next -- a different canonical phase requires a concurrent same-name
     substitution; owned-filesystem identity-race tests cover the fail-closed edge. */
  if (
    readOwnedUtf8(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      maximumMetadataBytes,
    ).content !== canonical
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
};

const removeLifecycleOperationPhase = (
  lifecycle: ReturnType<typeof openOwnedDirectory>,
  intent: LocalSqliteLifecycleIntent,
): void => {
  const phase = readLifecycleOperationPhase(lifecycle, intent);
  /* v8 ignore next -- the complete recovery integration removes a present phase;
     the absent no-op is the ordinary completion path. */
  if (phase === undefined) return;
  /* v8 ignore next -- present-phase cleanup is exercised by built crash recovery. */
  const state = inspectOwnedFileRetirement(
    lifecycle,
    LOCAL_SQLITE_OPERATION_PHASE_NAME,
    maximumMetadataBytes,
  )?.evidence;
  /* v8 ignore next -- the phase was read from one public/claim state above. */
  if (state === undefined)
    throw new LocalSqliteLifecycleError("reconciliation-required");
  /* v8 ignore next -- removal can differ only after a same-handle namespace race,
     which is covered at the owned-filesystem primitive. */
  if (
    retireOwnedFile(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      state.physicalIdentity,
    ) !== "removed"
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
};

const requireActive = (signal: AbortSignal): void => {
  if (signal.aborted) throw new LocalSqliteLifecycleError("unavailable");
};

const physicalIdentity = (
  path: string,
  allowPathFallbackForTesting: boolean,
): string => {
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  try {
    return statOwnedFile(directory, basename(path)).physicalIdentity;
  } finally {
    directory.close();
  }
};

const readBounded = (
  path: string,
  allowPathFallbackForTesting: boolean,
): string => {
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  try {
    return readOwnedUtf8(directory, basename(path), maximumMetadataBytes)
      .content;
  } finally {
    directory.close();
  }
};

const writeExclusive = (
  path: string,
  bytes: string,
  allowPathFallbackForTesting: boolean,
): void => {
  /* v8 ignore next -- every caller passes a bounded canonical codec result; the
     metadata codec owns the hostile maximum+1 tests. */
  if (Buffer.byteLength(bytes, "utf8") > maximumMetadataBytes)
    throw new LocalSqliteLifecycleError("reconciliation-required");
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  try {
    writeOwnedExclusive(
      directory,
      basename(path),
      Buffer.from(bytes, "utf8"),
      maximumMetadataBytes,
    );
  } finally {
    directory.close();
  }
};

const removeIfPresent = (
  path: string,
  allowPathFallbackForTesting: boolean,
): void => {
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  try {
    const state = inspectOwnedFileRetirement(directory, basename(path));
    /* v8 ignore next -- a non-removed result requires a concurrent same-name
       replacement after the retained stat and is primitive-tested. */
    if (
      state !== undefined &&
      retireOwnedFile(
        directory,
        basename(path),
        state.evidence.physicalIdentity,
      ) !== "removed"
    )
      throw new LocalSqliteLifecycleError("reconciliation-required");
  } finally {
    directory.close();
  }
};

const scanLifecycleIntents = (
  destinationTypeDirectory: string,
  allowPathFallbackForTesting: boolean,
  afterFirstScanForTesting?: () => void,
): readonly Readonly<{
  lifecycleDirectory: string;
  canonicalBytes: string;
}>[] => {
  let root: ReturnType<typeof openOwnedDirectory>;
  try {
    root = openOwnedDirectory(
      destinationTypeDirectory,
      allowPathFallbackForTesting,
    );
  } catch (error) {
    /* v8 ignore next -- only ENOENT is translated; openOwnedDirectory has the
       exhaustive hostile error mapping tests. */
    if (missing(error)) return Object.freeze([]);
    /* v8 ignore next -- see the owned-directory propagation rationale above. */
    throw error;
  }
  try {
    const names = boundedOwnedNames(root, 128);
    const found: Readonly<{
      lifecycleDirectory: string;
      canonicalBytes: string;
    }>[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}$/u.test(name))
        throw new LocalSqliteLifecycleError("reconciliation-required");
      const lifecycleDirectory = join(
        destinationTypeDirectory,
        name,
        "lifecycle",
      );
      let lifecycle;
      try {
        lifecycle = openOwnedDirectory(
          lifecycleDirectory,
          allowPathFallbackForTesting,
        );
      } catch (error) {
        /* v8 ignore next -- only a missing lifecycle is optional; all other
           directory failures are owned-filesystem boundary behavior. */
        if (missing(error)) continue;
        /* v8 ignore next -- see the owned-directory propagation rationale above. */
        throw error;
      }
      let canonicalBytes: string | undefined;
      try {
        const intentRetirement = inspectOwnedFileRetirement(
          lifecycle,
          intentName,
          maximumMetadataBytes,
        );
        if (intentRetirement !== undefined)
          canonicalBytes = readOwnedRetirementUtf8(
            lifecycle,
            intentName,
            maximumMetadataBytes,
          ).content;
      } catch (error) {
        /* v8 ignore next -- only a missing intent is optional; malformed and
           bounded reads are exercised through the decoder/recovery tests. */
        if (!missing(error)) throw error;
      } finally {
        lifecycle.close();
      }
      if (canonicalBytes !== undefined)
        found.push(Object.freeze({ lifecycleDirectory, canonicalBytes }));
    }
    afterFirstScanForTesting?.();
    if (JSON.stringify(boundedOwnedNames(root, 128)) !== JSON.stringify(names))
      throw new LocalSqliteLifecycleError("reconciliation-required");
    return Object.freeze(found);
  } finally {
    root.close();
  }
};

const planFor = (
  home: LocalSqliteProductionHome,
  connectionId: string,
): LocalSqliteNamespacePlan =>
  planLocalSqliteNamespace({
    agentscopeHome: home.root,
    connectionId,
    /* v8 ignore next -- the currently admitted tuple is Linux x64; Windows path
       planning is covered by the pure namespace compiler. */
    platform: home.platform === "win32" ? "win32" : "posix",
  });

const evidenceFor = (
  plan: LocalSqliteNamespacePlan,
  filesystemProfile: string,
  allowPathFallbackForTesting: boolean,
): LocalSqlitePhysicalNamespaceEvidence => {
  const entries = [
    ["agentscope-home", plan.agentscopeHome],
    ["destinations", plan.destinationsDirectory],
    ["destination-type", plan.destinationTypeDirectory],
    ["connection-namespace", plan.connectionNamespace],
  ] as const;
  const existing: object[] = [];
  let firstAbsent: number = entries.length;
  for (let index = 0; index < entries.length; index += 1) {
    const [role, path] = entries[index]!;
    let directory: ReturnType<typeof openOwnedDirectory>;
    try {
      directory = openOwnedDirectory(path, allowPathFallbackForTesting);
    } catch (error) {
      /* v8 ignore next -- non-ENOENT directory failures are owned-filesystem
         boundary cases and never become planned-absence evidence. */
      if (missing(error)) {
        firstAbsent = index;
        break;
      }
      /* v8 ignore next -- see the owned-directory propagation rationale above. */
      throw error;
    }
    try {
      existing.push(
        Object.freeze({
          role,
          path,
          state: "existing",
          kind: "directory",
          physicalIdentity: `dev:${directory.device}:ino:${directory.inode}`,
          noFollow: true,
          currentUserOnly: directory.currentUserOnly,
        }),
      );
      directory.assertCurrent();
    } finally {
      directory.close();
    }
  }
  const planned = entries.slice(firstAbsent).map(([role, path]) =>
    Object.freeze({
      role,
      path,
      state: "planned-absent",
      noFollow: true,
      createMode: "current-user-only",
    }),
  );
  const parent = existing.at(-1) as
    | Readonly<{ role: string; path: string; physicalIdentity: string }>
    | undefined;
  const absent = planned[0] as
    Readonly<{ role: string; path: string }> | undefined;
  /* v8 ignore next -- the caller's already-open private home authority is always
     the first existing ancestor; home-authority tests reject absence earlier. */
  if (parent === undefined)
    throw new LocalSqliteLifecycleError("reconciliation-required");
  let collisionFree = true;
  if (absent !== undefined) {
    const parentDirectory = openOwnedDirectory(
      parent.path,
      allowPathFallbackForTesting,
    );
    try {
      /* v8 ignore next -- macOS resolves the case-fold alias as the existing
         path; the Linux source/CI matrix creates a distinct alias entry. */
      collisionFree = !boundedOwnedNames(parentDirectory, 128).some(
        (name) =>
          name.normalize("NFC").toLocaleLowerCase("en-US") ===
          basename(absent.path).normalize("NFC").toLocaleLowerCase("en-US"),
      );
    } finally {
      parentDirectory.close();
    }
  }
  /* v8 ignore next -- paired with the platform-specific collision oracle
     above; Linux rejects before any directory creation. */
  if (!collisionFree)
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return compileLocalSqlitePhysicalNamespaceEvidence(plan, {
    schemaVersion: 1,
    filesystemProfile,
    existingAncestors: existing as never,
    plannedAbsentAncestors: planned,
    absenceBoundary:
      absent === undefined
        ? null
        : {
            parentRole: parent.role as never,
            parentPath: parent.path,
            parentPhysicalIdentity: parent.physicalIdentity,
            firstAbsentRole: absent.role as never,
            firstAbsentPath: absent.path,
            noFollow: true,
            nameCollisionFree: true,
          },
  });
};

const lifecycleEvidence = (
  physical: LocalSqlitePhysicalNamespaceEvidence,
  plan: LocalSqliteNamespacePlan,
  policy: LocalResourceLifecyclePlanEvidence["retentionPolicy"],
): LocalResourceLifecyclePlanEvidence =>
  Object.freeze({
    namespaceFingerprint: physical.namespaceFingerprint,
    physicalEvidenceFingerprint: physical.fingerprint,
    displayPath: plan.connectionNamespace,
    persistentDataNotice: true,
    retentionPolicy: Object.freeze({ ...policy }),
  });

export const inspectLocalSqliteProductionPlan = (
  home: LocalSqliteProductionHome,
  filesystemProfile: string,
  connectionId: string,
  policy: LocalResourceLifecyclePlanEvidence["retentionPolicy"],
  allowPathFallbackForTesting = false,
): Readonly<{
  namespace: LocalSqliteNamespacePlan;
  evidence: LocalResourceLifecyclePlanEvidence;
}> => {
  const namespace = planFor(home, connectionId);
  return Object.freeze({
    namespace,
    evidence: lifecycleEvidence(
      evidenceFor(namespace, filesystemProfile, allowPathFallbackForTesting),
      namespace,
      policy,
    ),
  });
};

const candidatePath = (
  plan: LocalSqliteNamespacePlan,
  intent: LocalSqliteLifecycleIntent,
): string =>
  join(plan.connectionNamespace, `configure-${intent.transactionId}.sqlite`);

const planMatchesIntent = (
  plan: LocalSqliteNamespacePlan,
  intent: LocalSqliteLifecycleIntent,
): boolean =>
  plan.fingerprint === intent.namespaceFingerprint &&
  plan.connectionDigest === intent.connectionDigest;

const fenceRequest = (
  intent: LocalSqliteLifecycleIntent,
  owner: Readonly<{ pid: number; startIdentity: string }>,
) =>
  Object.freeze({
    transactionId: intent.transactionId,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    lifecycleGeneration: intent.capabilityVersion,
    purpose: "lifecycle" as const,
    owner,
  });

const mapFenceFailure = (state: string): never => {
  throw new LocalSqliteLifecycleError(
    /* v8 ignore next -- the fence contract exhaustively tests all three fixed
       outcomes; this adapter maps without inspecting content. */
    state === "busy"
      ? "busy"
      : state === "reconciliation-required"
        ? "reconciliation-required"
        : "unavailable",
  );
};

const assertFence = (
  fence: LocalSqliteExclusiveFenceAuthority,
  intent: LocalSqliteLifecycleIntent,
): void => {
  if (
    fence.record.transactionId !== intent.transactionId ||
    fence.record.lifecycleFingerprint !== intent.lifecycleFingerprint ||
    fence.record.lifecycleGeneration !== intent.capabilityVersion
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
};

const receiptMatches = (
  receipt: LocalSqliteOwnershipReceipt,
  intent: LocalSqliteLifecycleIntent,
): boolean =>
  receipt.connectionId === intent.connectionId &&
  receipt.connectionDigest === intent.connectionDigest &&
  receipt.namespaceFingerprint === intent.namespaceFingerprint &&
  receipt.lifecycleFingerprint === intent.lifecycleFingerprint &&
  receipt.recoveryHandlerId === intent.recoveryHandlerId &&
  receipt.artifactGrammarFingerprint === intent.artifactGrammarFingerprint &&
  receipt.destinationFormat === intent.destinationFormat &&
  receipt.migrationManifestId === intent.migrationManifestId &&
  receipt.protocolCompatibilityId === intent.protocolCompatibilityId;

const removeOwnershipReceipt = (
  lifecycle: ReturnType<typeof openOwnedDirectory>,
  intent: LocalSqliteLifecycleIntent,
): void => {
  const receiptState = inspectOwnedFileRetirement(
    lifecycle,
    receiptName,
    maximumMetadataBytes,
  );
  if (receiptState === undefined) return;
  const receipt = decodeLocalSqliteOwnershipReceipt(
    readOwnedRetirementUtf8(lifecycle, receiptName, maximumMetadataBytes)
      .content,
  );
  if (receipt === undefined || !receiptMatches(receipt, intent))
    throw new LocalSqliteLifecycleError("reconciliation-required");
  /* v8 ignore next 8 -- an exact retained receipt can fail removal only through
     the externally concurrent namespace-race outcome proved by the primitive. */
  if (
    retireOwnedFile(
      lifecycle,
      receiptName,
      receiptState.evidence.physicalIdentity,
    ) !== "removed"
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
};

const inspectOwnedDatabaseEvidence = (
  opener: OwnedSqliteOpener,
  directory: ReturnType<typeof openOwnedDirectory>,
  databaseName: string,
  allowPathFallbackForTesting: boolean,
  intent: LocalSqliteLifecycleIntent,
): Readonly<{ databaseFamilyPhysicalIdentity: string }> => {
  const databaseFile = openOwnedFile(
    directory,
    databaseName,
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  );
  const before = databaseFile.evidence;
  let database: OwnedSqliteConnection | undefined;
  try {
    if (before.bytes < 1 || before.sparse)
      throw new LocalSqliteLifecycleError("reconciliation-required");
    database = openOwnedSqliteDescriptor(
      opener,
      databaseFile,
      { fileMustExist: true, readonly: true },
      allowPathFallbackForTesting,
    );
    const quick = database.prepare("PRAGMA quick_check").get() as
      Record<string, unknown> | undefined;
    const metadata =
      createOwnedMigrationDatabase(database).readDestinationMetadata();
    /* v8 ignore next -- quick-check/metadata mismatch is covered by migration and
       sqlite-port hostile database tests; this adapter preserves the fixed result. */
    if (
      quick === undefined ||
      Object.values(quick)[0] !== "ok" ||
      metadata?.destinationFormat !== LOCAL_SQLITE_DESTINATION_FORMAT ||
      metadata.lifecycleCapabilityVersion !==
        localSqliteLifecycleDeclaration.capabilityVersion ||
      metadata.lifecycleFingerprint !== intent.lifecycleFingerprint ||
      metadata.migrationManifestId !== LOCAL_SQLITE_MIGRATION_MANIFEST_ID ||
      metadata.protocolCompatibilityId !==
        LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID ||
      metadata.recoveryHandlerId !== intent.recoveryHandlerId
    )
      throw new LocalSqliteLifecycleError("reconciliation-required");
    const after = databaseFile.assertCurrent();
    /* v8 ignore next -- identity/size drift requires mutation between same-handle
       stat calls and is exercised by owned-filesystem race tests. */
    if (
      after.physicalIdentity !== before.physicalIdentity ||
      after.bytes !== before.bytes
    )
      throw new LocalSqliteLifecycleError("reconciliation-required");
    return Object.freeze({
      databaseFamilyPhysicalIdentity: before.physicalIdentity,
    });
  } finally {
    database?.close();
    databaseFile.close();
  }
};

const retentionPolicy = (settings: unknown) => {
  if (typeof settings !== "object" || settings === null)
    throw new LocalSqliteLifecycleError("reconciliation-required");
  const value = settings as Record<string, unknown>;
  if (
    typeof value.maximumAgeNanoseconds !== "string" ||
    typeof value.maximumTraceCount !== "number" ||
    typeof value.maximumPayloadBytes !== "number"
  )
    throw new LocalSqliteLifecycleError("reconciliation-required");
  return Object.freeze({
    maximumAgeNanoseconds: value.maximumAgeNanoseconds,
    maximumTraceCount: value.maximumTraceCount,
    maximumPayloadBytes: value.maximumPayloadBytes,
    physicalCleanupTrigger: "next-authorized-mutation" as const,
  });
};

export const createLocalSqliteProductionLifecyclePort = (
  input: Readonly<{
    home: LocalSqliteProductionHome;
    filesystemProfile: string;
    opener: OwnedSqliteOpener;
    allowPathFallbackForTesting?: boolean;
    lifecycleAfterFirstIntentScanForTesting?: (() => void) | undefined;
  }>,
): LocalSqliteLifecyclePort => {
  const { home, filesystemProfile, opener } = input;
  const allowPathFallbackForTesting =
    input.allowPathFallbackForTesting === true;
  const gates = new Map<
    string,
    ReturnType<typeof createLocalSqliteFilesystemGatePort>
  >();
  const activeFences = new Map<string, LocalSqliteExclusiveFenceAuthority>();
  const localFenceOwner = Object.freeze({
    pid: process.pid,
    startIdentity: currentProcessStartIdentity(),
  });
  const gateFor = (directory: string) => {
    const existing = gates.get(directory);
    if (existing !== undefined) return existing;
    const created = createLocalSqliteFilesystemGatePort(directory, {
      allowPathFallbackForTesting: input.allowPathFallbackForTesting === true,
      atomicExchange: opener.exchangeOwnedFiles,
      lockOwnedFile: opener.lockOwnedFile,
      unlockOwnedFile: opener.unlockOwnedFile,
    });
    gates.set(directory, created);
    return created;
  };
  const plan = (connectionId: string) => planFor(home, connectionId);
  return Object.freeze({
    inspect: async (context: LocalResourceLifecycleContext) => {
      requireActive(context.signal);
      const namespace = plan(context.connectionId);
      const physical = evidenceFor(
        namespace,
        filesystemProfile,
        allowPathFallbackForTesting,
      );
      return lifecycleEvidence(
        physical,
        namespace,
        retentionPolicy(context.settings),
      );
    },
    inspectRetainedDelete: async (connectionId, signal) => {
      requireActive(signal);
      const namespace = plan(connectionId);
      const lifecycle = openOwnedDirectory(
        namespace.lifecycleDirectory,
        input.allowPathFallbackForTesting === true,
      );
      let canonical: string;
      try {
        if (
          optionalOwnedStat(lifecycle, receiptName, maximumMetadataBytes) ===
          undefined
        )
          return null;
        canonical = readOwnedUtf8(
          lifecycle,
          receiptName,
          maximumMetadataBytes,
        ).content;
      } finally {
        lifecycle.close();
      }
      const receipt = decodeLocalSqliteOwnershipReceipt(canonical);
      if (
        receipt === undefined ||
        receipt.connectionId !== connectionId ||
        physicalIdentity(
          namespace.databasePath,
          allowPathFallbackForTesting,
        ) !== receipt.databaseFamilyPhysicalIdentity
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
      const physical = evidenceFor(
        namespace,
        filesystemProfile,
        allowPathFallbackForTesting,
      );
      return Object.freeze({
        connectionId,
        connectionName: "retained" as const,
        planEvidence: lifecycleEvidence(
          physical,
          namespace,
          receipt.retentionPolicy,
        ),
        retainedAuthority: Object.freeze({
          receiptDigest: `sha256-${createHash("sha256").update(canonical).digest("hex")}`,
          databaseFamilyPhysicalIdentity:
            receipt.databaseFamilyPhysicalIdentity,
        }),
      });
    },
    publishIntent: async (intent, canonicalBytes, signal) => {
      requireActive(signal);
      const namespace = plan(intent.connectionId);
      const before = evidenceFor(
        namespace,
        filesystemProfile,
        allowPathFallbackForTesting,
      );
      if (
        !planMatchesIntent(namespace, intent) ||
        before.fingerprint !== intent.physicalEvidenceFingerprint
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
      for (const directory of [
        namespace.destinationsDirectory,
        namespace.destinationTypeDirectory,
        namespace.connectionNamespace,
        namespace.lifecycleDirectory,
        namespace.backupsDirectory,
      ])
        ensurePrivateDirectory(directory, { allowPathFallbackForTesting });
      writeExclusive(
        join(namespace.lifecycleDirectory, intentName),
        canonicalBytes,
        allowPathFallbackForTesting,
      );
    },
    acquireExclusiveFence: async (intent, signal) => {
      requireActive(signal);
      const namespace = plan(intent.connectionId);
      const result = await acquireLocalSqliteExclusiveFence(
        gateFor(namespace.lifecycleDirectory),
        fenceRequest(intent, localFenceOwner),
      );
      if (!result.ok) return mapFenceFailure(result.state);
      activeFences.set(intent.transactionId, result.value);
      return result.value;
    },
    revalidatePhysicalEvidence: async (intent, evidence, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const physical = evidenceFor(
        namespace,
        filesystemProfile,
        allowPathFallbackForTesting,
      );
      if (
        evidence.physicalEvidenceFingerprint !==
          intent.physicalEvidenceFingerprint ||
        physical.namespaceFingerprint !== intent.namespaceFingerprint ||
        physical.plannedAbsentAncestors.length !== 0
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
    },
    stageConfigure: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const candidate = candidatePath(namespace, intent);
      const directory = openOwnedDirectory(
        namespace.connectionNamespace,
        allowPathFallbackForTesting,
      );
      const candidateName = basename(candidate);
      const databaseName = basename(namespace.databasePath);
      let database: OwnedSqliteConnection | undefined;
      let candidateFile: OwnedFile | undefined;
      let candidatePhysicalIdentity: string | undefined;
      try {
        for (const name of [candidateName, databaseName])
          try {
            statOwnedFile(directory, name);
            throw new LocalSqliteLifecycleError("reconciliation-required");
          } catch (error) {
            if (
              error instanceof LocalSqliteLifecycleError ||
              typeof error !== "object" ||
              error === null ||
              !("code" in error) ||
              error.code !== "ENOENT"
            )
              throw error;
          }
        candidateFile = createOwnedExclusiveFile(
          directory,
          candidateName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        candidatePhysicalIdentity = candidateFile.evidence.physicalIdentity;
        database = openOwnedSqliteDescriptor(
          opener,
          candidateFile,
          { fileMustExist: true },
          allowPathFallbackForTesting,
        );
        database.pragma("journal_mode = DELETE");
        database.pragma("synchronous = FULL");
        database.pragma("auto_vacuum = FULL");
        const migrated = runLocalSqliteMigrations(
          createOwnedMigrationDatabase(database),
          Object.freeze({
            capabilityVersion:
              localSqliteLifecycleDeclaration.capabilityVersion,
            fingerprint: intent.lifecycleFingerprint,
            recoveryHandlerId: intent.recoveryHandlerId,
          }),
        );
        /* v8 ignore next -- the migration runner's complete failure matrix owns
           this branded result; the production adapter performs no translation. */
        if (!migrated.ok)
          throw new LocalSqliteLifecycleError("reconciliation-required");
        database.close();
        database = undefined;
        const state = candidateFile.sync();
        /* v8 ignore next -- a successful migration necessarily writes a nonempty
           nonsparse SQLite file; sync/file-shape negatives are primitive-tested. */
        if (state.bytes < 1 || state.sparse)
          throw new LocalSqliteLifecycleError("reconciliation-required");
      } catch (error) {
        database?.close();
        candidateFile?.close();
        candidateFile = undefined;
        /* v8 ignore next -- created-candidate cleanup is exercised by the native
           migration failure verifier; pre-existing candidates are source-tested. */
        if (
          candidatePhysicalIdentity !== undefined &&
          retireOwnedFile(
            directory,
            candidateName,
            candidatePhysicalIdentity,
          ) !== "removed"
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
        throw error;
      } finally {
        candidateFile?.close();
        directory.close();
      }
    },
    activateConfigure: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const candidate = candidatePath(namespace, intent);
      const directory = openOwnedDirectory(
        namespace.connectionNamespace,
        allowPathFallbackForTesting,
      );
      const lifecycle = openOwnedDirectory(
        namespace.lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      try {
        const candidateState = optionalOwnedStat(
          directory,
          basename(candidate),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        const activeState = optionalOwnedStat(
          directory,
          basename(namespace.databasePath),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        let phase = readLifecycleOperationPhase(lifecycle, intent);
        if (phase === undefined) {
          if (candidateState === undefined)
            throw new LocalSqliteLifecycleError("reconciliation-required");
          /* v8 ignore next 4 -- a different active inode before the operation
             phase is published is hostile pre-existing namespace evidence. */
          if (
            activeState !== undefined &&
            activeState.physicalIdentity !== candidateState.physicalIdentity
          )
            throw new LocalSqliteLifecycleError("reconciliation-required");
          phase = lifecyclePhaseFor(
            intent,
            "configured-active",
            candidateState.physicalIdentity,
          );
          publishLifecycleOperationPhase(lifecycle, phase);
        }
        /* v8 ignore next -- a verified phase with a different live inode requires
           post-publication substitution and must fail closed. */
        /* v8 ignore next -- the verified active identity is read from this same
           owned name; divergence requires a post-verification namespace race. */
        if (
          candidateState !== undefined &&
          (activeState === undefined ||
            activeState.physicalIdentity === candidateState.physicalIdentity) &&
          candidateState.physicalIdentity === phase.artifactPhysicalIdentity
        )
          renameOwnedFile(
            directory,
            basename(candidate),
            directory,
            basename(namespace.databasePath),
            candidateState.physicalIdentity,
          );
        else if (
          candidateState !== undefined ||
          activeState?.physicalIdentity !== phase.artifactPhysicalIdentity
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
        /* v8 ignore next -- retained identity admission is owned by the handler;
           direct mismatches are rejected before any database open/unlink. */
        if (
          inspectOwnedDatabaseEvidence(
            opener,
            directory,
            basename(namespace.databasePath),
            allowPathFallbackForTesting,
            intent,
          ).databaseFamilyPhysicalIdentity !== phase.artifactPhysicalIdentity
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
      } finally {
        lifecycle.close();
        directory.close();
      }
    },
    inspectOwnedDatabase: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const directory = openOwnedDirectory(
        namespace.connectionNamespace,
        allowPathFallbackForTesting,
      );
      try {
        return inspectOwnedDatabaseEvidence(
          opener,
          directory,
          basename(namespace.databasePath),
          allowPathFallbackForTesting,
          intent,
        );
      } finally {
        directory.close();
      }
    },
    publishOwnershipReceipt: async (receipt, canonicalBytes, fence, signal) => {
      requireActive(signal);
      if (fence.record.transactionId !== receipt.transactionId)
        throw new LocalSqliteLifecycleError("reconciliation-required");
      const namespace = plan(receipt.connectionId);
      writeExclusive(
        join(namespace.lifecycleDirectory, receiptName),
        canonicalBytes,
        allowPathFallbackForTesting,
      );
    },
    authenticateOwnershipReceipt: async (intent, fence, signal, authority) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const lifecycle = openOwnedDirectory(
        namespace.lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      const connection = openOwnedDirectory(
        namespace.connectionNamespace,
        allowPathFallbackForTesting,
      );
      try {
        const canonical = readOwnedUtf8(
          lifecycle,
          receiptName,
          maximumMetadataBytes,
        ).content;
        const receipt = decodeLocalSqliteOwnershipReceipt(canonical);
        const digest = `sha256-${createHash("sha256").update(canonical).digest("hex")}`;
        const activeState = optionalOwnedStat(
          connection,
          basename(namespace.databasePath),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        let phase = readLifecycleOperationPhase(lifecycle, intent);
        const identity =
          phase?.artifactPhysicalIdentity ?? activeState?.physicalIdentity;
        /* v8 ignore next -- a changed inventory/identity after the first bounded
           scan requires concurrent namespace mutation, primitive-tested below. */
        if (
          identity === undefined ||
          receipt === undefined ||
          !receiptMatches(receipt, intent) ||
          receipt.databaseFamilyPhysicalIdentity !== identity ||
          (activeState !== undefined &&
            activeState.physicalIdentity !== identity) ||
          (authority !== undefined &&
            (authority.receiptDigest !== digest ||
              authority.databaseFamilyPhysicalIdentity !== identity)) ||
          (intent.retainedReceiptDigest !== null &&
            (intent.retainedReceiptDigest !== digest ||
              intent.retainedDatabaseFamilyPhysicalIdentity !== identity))
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
        if (phase === undefined) {
          phase = lifecyclePhaseFor(intent, "database-deleted", identity);
          publishLifecycleOperationPhase(lifecycle, phase);
        }
      } finally {
        connection.close();
        lifecycle.close();
      }
    },
    claimRecoveryIntent: async (context) => {
      requireActive(context.signal);
      const namespace = plan(context.connectionId);
      let lifecycle;
      try {
        lifecycle = openOwnedDirectory(
          namespace.lifecycleDirectory,
          input.allowPathFallbackForTesting === true,
        );
      } catch (error) {
        /* v8 ignore else -- only missing is translated here; other retained-directory
           failures are exhaustively classified by the filesystem primitive. */
        if (missing(error))
          throw new LocalSqliteLifecycleError("reconciliation-required");
        /* v8 ignore next -- non-missing owned-directory failures are exhaustively
           classified by the retained-directory primitive tests. */
        throw error;
      }
      let firstIntent;
      let secondIntent;
      let fenceState;
      let fenceContent: string | undefined;
      try {
        firstIntent = readOwnedUtf8(
          lifecycle,
          intentName,
          maximumMetadataBytes,
        );
        input.lifecycleAfterFirstIntentScanForTesting?.();
        secondIntent = readOwnedUtf8(
          lifecycle,
          intentName,
          maximumMetadataBytes,
        );
        const retirement = inspectOwnedFileRetirement(
          lifecycle,
          fenceName,
          maximumMetadataBytes,
        );
        if (retirement !== undefined) {
          const read = readOwnedRetirementUtf8(
            lifecycle,
            fenceName,
            maximumMetadataBytes,
          );
          /* v8 ignore next 5 -- identity drift between retained reads requires
             external concurrent namespace substitution. */
          if (
            read.retirement.evidence.physicalIdentity !==
            retirement.evidence.physicalIdentity
          )
            throw new LocalSqliteLifecycleError("reconciliation-required");
          fenceState = retirement.evidence;
          fenceContent = read.content;
        }
      } catch (error) {
        /* v8 ignore else -- only missing is translated here; other no-follow read
           failures are exhaustively classified by the filesystem primitive. */
        if (missing(error))
          throw new LocalSqliteLifecycleError("reconciliation-required");
        /* v8 ignore next -- non-missing no-follow read failures are owned by the
           bounded filesystem primitive tests. */
        throw error;
      } finally {
        lifecycle.close();
      }
      if (
        firstIntent.content !== secondIntent.content ||
        firstIntent.evidence.physicalIdentity !==
          secondIntent.evidence.physicalIdentity
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
      const canonicalBytes = secondIntent.content;
      const intent = decodeLocalSqliteLifecycleIntent(canonicalBytes);
      if (
        intent === undefined ||
        intent.connectionId !== context.connectionId ||
        intent.transactionId !== context.operationId
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
      if (fenceState === undefined) {
        const acquired = await acquireLocalSqliteExclusiveFence(
          gateFor(namespace.lifecycleDirectory),
          fenceRequest(intent, localFenceOwner),
        );
        /* v8 ignore next -- competing/malformed fence outcomes are exhaustively
           covered by the fence module and acquireExclusiveFence adapter path. */
        if (!acquired.ok) return mapFenceFailure(acquired.state);
        activeFences.set(intent.transactionId, acquired.value);
        return Object.freeze({ canonicalBytes, fence: acquired.value });
      }
      const record = decodeLocalSqliteFenceRecord(fenceContent);
      /* v8 ignore next -- existing-fence malformed/cross-intent bytes are covered
         by fence decoding and the ordinary acquisition hostile test. */
      if (
        record === undefined ||
        record.transactionId !== intent.transactionId ||
        record.lifecycleFingerprint !== intent.lifecycleFingerprint
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
      const retained = activeFences.get(intent.transactionId);
      /* v8 ignore else -- same-process retries reuse the retained authority;
         restart adoption is proved by the built recovery verifier and fence suite. */
      if (
        retained !== undefined &&
        retained.physicalIdentity === fenceState.physicalIdentity &&
        record.purpose === "lifecycle" &&
        record.owner.pid === localFenceOwner.pid &&
        record.owner.startIdentity === localFenceOwner.startIdentity
      )
        return Object.freeze({ canonicalBytes, fence: retained });
      /* v8 ignore start -- historical-process fence adoption is causally covered by
         the built recovery verifier; the fence module exhaustively maps outcomes. */
      const resumed = await resumeLocalSqliteLifecycleFence(
        gateFor(namespace.lifecycleDirectory),
        {
          physicalIdentity: fenceState.physicalIdentity,
          record,
        },
      );
      if (!resumed.ok) return mapFenceFailure(resumed.state);
      activeFences.set(intent.transactionId, resumed.value);
      return Object.freeze({ canonicalBytes, fence: resumed.value });
      /* v8 ignore stop */
    },
    rollbackPrepared: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const lifecycle = openOwnedDirectory(
        namespace.lifecycleDirectory,
        allowPathFallbackForTesting,
      );
      try {
        /* v8 ignore next -- a valid durable terminal phase is exercised by the
           full recovery flow; rollback must conservatively refuse it. */
        if (readLifecycleOperationPhase(lifecycle, intent) !== undefined)
          throw new LocalSqliteLifecycleError("reconciliation-required");
      } finally {
        lifecycle.close();
      }
      removeIfPresent(
        candidatePath(namespace, intent),
        allowPathFallbackForTesting,
      );
      if (intent.operation === "unconfigure")
        removeIfPresent(
          join(namespace.lifecycleDirectory, receiptName),
          allowPathFallbackForTesting,
        );
    },
    verifyRetainedDatabase: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const receipt = decodeLocalSqliteOwnershipReceipt(
        readBounded(
          join(namespace.lifecycleDirectory, receiptName),
          allowPathFallbackForTesting,
        ),
      );
      /* v8 ignore next -- receipt/active identity substitutions are separately
         exercised by receipt and owned-filesystem tests. */
      if (
        receipt === undefined ||
        !receiptMatches(receipt, intent) ||
        receipt.databaseFamilyPhysicalIdentity !==
          physicalIdentity(namespace.databasePath, allowPathFallbackForTesting)
      )
        throw new LocalSqliteLifecycleError("reconciliation-required");
    },
    deleteOwnedDatabaseFamily: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const connection = openOwnedDirectory(
        namespace.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      const lifecycle = openOwnedDirectory(
        namespace.lifecycleDirectory,
        input.allowPathFallbackForTesting === true,
      );
      const databaseName = basename(namespace.databasePath);
      const familyNames = [
        databaseName,
        `${databaseName}-wal`,
        `${databaseName}-shm`,
        `${databaseName}-journal`,
      ] as const;
      try {
        let phase = readLifecycleOperationPhase(lifecycle, intent);
        const initialNames = boundedOwnedNames(connection, 128);
        const initialClaims = initialNames.filter(
          (name) => decodeLocalSqliteNamespaceClaimName(name) !== undefined,
        );
        /* v8 ignore next -- missing/mismatched retained authority is rejected by
           the lifecycle handler before this destructive port call. */
        if (
          initialClaims.length > 1 ||
          initialNames.some((name) => {
            const claimedName = decodeLocalSqliteNamespaceClaimName(name);
            return (
              name !== "lifecycle" &&
              name !== "backups" &&
              !familyNames.includes(name) &&
              (claimedName === undefined || !familyNames.includes(claimedName))
            );
          })
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
        for (const directoryName of ["lifecycle", "backups"]) {
          const directory = openOwnedDirectory(
            join(connection.relativeRoot, directoryName),
            input.allowPathFallbackForTesting === true,
          );
          directory.close();
        }
        const activeRetirement = inspectOwnedFileRetirement(
          connection,
          databaseName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        const activeState = activeRetirement?.evidence;
        /* v8 ignore next -- phase-present and active-present authorities are both
           exercised by recovery/normal delete; optional chaining has no semantics. */
        const expectedIdentity =
          phase?.artifactPhysicalIdentity ?? activeState?.physicalIdentity;
        /* v8 ignore next -- retained identity mismatch is rejected by the handler
           before this destructive port call; direct invocation remains fail-closed. */
        if (
          expectedIdentity === undefined ||
          expectedIdentity !== intent.retainedDatabaseFamilyPhysicalIdentity ||
          (activeState !== undefined &&
            activeState.physicalIdentity !== expectedIdentity)
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
        /* v8 ignore next -- normal delete publishes this phase; recovery enters
           with the already-authenticated durable phase. */
        if (phase === undefined) {
          phase = lifecyclePhaseFor(
            intent,
            "database-deleted",
            expectedIdentity,
          );
          publishLifecycleOperationPhase(lifecycle, phase);
        }
        if (
          activeState !== undefined &&
          activeRetirement?.state !== "claim-only"
        ) {
          const activeFile = openOwnedFile(
            connection,
            databaseName,
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
            { writable: true, requireNonempty: true },
          );
          const database = openOwnedSqliteDescriptor(
            opener,
            activeFile,
            { fileMustExist: true },
            allowPathFallbackForTesting,
          );
          try {
            database.pragma("wal_checkpoint(TRUNCATE)");
            activeFile.assertCurrent();
          } finally {
            database.close();
            activeFile.close();
          }
        }
        const exactFamily = familyNames.flatMap((name) => {
          const state = inspectOwnedFileRetirement(
            connection,
            name,
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          );
          return state === undefined
            ? []
            : [Object.freeze({ name, state: state.evidence })];
        });
        const confirmedNames = boundedOwnedNames(connection, 128);
        const confirmedClaims = confirmedNames.filter(
          (name) => decodeLocalSqliteNamespaceClaimName(name) !== undefined,
        );
        /* v8 ignore next -- a changed bounded inventory requires concurrent
           namespace mutation and is primitive-tested. */
        if (
          confirmedClaims.length > 1 ||
          confirmedNames.some((name) => {
            const claimedName = decodeLocalSqliteNamespaceClaimName(name);
            return (
              name !== "lifecycle" &&
              name !== "backups" &&
              !familyNames.includes(name) &&
              (claimedName === undefined || !familyNames.includes(claimedName))
            );
          }) ||
          (activeState !== undefined &&
            exactFamily.find(({ name }) => name === databaseName)?.state
              .physicalIdentity !== activeState.physicalIdentity)
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
        for (const { name, state } of exactFamily
          .filter(({ name }) => name !== databaseName)
          .concat(exactFamily.filter(({ name }) => name === databaseName)))
          /* v8 ignore next -- same-handle replacement between inventory and unlink
             is covered by the owned-filesystem removal-race tests. */
          if (
            retireOwnedFile(connection, name, state.physicalIdentity) !==
            "removed"
          )
            throw new LocalSqliteLifecycleError("reconciliation-required");
        /* v8 ignore next -- a residual active name requires a concurrent recreate
           after exact unlink and is covered at the primitive boundary. */
        if (
          optionalOwnedStat(
            connection,
            databaseName,
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          ) !== undefined
        )
          throw new LocalSqliteLifecycleError("reconciliation-required");
      } finally {
        lifecycle.close();
        connection.close();
      }
    },
    finalize: async (intent, fence, signal) => {
      requireActive(signal);
      assertFence(fence, intent);
      const namespace = plan(intent.connectionId);
      const released = await releaseLocalSqliteExclusiveFence(
        gateFor(namespace.lifecycleDirectory),
        fence,
      );
      /* v8 ignore next -- release races/failures are exhaustively covered by the
         fence module; this adapter preserves its fixed classification. */
      if (!released.ok) mapFenceFailure(released.state);
      activeFences.delete(intent.transactionId);
    },
    completeFinalization: async (transactionId, signal) => {
      requireActive(signal);
      const destinations = join(home.root, "destinations", "local-sqlite");
      for (const located of scanLifecycleIntents(
        destinations,
        allowPathFallbackForTesting,
        input.lifecycleAfterFirstIntentScanForTesting,
      )) {
        const lifecycle = located.lifecycleDirectory;
        const intent = decodeLocalSqliteLifecycleIntent(located.canonicalBytes);
        if (intent?.transactionId !== transactionId) continue;
        const retainedFence = activeFences.get(transactionId);
        if (retainedFence !== undefined) {
          const released = await releaseLocalSqliteExclusiveFence(
            gateFor(lifecycle),
            retainedFence,
          );
          /* v8 ignore next -- retained-fence release failure mapping is proved by
             the fence suite; this completion path preserves the fixed outcome. */
          if (!released.ok) mapFenceFailure(released.state);
          activeFences.delete(transactionId);
        }
        const ownedLifecycle = openOwnedDirectory(
          lifecycle,
          input.allowPathFallbackForTesting === true,
        );
        try {
          if (intent.operation === "delete")
            removeOwnershipReceipt(ownedLifecycle, intent);
          removeLifecycleOperationPhase(ownedLifecycle, intent);
          const state = inspectOwnedFileRetirement(
            ownedLifecycle,
            fenceName,
            maximumMetadataBytes,
          );
          /* v8 ignore next -- ordinary finalization releases the fence first; this
             branch is the bounded crash-prefix cleanup path. */
          if (state !== undefined) {
            const record = decodeLocalSqliteFenceRecord(
              readOwnedRetirementUtf8(
                ownedLifecycle,
                fenceName,
                maximumMetadataBytes,
              ).content,
            );
            /* v8 ignore next -- a same-name fence substitution after intent scan is
               covered by fence/owned-filesystem race tests. */
            if (record?.transactionId !== transactionId)
              throw new LocalSqliteLifecycleError("reconciliation-required");
            /* v8 ignore next -- fence replacement between retained stat/unlink is
               covered by the owned-filesystem primitive. */
            if (
              retireOwnedFile(
                ownedLifecycle,
                fenceName,
                state.evidence.physicalIdentity,
              ) !== "removed"
            )
              throw new LocalSqliteLifecycleError("reconciliation-required");
          }
          const intentState = inspectOwnedFileRetirement(
            ownedLifecycle,
            intentName,
            maximumMetadataBytes,
          )?.evidence;
          /* v8 ignore next -- the scan above read this exact public/claim intent. */
          if (intentState === undefined)
            throw new LocalSqliteLifecycleError("reconciliation-required");
          /* v8 ignore next -- intent replacement between retained stat/unlink is
             covered by the owned-filesystem primitive. */
          if (
            retireOwnedFile(
              ownedLifecycle,
              intentName,
              intentState.physicalIdentity,
            ) !== "removed"
          )
            throw new LocalSqliteLifecycleError("reconciliation-required");
        } finally {
          ownedLifecycle.close();
        }
        return;
      }
    },
  });
};
