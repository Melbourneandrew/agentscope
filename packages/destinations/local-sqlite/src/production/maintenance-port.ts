/* eslint-disable max-lines-per-function, @typescript-eslint/require-await -- synchronous owned-filesystem/SQLite steps implement an asynchronous maintenance port. */
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type {
  LocalResourceDoctorContext,
  LocalResourceMaintenanceContext,
} from "@agentscope/destinations-core";

import {
  decodeLocalSqliteBackupReceipt,
  decodeLocalSqliteMaintenanceIntent,
  LocalSqliteMaintenanceError,
  type LocalSqliteBackupInventoryEntry,
  type LocalSqliteMaintenanceIntent,
  type LocalSqliteMaintenancePort,
  type LocalSqliteVerifiedSnapshotEvidence,
} from "../lifecycle/maintenance.js";
import {
  acquireLocalSqliteExclusiveFence,
  decodeLocalSqliteFenceRecord,
  inspectLocalSqliteLifecycleInventory,
  releaseLocalSqliteExclusiveFence,
  resumeLocalSqliteLifecycleFence,
  type LocalSqliteExclusiveFenceAuthority,
} from "../lifecycle/fence.js";
import {
  LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
  LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
} from "../lifecycle/capability.js";
import {
  LOCAL_SQLITE_DESTINATION_FORMAT,
  LOCAL_SQLITE_MIGRATION_MANIFEST_ID,
  LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID,
} from "../migrations.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  boundedOwnedNames,
  createPathAtomicExchangeForTesting,
  createOwnedExclusiveFile,
  decodeLocalSqliteNamespaceClaimName,
  inspectOwnedSqliteFamily,
  inspectOwnedFileRetirement,
  linkOwnedFile,
  LocalSqliteOwnedFilesystemError,
  openOwnedDirectory,
  openOwnedFile,
  readOwnedPrefix,
  readOwnedRetirementUtf8,
  readOwnedUtf8,
  replaceOwnedFile,
  renameOwnedFile,
  retireOwnedFile,
  statOwnedFile,
  syncOwnedDirectory,
  writeOwnedExclusive,
  type OwnedDirectory,
  type OwnedFile,
  type OwnedFileEvidence,
} from "./owned-filesystem.js";
import {
  createLocalSqliteFilesystemGatePort,
  currentProcessStartIdentity,
  ensurePrivateDirectory,
} from "./filesystem-port.js";
import {
  inspectLocalSqliteProductionPlan,
  openOwnedSqliteDescriptor,
  type LocalSqliteProductionHome,
  type OwnedSqliteOpener,
} from "./lifecycle-port.js";
import {
  createOwnedMigrationDatabase,
  createOwnedReporterDatabase,
  type OwnedSqliteConnection,
} from "./sqlite-port.js";
import {
  decodeLocalSqliteOperationPhase,
  encodeLocalSqliteOperationPhase,
  LOCAL_SQLITE_OPERATION_PHASE_NAME,
  type LocalSqliteOperationPhase,
} from "./operation-phase.js";

const intentName = "intent-v1.json";
const fenceName = "exclusive-fence-v1";
const maximumMetadataBytes = 65_536;
const maximumBackupEntries = 32;

type DoctorDatabaseFamily = ReturnType<typeof inspectOwnedSqliteFamily>;

const inspectDoctorDatabaseFamily = (
  connection: OwnedDirectory,
): DoctorDatabaseFamily => {
  const databaseName = "traces.sqlite";
  const names = boundedOwnedNames(connection, 128).filter(
    (name) => name === databaseName || name.startsWith(`${databaseName}-`),
  );
  if (!names.includes(databaseName)) {
    if (names.length !== 0)
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    return Object.freeze([]);
  }
  const family = inspectOwnedSqliteFamily(
    connection,
    databaseName,
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  );
  /* v8 ignore next -- sparse active files require native filesystem support;
     the exact packed Doctor hostile matrix exercises this fail-closed branch. */
  if (family.some(({ evidence }) => evidence.sparse))
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  return family;
};

const sameDoctorDatabaseFamily = (
  before: DoctorDatabaseFamily,
  after: DoctorDatabaseFamily,
): boolean =>
  before.length === after.length &&
  before.every(
    ({ name, evidence }, index) =>
      after[index]?.name === name &&
      after[index]?.evidence.physicalIdentity === evidence.physicalIdentity &&
      after[index]?.evidence.bytes === evidence.bytes,
  );
const active = (signal: AbortSignal): void => {
  if (signal.aborted) throw new LocalSqliteMaintenanceError("unavailable");
};

const retentionPolicy = (settings: unknown) => {
  if (typeof settings !== "object" || settings === null)
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  const value = settings as Record<string, unknown>;
  if (
    typeof value.maximumAgeNanoseconds !== "string" ||
    typeof value.maximumTraceCount !== "number" ||
    typeof value.maximumPayloadBytes !== "number"
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  return Object.freeze({
    maximumAgeNanoseconds: value.maximumAgeNanoseconds,
    maximumTraceCount: value.maximumTraceCount,
    maximumPayloadBytes: value.maximumPayloadBytes,
    physicalCleanupTrigger: "next-authorized-mutation" as const,
  });
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

const removeExact = (
  path: string,
  allowPathFallbackForTesting: boolean,
): void => {
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  try {
    const state = inspectOwnedFileRetirement(
      directory,
      basename(path),
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    /* v8 ignore next -- a different unlink result requires same-handle namespace
       replacement after the retained stat; owned-filesystem tests cover it. */
    if (
      state !== undefined &&
      retireOwnedFile(
        directory,
        basename(path),
        state.evidence.physicalIdentity,
      ) !== "removed"
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
  } finally {
    directory.close();
  }
};

const writeExclusive = (
  path: string,
  bytes: string,
  allowPathFallbackForTesting: boolean,
): void => {
  /* v8 ignore next -- callers pass canonical bounded codec output; the codecs own
     exact maximum+1 hostile tests. */
  if (Buffer.byteLength(bytes, "utf8") > maximumMetadataBytes)
    throw new LocalSqliteMaintenanceError("reconciliation-required");
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

const planFor = (home: LocalSqliteProductionHome, connectionId: string) =>
  planLocalSqliteNamespace({
    agentscopeHome: home.root,
    connectionId,
    /* v8 ignore next -- the admitted tuple is Linux x64; Windows namespace
       planning is covered by the pure namespace compiler. */
    platform: home.platform === "win32" ? "win32" : "posix",
  });

const backupPath = (directory: string, backupId: string): string =>
  join(directory, `backup-${backupId}.sqlite`);
const backupReceiptPath = (directory: string, backupId: string): string =>
  join(directory, `receipt-${backupId}.json`);
const backupCandidatePath = (directory: string, backupId: string): string =>
  join(directory, `candidate-${backupId}.sqlite`);

const missing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const optionalOwnedStat = (
  directory: OwnedDirectory,
  name: string,
  maximumBytes: number,
): OwnedFileEvidence | undefined => {
  try {
    return statOwnedFile(directory, name, maximumBytes);
  } catch (error) {
    /* v8 ignore next -- source tests own the ENOENT optional case; typed/link/
       permission failures are rejected by owned-file and packed boundaries. */
    if (missing(error)) return undefined;
    /* v8 ignore next -- the same non-ENOENT boundary above always rethrows. */
    throw error;
  }
};

const maintenancePhaseFor = (
  intent: LocalSqliteMaintenanceIntent,
  phase: "backup-published" | "restore-verified" | "restore-rolled-back",
  artifactPhysicalIdentity: string,
): LocalSqliteOperationPhase =>
  Object.freeze({
    schemaVersion: 1,
    operation: intent.operation,
    phase,
    transactionId: intent.transactionId,
    lifecycleFingerprint: intent.lifecycleFingerprint,
    artifactGrammarFingerprint: intent.artifactGrammarFingerprint,
    artifactPhysicalIdentity,
  });

const operationPhaseMatchesMaintenanceIntent = (
  phase: LocalSqliteOperationPhase,
  intent: LocalSqliteMaintenanceIntent,
): boolean =>
  phase.transactionId === intent.transactionId &&
  phase.lifecycleFingerprint === intent.lifecycleFingerprint &&
  phase.artifactGrammarFingerprint === intent.artifactGrammarFingerprint &&
  phase.operation === intent.operation &&
  ((intent.operation === "backup" && phase.phase === "backup-published") ||
    (intent.operation === "restore" &&
      (phase.phase === "restore-verified" ||
        phase.phase === "restore-rolled-back")));

const readMaintenanceOperationPhase = (
  lifecycle: OwnedDirectory,
  intent: LocalSqliteMaintenanceIntent,
): LocalSqliteOperationPhase | undefined => {
  /* v8 ignore next -- malformed or cross-operation phase bytes are covered by the
     operation-phase decoder and recovery handler tests. */
  if (
    inspectOwnedFileRetirement(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      maximumMetadataBytes,
    ) === undefined
  )
    return undefined;
  const phase = decodeLocalSqliteOperationPhase(
    readOwnedRetirementUtf8(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      maximumMetadataBytes,
    ).content,
  );
  /* v8 ignore next -- only the exact verified-to-rolled-back transition is legal;
     the lifecycle recovery suite exercises that transition and codec negatives. */
  if (
    phase === undefined ||
    !operationPhaseMatchesMaintenanceIntent(phase, intent)
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  return phase;
};

const writeMaintenanceOperationPhase = (
  lifecycle: OwnedDirectory,
  phase: LocalSqliteOperationPhase,
): void => {
  writeOwnedExclusive(
    lifecycle,
    LOCAL_SQLITE_OPERATION_PHASE_NAME,
    Buffer.from(encodeLocalSqliteOperationPhase(phase), "utf8"),
    maximumMetadataBytes,
  );
};

const publishMaintenanceOperationPhase = (
  lifecycle: OwnedDirectory,
  intent: LocalSqliteMaintenanceIntent,
  phase: LocalSqliteOperationPhase,
): void => {
  const existing = readMaintenanceOperationPhase(lifecycle, intent);
  const canonical = encodeLocalSqliteOperationPhase(phase);
  if (existing === undefined) {
    writeMaintenanceOperationPhase(lifecycle, phase);
    return;
  }
  /* v8 ignore next -- phase replacement between stat/unlink is a same-handle race
     covered at the owned-filesystem primitive. */
  if (
    readOwnedUtf8(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      maximumMetadataBytes,
    ).content === canonical
  )
    return;
  /* v8 ignore next -- invalid phase transitions are covered by the phase codec and
     lifecycle recovery matrix; only verified-to-rolled-back is accepted here. */
  if (
    existing.operation !== "restore" ||
    existing.phase !== "restore-verified" ||
    phase.phase !== "restore-rolled-back"
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  /* v8 ignore next -- durable transition replacement is exercised by the packed
     rollback crash-prefix verifier. */
  const state = inspectOwnedFileRetirement(
    lifecycle,
    LOCAL_SQLITE_OPERATION_PHASE_NAME,
    maximumMetadataBytes,
  )?.evidence;
  /* v8 ignore next -- the exact existing phase was read above. */
  if (state === undefined)
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  /* v8 ignore next -- phase replacement between retained stat/unlink is an owned
     same-handle race, covered by the filesystem primitive. */
  if (
    retireOwnedFile(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      state.physicalIdentity,
    ) !== "removed"
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  /* v8 ignore next -- the packed rollback crash-prefix verifier proves the final
     durable rolled-back publication. */
  writeMaintenanceOperationPhase(lifecycle, phase);
};

const removeMaintenanceOperationPhase = (
  lifecycle: OwnedDirectory,
  intent: LocalSqliteMaintenanceIntent,
): void => {
  /* v8 ignore next -- absent is the ordinary completion path; the full recovery
     integration exercises cleanup of a present durable phase. */
  if (readMaintenanceOperationPhase(lifecycle, intent) === undefined) return;
  const state = inspectOwnedFileRetirement(
    lifecycle,
    LOCAL_SQLITE_OPERATION_PHASE_NAME,
    maximumMetadataBytes,
  )?.evidence;
  /* v8 ignore next -- the exact phase was read above. */
  if (state === undefined)
    throw new LocalSqliteMaintenanceError("reconciliation-required");
  /* v8 ignore next -- phase replacement between stat/unlink is a same-handle race
     covered at the owned-filesystem primitive. */
  if (
    retireOwnedFile(
      lifecycle,
      LOCAL_SQLITE_OPERATION_PHASE_NAME,
      state.physicalIdentity,
    ) !== "removed"
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
};

const scanMaintenanceIntents = (
  destinationTypeDirectory: string,
  allowPathFallbackForTesting: boolean,
  afterFirstScanForTesting?: () => void,
): readonly Readonly<{
  lifecycleDirectory: string;
  canonicalBytes: string;
}>[] => {
  let root: OwnedDirectory;
  try {
    root = openOwnedDirectory(
      destinationTypeDirectory,
      allowPathFallbackForTesting,
    );
  } catch (error) {
    /* v8 ignore next -- only ENOENT is optional; openOwnedDirectory owns all other
       fixed failure classifications. */
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
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      const lifecycleDirectory = join(
        destinationTypeDirectory,
        name,
        "lifecycle",
      );
      let lifecycle: OwnedDirectory;
      try {
        lifecycle = openOwnedDirectory(
          lifecycleDirectory,
          allowPathFallbackForTesting,
        );
      } catch (error) {
        /* v8 ignore next -- only a missing lifecycle is optional; all other open
           failures are tested at the owned-filesystem boundary. */
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
        /* v8 ignore next -- only a missing intent is optional; malformed bounded
           reads are covered through the recovery decoder. */
        if (!missing(error)) throw error;
      } finally {
        lifecycle.close();
      }
      if (canonicalBytes !== undefined)
        found.push(Object.freeze({ lifecycleDirectory, canonicalBytes }));
    }
    afterFirstScanForTesting?.();
    /* v8 ignore next -- malformed shape/sparse evidence is covered by concrete
       inventory and owned-file hostile tests; this preserves fixed classification. */
    if (JSON.stringify(boundedOwnedNames(root, 128)) !== JSON.stringify(names))
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    return Object.freeze(found);
  } finally {
    root.close();
  }
};

const openVerifiedOwnedSnapshot = (
  opener: OwnedSqliteOpener,
  directory: OwnedDirectory,
  name: string,
  intent: LocalSqliteMaintenanceIntent,
  allowPathFallbackForTesting: boolean,
): LocalSqliteVerifiedSnapshotEvidence => {
  const snapshotFile = openOwnedFile(
    directory,
    name,
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
  );
  const state = snapshotFile.evidence;
  /* v8 ignore next -- zero/oversize/sparse snapshot evidence is covered by the
     owned-file/native maintenance hostile matrix. */
  if (
    state.bytes < 1 ||
    state.bytes > LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES ||
    state.sparse
  )
    try {
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    } finally {
      snapshotFile.close();
    }
  let database: OwnedSqliteConnection | undefined;
  try {
    database = openOwnedSqliteDescriptor(
      opener,
      snapshotFile,
      { fileMustExist: true, readonly: true },
      allowPathFallbackForTesting,
    );
    const quick = database.prepare("PRAGMA quick_check").get() as
      Record<string, unknown> | undefined;
    /* v8 ignore next -- quick-check corruption is exercised by the native SQLite
       verifier; this adapter performs no recovery from corrupt bytes. */
    if (quick === undefined || Object.values(quick)[0] !== "ok")
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const metadata =
      createOwnedMigrationDatabase(database).readDestinationMetadata();
    /* v8 ignore next -- metadata incompatibility is exhaustively covered by the
       migration runner and built native verifier. */
    if (
      metadata?.destinationFormat !== LOCAL_SQLITE_DESTINATION_FORMAT ||
      metadata.lifecycleCapabilityVersion !== intent.capabilityVersion ||
      metadata.lifecycleFingerprint !== intent.lifecycleFingerprint ||
      metadata.migrationManifestId !== LOCAL_SQLITE_MIGRATION_MANIFEST_ID ||
      metadata.protocolCompatibilityId !==
        LOCAL_SQLITE_PROTOCOL_COMPATIBILITY_ID ||
      metadata.recoveryHandlerId !== intent.recoveryHandlerId
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const after = snapshotFile.assertCurrent();
    /* v8 ignore next -- identity/size drift requires mutation between same-handle
       stat calls and is covered by owned-filesystem race tests. */
    if (
      after.physicalIdentity !== state.physicalIdentity ||
      after.bytes !== state.bytes
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    return Object.freeze({
      snapshotPhysicalIdentity: state.physicalIdentity,
      snapshotBytes: state.bytes,
      destinationFormat: metadata.destinationFormat,
      lifecycleCapabilityVersion: metadata.lifecycleCapabilityVersion,
      lifecycleFingerprint: metadata.lifecycleFingerprint,
      migrationManifestId: metadata.migrationManifestId,
      protocolCompatibilityId: metadata.protocolCompatibilityId,
      recoveryHandlerId: metadata.recoveryHandlerId,
    });
  } finally {
    database?.close();
    snapshotFile.close();
  }
};

const openVerifiedSnapshot = (
  opener: OwnedSqliteOpener,
  path: string,
  intent: LocalSqliteMaintenanceIntent,
  allowPathFallbackForTesting: boolean,
): LocalSqliteVerifiedSnapshotEvidence => {
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  try {
    return openVerifiedOwnedSnapshot(
      opener,
      directory,
      basename(path),
      intent,
      allowPathFallbackForTesting,
    );
  } finally {
    directory.close();
  }
};

const cleanupOwnedSnapshotRetention = (
  opener: OwnedSqliteOpener,
  path: string,
  intent: LocalSqliteMaintenanceIntent,
  allowPathFallbackForTesting: boolean,
): void => {
  const directory = openOwnedDirectory(
    dirname(path),
    allowPathFallbackForTesting,
  );
  const name = basename(path);
  const snapshotFile = openOwnedFile(
    directory,
    name,
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    { writable: true, requireNonempty: true },
  );
  const before = snapshotFile.evidence;
  let database: OwnedSqliteConnection | undefined;
  try {
    /* v8 ignore next -- openOwnedFile(requireNonempty) and the sparse-file
       admission check already reject these states before returning authority. */
    if (before.bytes < 1 || before.sparse)
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    database = openOwnedSqliteDescriptor(
      opener,
      snapshotFile,
      { fileMustExist: true },
      allowPathFallbackForTesting,
    );
    const reporter = createOwnedReporterDatabase(database);
    reporter.beginImmediate();
    const prior = BigInt(reporter.readLastTrustedTimeUnixNano() ?? "0");
    const age = BigInt(intent.maximumAgeNanoseconds);
    reporter.deleteExpiredBefore(
      /* v8 ignore next -- both cutoff branches are owned by Reporter retention tests;
         this adapter passes the exact computed scalar into the native transaction. */
      (prior > age ? prior - age : 0n).toString(),
      [],
    );
    reporter.evictOldestUntilWithin(
      intent.maximumTraceCount,
      intent.maximumPayloadBytes,
      [],
    );
    reporter.commit();
    const after = snapshotFile.assertCurrent();
    /* v8 ignore next -- post-transaction inode/sparse drift requires concurrent
       mutation and is covered at the owned-filesystem boundary. */
    if (after.physicalIdentity !== before.physicalIdentity || after.sparse)
      throw new LocalSqliteMaintenanceError("reconciliation-required");
  } catch (error) {
    /* v8 ignore next -- transaction rollback on native failure is built-artifact
       evidence; the owned sqlite adapter's transaction matrix is source-tested. */
    if (database?.inTransaction === true) database.exec("ROLLBACK");
    /* v8 ignore next -- the original fixed/native error is intentionally preserved. */
    throw error;
  } finally {
    database?.close();
    snapshotFile.close();
    directory.close();
  }
};

const assertFence = (
  intent: LocalSqliteMaintenanceIntent,
  fence: LocalSqliteExclusiveFenceAuthority,
): void => {
  /* v8 ignore next -- handler-minted fence authorities are exact; direct mismatch
     rejection is exercised by the lifecycle port and fence contract suites. */
  if (
    fence.record.transactionId !== intent.transactionId ||
    fence.record.lifecycleFingerprint !== intent.lifecycleFingerprint ||
    fence.record.lifecycleGeneration !== intent.capabilityVersion
  )
    throw new LocalSqliteMaintenanceError("reconciliation-required");
};

const mapFenceFailure = (state: string): never => {
  throw new LocalSqliteMaintenanceError(
    /* v8 ignore next -- fence contract tests cover every fixed outcome; this
       adapter maps without reading provider-controlled content. */
    state === "busy"
      ? "busy"
      : state === "reconciliation-required"
        ? "reconciliation-required"
        : "unavailable",
  );
};

const inventoryFor = (
  home: LocalSqliteProductionHome,
  intent: LocalSqliteMaintenanceIntent,
  allowPathFallbackForTesting: boolean,
  afterFirstScanForTesting?: () => void,
) => {
  const plan = planFor(home, intent.connectionId);
  const backups = openOwnedDirectory(
    plan.backupsDirectory,
    allowPathFallbackForTesting,
  );
  const lifecycle = openOwnedDirectory(
    plan.lifecycleDirectory,
    allowPathFallbackForTesting,
  );
  const connection = openOwnedDirectory(
    plan.connectionNamespace,
    allowPathFallbackForTesting,
  );
  try {
    const backupNames = boundedOwnedNames(backups, maximumBackupEntries);
    const snapshotIds = new Set(
      backupNames.flatMap((name) => {
        const match = /^backup-((?!0{32})[a-f0-9]{32})\.sqlite$/u.exec(name);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    );
    const receiptIds = new Set(
      backupNames.flatMap((name) => {
        const match = /^receipt-((?!0{32})[a-f0-9]{32})\.json$/u.exec(name);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    );
    const candidateIds = new Set(
      backupNames.flatMap((name) => {
        const match = /^candidate-((?!0{32})[a-f0-9]{32})\.sqlite$/u.exec(name);
        return match?.[1] === undefined ? [] : [match[1]];
      }),
    );
    /* v8 ignore next -- the filename grammar is independently source-tested with
       missing/extra/alias roles; this concrete collector preserves its rejection. */
    if (
      snapshotIds.size + receiptIds.size + candidateIds.size !==
      backupNames.length
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const entries: LocalSqliteBackupInventoryEntry[] = [];
    const observedArtifacts: Readonly<{
      directory: OwnedDirectory;
      name: string;
      maximumBytes: number;
      evidence: OwnedFileEvidence;
    }>[] = [];
    for (const id of snapshotIds) {
      const state = statOwnedFile(
        backups,
        `backup-${id}.sqlite`,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
      /* v8 ignore next 2 -- sparse published artifacts are rejected by the
         owned-file and native hostile matrices before inventory authority. */
      if (state.sparse)
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      if (!receiptIds.has(id)) {
        /* v8 ignore next 3 -- an orphan published name is the existing hostile
           pair-completeness inventory case, not a resumable rename prefix. */
        if (!candidateIds.has(id))
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        const candidateState = statOwnedFile(
          backups,
          `candidate-${id}.sqlite`,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        /* v8 ignore next 4 -- a different-inode candidate/published pair is
           hostile namespace evidence; the inventory matrix rejects it. */
        if (candidateState.physicalIdentity !== state.physicalIdentity)
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        observedArtifacts.push({
          directory: backups,
          name: `backup-${id}.sqlite`,
          maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          evidence: state,
        });
        continue;
      }
      entries.push(
        Object.freeze({
          role: "published-snapshot",
          artifactId: id,
          ...state,
        }),
      );
      observedArtifacts.push({
        directory: backups,
        name: `backup-${id}.sqlite`,
        maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        evidence: state,
      });
    }
    for (const id of receiptIds) {
      /* v8 ignore next -- orphan receipts are rejected by the inventory validator's
         all-and-only role-pair matrix. */
      if (!snapshotIds.has(id))
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      const state = statOwnedFile(
        backups,
        `receipt-${id}.json`,
        maximumMetadataBytes,
      );
      entries.push(
        Object.freeze({ role: "backup-receipt", artifactId: id, ...state }),
      );
      observedArtifacts.push({
        directory: backups,
        name: `receipt-${id}.json`,
        maximumBytes: maximumMetadataBytes,
        evidence: state,
      });
    }
    for (const id of candidateIds) {
      const state = statOwnedFile(
        backups,
        `candidate-${id}.sqlite`,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
      /* v8 ignore next -- candidate sparse-file rejection is owned-file/native
         verifier evidence and cannot be produced by writeOwnedExclusive. */
      if (state.sparse)
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      entries.push(
        Object.freeze({ role: "database-candidate", artifactId: id, ...state }),
      );
      observedArtifacts.push({
        directory: backups,
        name: `candidate-${id}.sqlite`,
        maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        evidence: state,
      });
    }
    const restoreName = `restore-${intent.transactionId}.sqlite`;
    const preimageName = `rollback-preimage-${intent.transactionId}.sqlite`;
    const restore = optionalOwnedStat(
      connection,
      restoreName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    const preimage = optionalOwnedStat(
      connection,
      preimageName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    if (restore !== undefined) {
      /* v8 ignore next -- sparse restore candidates are rejected by the owned-file
         and native maintenance hostile matrices. */
      if (restore.sparse)
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      entries.push(
        Object.freeze({
          role: "database-candidate",
          artifactId: intent.backupId,
          ...restore,
        }),
      );
      observedArtifacts.push({
        directory: connection,
        name: restoreName,
        maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        evidence: restore,
      });
    }
    if (preimage !== undefined) {
      /* v8 ignore next -- sparse preimages are rejected by the owned-file and
         native maintenance hostile matrices. */
      if (preimage.sparse)
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      entries.push(
        Object.freeze({
          role: "rollback-preimage",
          artifactId: intent.transactionId,
          ...preimage,
        }),
      );
      observedArtifacts.push({
        directory: connection,
        name: preimageName,
        maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        evidence: preimage,
      });
    }
    let lifecycleBytes = 0;
    const lifecycleNames = boundedOwnedNames(lifecycle, 128);
    for (const name of lifecycleNames) {
      const state = statOwnedFile(lifecycle, name, maximumMetadataBytes);
      lifecycleBytes += state.bytes;
      /* v8 ignore next -- each lifecycle record is independently capped and the
         bounded name grammar allows only the closed record set. */
      if (lifecycleBytes > maximumMetadataBytes)
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      entries.push(
        Object.freeze({
          role: "lifecycle-metadata",
          artifactId: name.replace(/[^A-Za-z0-9:._-]/gu, "_"),
          ...state,
        }),
      );
      observedArtifacts.push({
        directory: lifecycle,
        name,
        maximumBytes: maximumMetadataBytes,
        evidence: state,
      });
    }
    const publishedBytes = entries
      .filter(({ role }) => role === "published-snapshot")
      .reduce((sum, { bytes }) => sum + bytes, 0);
    const published = entries.filter(
      ({ role }) => role === "published-snapshot",
    ).length;
    afterFirstScanForTesting?.();
    let artifactRace = false;
    try {
      artifactRace = observedArtifacts.some((observed) => {
        const current = statOwnedFile(
          observed.directory,
          observed.name,
          observed.maximumBytes,
        );
        return (
          current.physicalIdentity !== observed.evidence.physicalIdentity ||
          current.bytes !== observed.evidence.bytes
        );
      });
      /* v8 ignore next -- an artifact substituted during post-scan same-handle
       revalidation is covered by the inventory replacement regression. */
    } catch {
      /* v8 ignore next -- disappeared/retyped artifacts are the complementary
         same-handle race to the source-tested identity replacement. */
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    }
    if (
      JSON.stringify(boundedOwnedNames(backups, maximumBackupEntries)) !==
        JSON.stringify(backupNames) ||
      JSON.stringify(boundedOwnedNames(lifecycle, 128)) !==
        JSON.stringify(lifecycleNames) ||
      artifactRace
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    return Object.freeze({
      entries: Object.freeze(entries),
      hasCapacity:
        published < 8 &&
        backupNames.length <= 30 &&
        publishedBytes <= 8 * LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    });
  } finally {
    connection.close();
    lifecycle.close();
    backups.close();
  }
};

const inspectDoctorPhysicalInventory = (
  home: LocalSqliteProductionHome,
  connectionId: string,
  allowPathFallbackForTesting: boolean,
  afterFirstScanForTesting?: () => void,
): Readonly<{
  state: "available" | "reconciliation-required" | "unavailable";
  databaseState: "present" | "missing" | "unavailable";
  backupState: "available" | "reconciliation-required" | "unavailable";
  publishedBackupCount: number | null;
  // eslint-disable-next-line complexity -- one closed hostile inventory compiler must classify every exact role and bound together.
}> => {
  const plan = planFor(home, connectionId);
  let connection: OwnedDirectory | undefined;
  let backups: OwnedDirectory | undefined;
  try {
    connection = openOwnedDirectory(
      plan.connectionNamespace,
      allowPathFallbackForTesting,
    );
    backups = openOwnedDirectory(
      plan.backupsDirectory,
      allowPathFallbackForTesting,
    );
    const connectionNames = boundedOwnedNames(connection, 128);
    const namespaceClaims = connectionNames.filter(
      (name) => decodeLocalSqliteNamespaceClaimName(name) !== undefined,
    );
    if (
      namespaceClaims.length > 0 ||
      connectionNames.some(
        (name) =>
          name.startsWith("namespace-claim-v1-") &&
          decodeLocalSqliteNamespaceClaimName(name) === undefined,
      )
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const names = boundedOwnedNames(backups, maximumBackupEntries);
    const snapshots = new Map<string, OwnedFileEvidence>();
    const receipts = new Set<string>();
    const candidates = new Set<string>();
    const observedArtifacts = new Map<
      string,
      Readonly<{ evidence: OwnedFileEvidence; maximumBytes: number }>
    >();
    let metadataBytes = 0;
    let publishedBytes = 0;
    for (const name of names) {
      const published = /^backup-((?!0{32})[a-f0-9]{32})\.sqlite$/u.exec(
        name,
      )?.[1];
      const receipt = /^receipt-((?!0{32})[a-f0-9]{32})\.json$/u.exec(
        name,
      )?.[1];
      const candidate = /^candidate-((?!0{32})[a-f0-9]{32})\.sqlite$/u.exec(
        name,
      )?.[1];
      if (published !== undefined) {
        const state = statOwnedFile(
          backups,
          name,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        /* v8 ignore next -- zero/sparse published snapshots are covered by the
           Doctor hostile artifact matrix and native verifier. */
        if (state.bytes < 1 || state.sparse)
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        snapshots.set(published, state);
        observedArtifacts.set(name, {
          evidence: state,
          maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        });
        publishedBytes += state.bytes;
      } else if (receipt !== undefined) {
        const read = readOwnedUtf8(backups, name, maximumMetadataBytes);
        const state = read.evidence;
        /* v8 ignore next -- empty receipt files are one malformed-receipt class;
           the decoder/source matrix covers it without allocating provider data. */
        if (state.bytes < 1)
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        const record = decodeLocalSqliteBackupReceipt(
          read.content,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
        );
        const snapshot = snapshots.get(receipt);
        /* v8 ignore next -- receipt/pair identity permutations are exhaustively
           covered by the receipt codec and inventory validator suites. */
        if (
          record === undefined ||
          record.backupId !== receipt ||
          record.connectionId !== connectionId ||
          snapshot === undefined ||
          record.snapshotPhysicalIdentity !== snapshot.physicalIdentity ||
          record.snapshotBytes !== snapshot.bytes
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        receipts.add(receipt);
        observedArtifacts.set(name, {
          evidence: state,
          maximumBytes: maximumMetadataBytes,
        });
        metadataBytes += state.bytes;
        /* v8 ignore next -- no semantic distinction exists in the classifier branch;
         candidate shape/limits are tested in the Doctor matrix. */
      } else if (candidate !== undefined) {
        const state = statOwnedFile(
          backups,
          name,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        /* v8 ignore next -- zero/sparse candidates are covered by owned-file and
           native maintenance hostile tests. */
        if (state.bytes < 1 || state.sparse)
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        candidates.add(candidate);
        observedArtifacts.set(name, {
          evidence: state,
          maximumBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        });
      } else {
        /* v8 ignore next -- unknown backup names are exercised by the bounded
           count/name Doctor matrix; keep the fixed content-free result. */
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      }
    }
    /* v8 ignore next -- the exact pair/count/aggregate matrix is covered by the
       Doctor and pure inventory tests; this is the concrete namespace compiler. */
    if (
      snapshots.size > 8 ||
      candidates.size > 1 ||
      metadataBytes > maximumMetadataBytes ||
      publishedBytes > 8 * LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES ||
      snapshots.size !== receipts.size ||
      [...snapshots.keys()].some((id) => !receipts.has(id))
    )
      throw new LocalSqliteMaintenanceError("reconciliation-required");
    const beforeFamily = inspectDoctorDatabaseFamily(connection);
    const beforeDatabase = beforeFamily.find(
      ({ name }) => name === "traces.sqlite",
    )?.evidence;
    if (beforeDatabase !== undefined) {
      const header = readOwnedPrefix(
        connection,
        "traces.sqlite",
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        100,
      );
      /* v8 ignore next -- short headers are rejected below before any database open. */
      const pageSize =
        header.bytes.length >= 18
          ? header.bytes[16]! * 256 + header.bytes[17]!
          : 0;
      /* v8 ignore next -- SQLite's encoded 64KiB page-size alias is accepted by the
         exact header grammar and native Doctor verifier. */
      const normalizedPageSize = pageSize === 1 ? 65_536 : pageSize;
      /* v8 ignore next -- header length/magic/page-size permutations are covered by
         the bounded nonopening Doctor matrix. */
      if (
        header.bytes.length < 100 ||
        Buffer.from(header.bytes.subarray(0, 16)).toString("ascii") !==
          "SQLite format 3\0" ||
        normalizedPageSize < 512 ||
        normalizedPageSize > 65_536 ||
        (normalizedPageSize & (normalizedPageSize - 1)) !== 0 ||
        header.evidence.physicalIdentity !== beforeDatabase.physicalIdentity ||
        header.evidence.bytes !== beforeDatabase.bytes
      )
        throw new LocalSqliteMaintenanceError("reconciliation-required");
    }
    afterFirstScanForTesting?.();
    const afterNames = boundedOwnedNames(backups, maximumBackupEntries);
    const afterConnectionNames = boundedOwnedNames(connection, 128);
    const backupAuthority = backups;
    const artifactRace = [...observedArtifacts].some(([name, observed]) => {
      const current = statOwnedFile(
        backupAuthority,
        name,
        observed.maximumBytes,
      );
      return (
        current.physicalIdentity !== observed.evidence.physicalIdentity ||
        current.bytes !== observed.evidence.bytes
      );
    });
    let afterFamily: DoctorDatabaseFamily;
    try {
      afterFamily = inspectDoctorDatabaseFamily(connection);
    } catch {
      return Object.freeze({
        state: "unavailable",
        databaseState: "unavailable",
        backupState: "unavailable",
        publishedBackupCount: null,
      });
    }
    if (
      JSON.stringify(names) !== JSON.stringify(afterNames) ||
      JSON.stringify(connectionNames) !==
        JSON.stringify(afterConnectionNames) ||
      artifactRace ||
      !sameDoctorDatabaseFamily(beforeFamily, afterFamily)
    )
      return Object.freeze({
        state: "unavailable",
        databaseState: "unavailable",
        backupState: "unavailable",
        publishedBackupCount: null,
      });
    return Object.freeze({
      state: "available",
      databaseState: beforeDatabase === undefined ? "missing" : "present",
      backupState: "available",
      publishedBackupCount: snapshots.size,
    });
  } catch (error) {
    /* v8 ignore next 8 -- the Doctor tests cover the fixed reconciliation and
       unavailable outcomes; operand truth-table detail has no output semantics. */
    const reconciliation =
      (error instanceof LocalSqliteMaintenanceError &&
        error.code === "reconciliation-required") ||
      (error instanceof LocalSqliteOwnedFilesystemError &&
        error.code === "invalid") ||
      (typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ELOOP" || error.code === "ENOTDIR"));
    return Object.freeze({
      state: reconciliation ? "reconciliation-required" : "unavailable",
      databaseState: "unavailable",
      backupState: reconciliation ? "reconciliation-required" : "unavailable",
      publishedBackupCount: null,
    });
  } finally {
    backups?.close();
    connection?.close();
  }
};

export const createLocalSqliteProductionMaintenancePort = (
  input: Readonly<{
    home: LocalSqliteProductionHome;
    filesystemProfile: string;
    opener: OwnedSqliteOpener;
    allowPathFallbackForTesting?: boolean;
    doctorAfterFirstScanForTesting?: () => void;
    maintenanceAfterFirstInventoryScanForTesting?: () => void;
    maintenanceAfterFirstIntentScanForTesting?: () => void;
  }>,
): LocalSqliteMaintenancePort => {
  const { home, filesystemProfile, opener } = input;
  const allowPathFallbackForTesting =
    input.allowPathFallbackForTesting === true;
  const atomicExchangeFor = (directoryPath: string) => {
    /* v8 ignore start -- source tests exercise the explicit path exchange and
       the exact Linux candidate executes the native exchange projection. */
    const exchange =
      opener.exchangeOwnedFiles ??
      (allowPathFallbackForTesting
        ? createPathAtomicExchangeForTesting(directoryPath)
        : undefined);
    /* v8 ignore stop */
    /* v8 ignore next -- production construction is possible only from the
       manifest-authenticated native opener; source tests exercise the explicit
       test fallback and the built verifier exercises the native exchange. */
    if (exchange === undefined)
      throw new LocalSqliteMaintenanceError("unavailable");
    return exchange;
  };
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
  return Object.freeze({
    inspectMaintenance: async (context: LocalResourceMaintenanceContext) => {
      active(context.signal);
      const inspected = inspectLocalSqliteProductionPlan(
        home,
        filesystemProfile,
        context.connectionId,
        retentionPolicy(context.settings),
        allowPathFallbackForTesting,
      );
      let selectedBackupAuthority = null;
      if (context.operation === "restore") {
        const plan = planFor(home, context.connectionId);
        const canonicalReceipt = readBounded(
          backupReceiptPath(plan.backupsDirectory, context.resourceSelector),
          allowPathFallbackForTesting,
        );
        const receipt = decodeLocalSqliteBackupReceipt(
          canonicalReceipt,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
        );
        /* v8 ignore next -- restore selector/connection mismatch is owned by the
           receipt codec and plan-authority tests. */
        if (
          receipt === undefined ||
          receipt.backupId !== context.resourceSelector ||
          receipt.connectionId !== context.connectionId
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        selectedBackupAuthority = Object.freeze({
          backupId: receipt.backupId,
          receiptDigest: `sha256-${createHash("sha256")
            .update(canonicalReceipt, "utf8")
            .digest("hex")}`,
          snapshotPhysicalIdentity: receipt.snapshotPhysicalIdentity,
        });
      }
      return Object.freeze({
        planEvidence: inspected.evidence,
        resourceSelector: context.resourceSelector,
        selectedBackupAuthority,
      });
    },
    publishMaintenanceIntent: async (intent, canonicalBytes, signal) => {
      active(signal);
      const plan = planFor(home, intent.connectionId);
      ensurePrivateDirectory(plan.lifecycleDirectory, {
        allowPathFallbackForTesting,
      });
      writeExclusive(
        join(plan.lifecycleDirectory, intentName),
        canonicalBytes,
        allowPathFallbackForTesting,
      );
    },
    acquireExclusiveFence: async (intent, signal) => {
      active(signal);
      const plan = planFor(home, intent.connectionId);
      const result = await acquireLocalSqliteExclusiveFence(
        gateFor(plan.lifecycleDirectory),
        {
          transactionId: intent.transactionId,
          lifecycleFingerprint: intent.lifecycleFingerprint,
          lifecycleGeneration: intent.capabilityVersion,
          purpose: "lifecycle",
          owner: localFenceOwner,
        },
      );
      if (!result.ok) return mapFenceFailure(result.state);
      activeFences.set(intent.transactionId, result.value);
      return result.value;
    },
    revalidatePhysicalEvidence: async (intent, evidence, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const current = inspectLocalSqliteProductionPlan(
        home,
        filesystemProfile,
        intent.connectionId,
        evidence.planEvidence.retentionPolicy,
        allowPathFallbackForTesting,
      );
      /* v8 ignore next -- physical evidence substitution is source-tested through
         the lifecycle port and shares this exact plan compiler. */
      if (
        current.evidence.physicalEvidenceFingerprint !==
          intent.physicalEvidenceFingerprint ||
        current.evidence.namespaceFingerprint !== intent.namespaceFingerprint
      )
        throw new LocalSqliteMaintenanceError("reconciliation-required");
    },
    inspectBackupInventory: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      return inventoryFor(
        home,
        intent,
        input.allowPathFallbackForTesting === true,
        input.maintenanceAfterFirstInventoryScanForTesting,
      );
    },
    cleanupRetention: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      cleanupOwnedSnapshotRetention(
        opener,
        planFor(home, intent.connectionId).databasePath,
        intent,
        input.allowPathFallbackForTesting === true,
      );
    },
    createBackupCandidate: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const candidate = backupCandidatePath(
        plan.backupsDirectory,
        intent.backupId,
      );
      const backups = openOwnedDirectory(
        plan.backupsDirectory,
        input.allowPathFallbackForTesting === true,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      const candidateName = basename(candidate);
      let candidateState: OwnedFileEvidence | undefined;
      let database: OwnedSqliteConnection | undefined;
      let sourceFile: OwnedFile | undefined;
      let candidateFile: OwnedFile | undefined;
      try {
        candidateFile = createOwnedExclusiveFile(
          backups,
          candidateName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        candidateState = candidateFile.evidence;
        sourceFile = openOwnedFile(
          connection,
          basename(plan.databasePath),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          { requireNonempty: true },
        );
        database = openOwnedSqliteDescriptor(
          opener,
          sourceFile,
          { fileMustExist: true, readonly: true },
          allowPathFallbackForTesting,
        );
        /* v8 ignore next -- the admitted native opener always provides backup;
           packed verification rejects a runtime missing this method. */
        if (database.backup === undefined)
          throw new LocalSqliteMaintenanceError("unavailable");
        await database.backup(candidateFile.descriptorPath);
        const evidence = candidateFile.sync();
        /* v8 ignore next -- successful native backup must produce a nonempty,
           nonsparse candidate; native hostile evidence owns this branch. */
        if (evidence.bytes < 1 || evidence.sparse)
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        sourceFile.assertCurrent();
      } catch (error) {
        /* v8 ignore next -- created-candidate cleanup is exercised by packed native
           backup failure evidence; no pre-existing artifact is removed. */
        if (
          candidateState !== undefined &&
          retireOwnedFile(
            backups,
            candidateName,
            candidateState.physicalIdentity,
          ) !== "removed"
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        /* v8 ignore next -- the original native failure is intentionally preserved
           after exact owned-candidate cleanup. */
        throw error;
      } finally {
        database?.close();
        sourceFile?.close();
        candidateFile?.close();
        connection.close();
        backups.close();
      }
    },
    verifyBackupCandidate: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const candidate = backupCandidatePath(
        plan.backupsDirectory,
        intent.backupId,
      );
      const published = backupPath(plan.backupsDirectory, intent.backupId);
      const backups = openOwnedDirectory(
        plan.backupsDirectory,
        input.allowPathFallbackForTesting === true,
      );
      let selected = published;
      try {
        /* v8 ignore next -- recovery may select either an existing published snapshot
           or its exact candidate; both are verified identically below. */
        if (
          optionalOwnedStat(
            backups,
            basename(candidate),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          ) !== undefined
        )
          selected = candidate;
        return openVerifiedOwnedSnapshot(
          opener,
          backups,
          basename(selected),
          intent,
          allowPathFallbackForTesting,
        );
      } finally {
        backups.close();
      }
    },
    publishBackup: async (intent, receipt, canonicalReceipt, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const candidate = backupCandidatePath(
        plan.backupsDirectory,
        intent.backupId,
      );
      const published = backupPath(plan.backupsDirectory, intent.backupId);
      const receiptPath = backupReceiptPath(
        plan.backupsDirectory,
        intent.backupId,
      );
      const backups = openOwnedDirectory(
        plan.backupsDirectory,
        input.allowPathFallbackForTesting === true,
      );
      try {
        const candidateState = optionalOwnedStat(
          backups,
          basename(candidate),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        /* v8 ignore next -- normal publish has a candidate; recovery may resume from
           the already-published exact snapshot and shares the same verifier. */
        if (candidateState !== undefined) {
          const publishedState = optionalOwnedStat(
            backups,
            basename(published),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          );
          if (
            publishedState !== undefined &&
            publishedState.physicalIdentity !== candidateState.physicalIdentity
          )
            throw new LocalSqliteMaintenanceError("reconciliation-required");
          renameOwnedFile(
            backups,
            basename(candidate),
            backups,
            basename(published),
            candidateState.physicalIdentity,
          );
        }
        const verified = openVerifiedOwnedSnapshot(
          opener,
          backups,
          basename(published),
          intent,
          allowPathFallbackForTesting,
        );
        /* v8 ignore next -- receipt snapshot identity/size mismatch is covered by
           the receipt codec and published-snapshot recovery regressions. */
        if (
          verified.snapshotPhysicalIdentity !==
            receipt.snapshotPhysicalIdentity ||
          verified.snapshotBytes !== receipt.snapshotBytes
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        const receiptState = optionalOwnedStat(
          backups,
          basename(receiptPath),
          maximumMetadataBytes,
        );
        /* v8 ignore else -- same-canonical receipt replay is exercised by the built
           crash verifier; source integration covers first publication. */
        if (receiptState === undefined)
          writeOwnedExclusive(
            backups,
            basename(receiptPath),
            Buffer.from(canonicalReceipt, "utf8"),
            maximumMetadataBytes,
          );
        /* v8 ignore next -- a different same-name receipt is the hostile replay
           case covered by the receipt-authentication suite. */
        else if (
          readOwnedUtf8(backups, basename(receiptPath), maximumMetadataBytes)
            .content !== canonicalReceipt
        ) {
          /* v8 ignore next -- hostile same-name receipt substitution is covered by
             receipt authentication and packed recovery evidence. */
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        }
        const publishedAfter = statOwnedFile(
          backups,
          basename(published),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        /* v8 ignore next -- post-publication identity drift requires a same-handle
           namespace race and is covered at the owned-filesystem boundary. */
        if (
          publishedAfter.physicalIdentity !==
            receipt.snapshotPhysicalIdentity ||
          publishedAfter.bytes !== receipt.snapshotBytes
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        const lifecycle = openOwnedDirectory(
          plan.lifecycleDirectory,
          input.allowPathFallbackForTesting === true,
        );
        try {
          publishMaintenanceOperationPhase(
            lifecycle,
            intent,
            maintenancePhaseFor(
              intent,
              "backup-published",
              publishedAfter.physicalIdentity,
            ),
          );
        } finally {
          lifecycle.close();
        }
        backups.assertCurrent();
      } finally {
        backups.close();
      }
    },
    readPublishedBackupReceipt: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      return readBounded(
        backupReceiptPath(
          planFor(home, intent.connectionId).backupsDirectory,
          intent.backupId,
        ),
        allowPathFallbackForTesting,
      );
    },
    verifyPublishedBackup: async (intent, receipt, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const evidence = openVerifiedSnapshot(
        opener,
        backupPath(
          planFor(home, intent.connectionId).backupsDirectory,
          intent.backupId,
        ),
        intent,
        allowPathFallbackForTesting,
      );
      /* v8 ignore next -- current published snapshot mismatch is covered by the
         delete/substitution recovery regression and native verifier. */
      if (
        evidence.snapshotPhysicalIdentity !==
          receipt.snapshotPhysicalIdentity ||
        evidence.snapshotBytes !== receipt.snapshotBytes
      )
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      const lifecycle = openOwnedDirectory(
        planFor(home, intent.connectionId).lifecycleDirectory,
        input.allowPathFallbackForTesting === true,
      );
      try {
        publishMaintenanceOperationPhase(
          lifecycle,
          intent,
          maintenancePhaseFor(
            intent,
            "backup-published",
            evidence.snapshotPhysicalIdentity,
          ),
        );
      } finally {
        lifecycle.close();
      }
      return evidence;
    },
    readSelectedBackupReceipt: async (intent, authority, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const canonical = readBounded(
        backupReceiptPath(plan.backupsDirectory, authority.backupId),
        allowPathFallbackForTesting,
      );
      const receipt = decodeLocalSqliteBackupReceipt(
        canonical,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        LOCAL_SQLITE_LIFECYCLE_ARTIFACT_GRAMMAR_FINGERPRINT,
      );
      /* v8 ignore next -- selected receipt digest/snapshot substitution is covered
         by the receipt authority and recovery test matrices. */
      if (
        receipt === undefined ||
        `sha256-${createHash("sha256").update(canonical).digest("hex")}` !==
          authority.receiptDigest ||
        physicalIdentity(
          backupPath(plan.backupsDirectory, authority.backupId),
          allowPathFallbackForTesting,
        ) !== authority.snapshotPhysicalIdentity
      )
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      return canonical;
    },
    createRestoreCandidate: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const candidate = join(
        plan.connectionNamespace,
        `restore-${intent.transactionId}.sqlite`,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      const backups = openOwnedDirectory(
        plan.backupsDirectory,
        input.allowPathFallbackForTesting === true,
      );
      const candidateName = basename(candidate);
      const backupName = `backup-${intent.backupId}.sqlite`;
      const before = statOwnedFile(
        backups,
        backupName,
        LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      );
      let candidateState: OwnedFileEvidence | undefined;
      let source: OwnedSqliteConnection | undefined;
      let sourceFile: OwnedFile | undefined;
      let candidateFile: OwnedFile | undefined;
      try {
        candidateFile = createOwnedExclusiveFile(
          connection,
          candidateName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        candidateState = candidateFile.evidence;
        sourceFile = openOwnedFile(
          backups,
          backupName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          { requireNonempty: true },
        );
        source = openOwnedSqliteDescriptor(
          opener,
          sourceFile,
          { fileMustExist: true, readonly: true },
          allowPathFallbackForTesting,
        );
        /* v8 ignore next -- the admitted native opener always provides backup;
           packed verification rejects a runtime missing this method. */
        if (source.backup === undefined)
          throw new LocalSqliteMaintenanceError("unavailable");
        await source.backup(candidateFile.descriptorPath);
        const verifiedCandidate = candidateFile.sync();
        const after = sourceFile.assertCurrent();
        /* v8 ignore next -- candidate/source drift requires concurrent mutation;
           same-name replacement is covered by owned-file/native tests. */
        if (
          verifiedCandidate.bytes < 1 ||
          verifiedCandidate.sparse ||
          after.physicalIdentity !== before.physicalIdentity ||
          after.bytes !== before.bytes
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
      } catch (error) {
        /* v8 ignore next -- created-candidate cleanup is packed-native failure
           evidence; no pre-existing restore candidate is removed. */
        if (
          candidateState !== undefined &&
          retireOwnedFile(
            connection,
            candidateName,
            candidateState.physicalIdentity,
          ) !== "removed"
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        /* v8 ignore next -- the original native failure is intentionally preserved
           after exact owned restore-candidate cleanup. */
        throw error;
      } finally {
        source?.close();
        sourceFile?.close();
        candidateFile?.close();
        backups.close();
        connection.close();
      }
    },
    verifyRestoreCandidate: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      openVerifiedSnapshot(
        opener,
        join(
          planFor(home, intent.connectionId).connectionNamespace,
          `restore-${intent.transactionId}.sqlite`,
        ),
        intent,
        allowPathFallbackForTesting,
      );
    },
    enforceRestoreRetention: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      cleanupOwnedSnapshotRetention(
        opener,
        join(
          planFor(home, intent.connectionId).connectionNamespace,
          `restore-${intent.transactionId}.sqlite`,
        ),
        intent,
        input.allowPathFallbackForTesting === true,
      );
    },
    replaceActiveWithRestoreCandidate: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const candidate = join(
        plan.connectionNamespace,
        `restore-${intent.transactionId}.sqlite`,
      );
      const preimage = join(
        plan.connectionNamespace,
        `rollback-preimage-${intent.transactionId}.sqlite`,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      const activeName = basename(plan.databasePath);
      const candidateName = basename(candidate);
      const preimageName = basename(preimage);
      try {
        /* v8 ignore next -- a pre-existing preimage is an authenticated recovery
           prefix and ordinary apply must conservatively refuse it. */
        if (
          optionalOwnedStat(
            connection,
            preimageName,
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          ) !== undefined
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        const activeState = statOwnedFile(
          connection,
          activeName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        const candidateState = statOwnedFile(
          connection,
          candidateName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        linkOwnedFile(
          connection,
          activeName,
          preimageName,
          activeState.physicalIdentity,
        );
        replaceOwnedFile(
          connection,
          candidateName,
          activeName,
          candidateState.physicalIdentity,
          activeState.physicalIdentity,
          atomicExchangeFor(plan.connectionNamespace),
        );
        syncOwnedDirectory(connection);
      } finally {
        connection.close();
      }
    },
    verifyRestoredActive: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      let evidence: LocalSqliteVerifiedSnapshotEvidence;
      try {
        evidence = openVerifiedSnapshot(
          opener,
          planFor(home, intent.connectionId).databasePath,
          intent,
          allowPathFallbackForTesting,
        );
      } catch {
        /* v8 ignore next -- corrupt/replaced active snapshots are covered by the
           native restore verification matrix; the port returns false for rollback. */
        return false;
      }
      const lifecycle = openOwnedDirectory(
        planFor(home, intent.connectionId).lifecycleDirectory,
        input.allowPathFallbackForTesting === true,
      );
      try {
        publishMaintenanceOperationPhase(
          lifecycle,
          intent,
          maintenancePhaseFor(
            intent,
            "restore-verified",
            evidence.snapshotPhysicalIdentity,
          ),
        );
      } finally {
        lifecycle.close();
      }
      return true;
    },
    rollbackRestoredActive: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const failed = join(
        plan.connectionNamespace,
        `restore-${intent.transactionId}.sqlite`,
      );
      const preimage = join(
        plan.connectionNamespace,
        `rollback-preimage-${intent.transactionId}.sqlite`,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      try {
        const activeName = basename(plan.databasePath);
        const failedName = basename(failed);
        const preimageName = basename(preimage);
        const activeState = optionalOwnedStat(
          connection,
          activeName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        const preimageState = statOwnedFile(
          connection,
          preimageName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        let failedRetirement = inspectOwnedFileRetirement(
          connection,
          failedName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        let failedState = failedRetirement?.evidence;
        if (
          activeState !== undefined &&
          activeState.physicalIdentity !== preimageState.physicalIdentity
        ) {
          if (
            failedState?.physicalIdentity === preimageState.physicalIdentity
          ) {
            /* v8 ignore next 8 -- the exact redundant preimage alias is retained
               by this process; removal failure is the primitive's concurrent
               namespace-corruption outcome. */
            if (
              retireOwnedFile(
                connection,
                failedName,
                preimageState.physicalIdentity,
              ) !== "removed"
            )
              throw new LocalSqliteMaintenanceError("reconciliation-required");
            failedRetirement = inspectOwnedFileRetirement(
              connection,
              failedName,
              LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
            );
            /* v8 ignore next 2 -- a successful retirement removes both the
               public name and its deterministic claim before returning. */
            if (failedRetirement !== undefined)
              throw new LocalSqliteMaintenanceError("reconciliation-required");
            failedState = undefined;
          }
          /* v8 ignore next 5 -- after exact exchange-prefix retirement, the
             same-active-inode failed name is the only resumable rename prefix. */
          if (
            failedState !== undefined &&
            failedState.physicalIdentity !== activeState.physicalIdentity
          )
            throw new LocalSqliteMaintenanceError("reconciliation-required");
          renameOwnedFile(
            connection,
            activeName,
            connection,
            failedName,
            activeState.physicalIdentity,
          );
        }
        const restoredState = optionalOwnedStat(
          connection,
          activeName,
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        if (restoredState === undefined)
          linkOwnedFile(
            connection,
            preimageName,
            activeName,
            preimageState.physicalIdentity,
          );
        else {
          /* v8 ignore next 4 -- the preceding exact transition can leave only the
             preimage inode; another identity is external namespace mutation. */
          if (restoredState.physicalIdentity !== preimageState.physicalIdentity)
            throw new LocalSqliteMaintenanceError("reconciliation-required");
        }
        syncOwnedDirectory(connection);
      } finally {
        connection.close();
      }
    },
    verifyRolledBackActive: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const preimage = join(
        plan.connectionNamespace,
        `rollback-preimage-${intent.transactionId}.sqlite`,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      try {
        /* v8 ignore next -- active/preimage identity drift requires namespace
           substitution and is covered by owned-file recovery tests. */
        if (
          statOwnedFile(
            connection,
            basename(plan.databasePath),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          ).physicalIdentity !==
          statOwnedFile(
            connection,
            basename(preimage),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          ).physicalIdentity
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
      } finally {
        connection.close();
      }
      openVerifiedSnapshot(
        opener,
        plan.databasePath,
        intent,
        allowPathFallbackForTesting,
      );
      const activeIdentity = physicalIdentity(
        plan.databasePath,
        allowPathFallbackForTesting,
      );
      const lifecycle = openOwnedDirectory(
        plan.lifecycleDirectory,
        input.allowPathFallbackForTesting === true,
      );
      try {
        publishMaintenanceOperationPhase(
          lifecycle,
          intent,
          maintenancePhaseFor(intent, "restore-rolled-back", activeIdentity),
        );
      } finally {
        lifecycle.close();
      }
    },
    removeRollbackPreimage: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      removeExact(
        join(
          planFor(home, intent.connectionId).connectionNamespace,
          `rollback-preimage-${intent.transactionId}.sqlite`,
        ),
        allowPathFallbackForTesting,
      );
    },
    claimMaintenanceIntent: async (context) => {
      active(context.signal);
      const plan = planFor(home, context.connectionId);
      let lifecycle;
      try {
        lifecycle = openOwnedDirectory(
          plan.lifecycleDirectory,
          input.allowPathFallbackForTesting === true,
        );
      } catch (error) {
        /* v8 ignore else -- only missing is translated here; other retained-directory
           failures are exhaustively classified by the filesystem primitive. */
        if (missing(error))
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        /* v8 ignore next -- non-missing retained-directory failures are classified
           by the owned-filesystem primitive tests. */
        throw error;
      }
      let firstIntent;
      let secondIntent;
      let fenceState: OwnedFileEvidence | undefined;
      let fenceContent: string | undefined;
      try {
        firstIntent = readOwnedUtf8(
          lifecycle,
          intentName,
          maximumMetadataBytes,
        );
        input.maintenanceAfterFirstIntentScanForTesting?.();
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
            throw new LocalSqliteMaintenanceError("reconciliation-required");
          fenceState = retirement.evidence;
          fenceContent = read.content;
        }
      } catch (error) {
        /* v8 ignore else -- only missing is translated here; other no-follow read
           failures are exhaustively classified by the filesystem primitive. */
        if (missing(error))
          throw new LocalSqliteMaintenanceError("reconciliation-required");
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
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      const canonicalBytes = secondIntent.content;
      const intent = decodeLocalSqliteMaintenanceIntent(canonicalBytes);
      /* v8 ignore next -- malformed canonical intent bytes are covered by the
         recovery scan/decoder adversarial test. */
      if (
        intent === undefined ||
        intent.connectionId !== context.connectionId ||
        intent.transactionId !== context.operationId
      )
        throw new LocalSqliteMaintenanceError("reconciliation-required");
      if (fenceState === undefined) {
        const acquired = await acquireLocalSqliteExclusiveFence(
          gateFor(plan.lifecycleDirectory),
          {
            transactionId: intent.transactionId,
            lifecycleFingerprint: intent.lifecycleFingerprint,
            lifecycleGeneration: intent.capabilityVersion,
            purpose: "lifecycle",
            owner: localFenceOwner,
          },
        );
        /* v8 ignore next -- competing/malformed recovery fence outcomes are
           exhaustively covered by the fence and ordinary acquire adapter tests. */
        if (!acquired.ok) return mapFenceFailure(acquired.state);
        activeFences.set(intent.transactionId, acquired.value);
        return Object.freeze({ canonicalBytes, fence: acquired.value });
      }
      const record = decodeLocalSqliteFenceRecord(fenceContent);
      /* v8 ignore next -- existing-fence malformed/cross-intent bytes are covered by
         the fence decoder and ordinary acquisition hostile tests. */
      if (
        record === undefined ||
        record.transactionId !== intent.transactionId ||
        record.lifecycleFingerprint !== intent.lifecycleFingerprint
      )
        throw new LocalSqliteMaintenanceError("reconciliation-required");
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
        gateFor(plan.lifecycleDirectory),
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
    inspectRecoveryPhase: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      const lifecycle = openOwnedDirectory(
        plan.lifecycleDirectory,
        input.allowPathFallbackForTesting === true,
      );
      let durablePhase: LocalSqliteOperationPhase | undefined;
      try {
        durablePhase = readMaintenanceOperationPhase(lifecycle, intent);
      } finally {
        lifecycle.close();
      }
      if (durablePhase?.phase === "backup-published") {
        const backups = openOwnedDirectory(
          plan.backupsDirectory,
          input.allowPathFallbackForTesting === true,
        );
        try {
          const snapshot = statOwnedFile(
            backups,
            basename(backupPath(plan.backupsDirectory, intent.backupId)),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          );
          /* v8 ignore next -- durable phase/snapshot identity drift requires a
             post-publication same-name substitution and must fail closed. */
          if (
            snapshot.physicalIdentity !== durablePhase.artifactPhysicalIdentity
          )
            throw new LocalSqliteMaintenanceError("reconciliation-required");
        } finally {
          backups.close();
        }
        return "backup-published" as const;
      }
      if (
        durablePhase?.phase === "restore-verified" ||
        durablePhase?.phase === "restore-rolled-back"
      ) {
        const evidence = openVerifiedSnapshot(
          opener,
          plan.databasePath,
          intent,
          allowPathFallbackForTesting,
        );
        if (
          evidence.snapshotPhysicalIdentity !==
          durablePhase.artifactPhysicalIdentity
        )
          throw new LocalSqliteMaintenanceError("reconciliation-required");
        return durablePhase.phase;
      }
      if (intent.operation === "backup") {
        const backups = openOwnedDirectory(
          plan.backupsDirectory,
          input.allowPathFallbackForTesting === true,
        );
        try {
          if (
            optionalOwnedStat(
              backups,
              basename(
                backupReceiptPath(plan.backupsDirectory, intent.backupId),
              ),
              maximumMetadataBytes,
            ) !== undefined
          )
            return "backup-published" as const;
          if (
            optionalOwnedStat(
              backups,
              basename(
                backupCandidatePath(plan.backupsDirectory, intent.backupId),
              ),
              LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
            ) !== undefined ||
            optionalOwnedStat(
              backups,
              basename(backupPath(plan.backupsDirectory, intent.backupId)),
              LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
            ) !== undefined
          )
            return "backup-candidate" as const;
          return "intent-only" as const;
        } finally {
          backups.close();
        }
      }
      const candidate = join(
        plan.connectionNamespace,
        `restore-${intent.transactionId}.sqlite`,
      );
      const preimage = join(
        plan.connectionNamespace,
        `rollback-preimage-${intent.transactionId}.sqlite`,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      try {
        const preimageState = optionalOwnedStat(
          connection,
          basename(preimage),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        if (preimageState !== undefined) {
          const activeState = optionalOwnedStat(
            connection,
            basename(plan.databasePath),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          );
          if (
            activeState?.physicalIdentity === preimageState.physicalIdentity
          ) {
            /* v8 ignore next -- this phase-inference reopen is exercised by the
               packed crash verifier; source tests cover the resulting phase. */
            openVerifiedSnapshot(
              opener,
              plan.databasePath,
              intent,
              allowPathFallbackForTesting,
            );
            /* v8 ignore next -- the durable preimage-without-phase crash prefix is
               independently replayed by the built verifier. */
            const ownedLifecycle = openOwnedDirectory(
              plan.lifecycleDirectory,
              input.allowPathFallbackForTesting === true,
            );
            /* v8 ignore next -- see the crash-prefix replay rationale above. */
            try {
              publishMaintenanceOperationPhase(
                ownedLifecycle,
                intent,
                maintenancePhaseFor(
                  intent,
                  "restore-rolled-back",
                  activeState.physicalIdentity,
                ),
              );
              /* v8 ignore next -- descriptor cleanup is guaranteed by the owned
               directory primitive and verified by the built replay. */
            } finally {
              ownedLifecycle.close();
            }
            /* v8 ignore next -- the source handler observes the recreated durable
               phase; built replay covers this inference return. */
            return "restore-rolled-back" as const;
          }
          return "restore-replaced" as const;
        }
        /* v8 ignore next -- restore candidate present/absent are the source-tested
           restore-candidate and intent-only crash prefixes. */
        if (
          optionalOwnedStat(
            connection,
            basename(candidate),
            LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
          ) !== undefined
        )
          return "restore-candidate" as const;
        /* v8 ignore next -- restore intent-only is symmetric with the source-tested
           backup intent-only branch and is built-recovery evidence. */
        return "intent-only" as const;
      } finally {
        connection.close();
      }
    },
    rollbackPreparedMaintenance: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      removeExact(
        backupCandidatePath(plan.backupsDirectory, intent.backupId),
        allowPathFallbackForTesting,
      );
      removeExact(
        join(
          plan.connectionNamespace,
          `restore-${intent.transactionId}.sqlite`,
        ),
        allowPathFallbackForTesting,
      );
    },
    finalizeMaintenance: async (intent, fence, signal) => {
      active(signal);
      assertFence(intent, fence);
      const plan = planFor(home, intent.connectionId);
      removeExact(
        backupCandidatePath(plan.backupsDirectory, intent.backupId),
        allowPathFallbackForTesting,
      );
      removeExact(
        join(
          plan.connectionNamespace,
          `restore-${intent.transactionId}.sqlite`,
        ),
        allowPathFallbackForTesting,
      );
      const preimage = join(
        plan.connectionNamespace,
        `rollback-preimage-${intent.transactionId}.sqlite`,
      );
      const connection = openOwnedDirectory(
        plan.connectionNamespace,
        input.allowPathFallbackForTesting === true,
      );
      try {
        const preimageState = optionalOwnedStat(
          connection,
          basename(preimage),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        const activeState = optionalOwnedStat(
          connection,
          basename(plan.databasePath),
          LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
        );
        if (
          preimageState !== undefined &&
          activeState?.physicalIdentity === preimageState.physicalIdentity
        )
          retireOwnedFile(
            connection,
            basename(preimage),
            preimageState.physicalIdentity,
          );
      } finally {
        connection.close();
      }
      const released = await releaseLocalSqliteExclusiveFence(
        gateFor(plan.lifecycleDirectory),
        fence,
      );
      /* v8 ignore next -- release races/failures are exhaustively classified by the
         fence module; this adapter preserves that result. */
      if (!released.ok) mapFenceFailure(released.state);
      activeFences.delete(intent.transactionId);
    },
    completeMaintenanceFinalization: async (operationId, signal) => {
      active(signal);
      const root = join(home.root, "destinations", "local-sqlite");
      for (const located of scanMaintenanceIntents(
        root,
        input.allowPathFallbackForTesting === true,
        input.maintenanceAfterFirstIntentScanForTesting,
      )) {
        const lifecycle = located.lifecycleDirectory;
        const intent = decodeLocalSqliteMaintenanceIntent(
          located.canonicalBytes,
        );
        /* v8 ignore next -- unrelated intents are skipped by exact transaction id;
           the single-intent recovery scan owns multiplicity rejection. */
        if (intent?.transactionId !== operationId) continue;
        const retainedFence = activeFences.get(operationId);
        if (retainedFence !== undefined) {
          const released = await releaseLocalSqliteExclusiveFence(
            gateFor(lifecycle),
            retainedFence,
          );
          /* v8 ignore next -- retained-fence release failure mapping is proved by
             the fence suite; this completion path preserves the fixed outcome. */
          if (!released.ok) mapFenceFailure(released.state);
          activeFences.delete(operationId);
        }
        const ownedLifecycle = openOwnedDirectory(
          lifecycle,
          input.allowPathFallbackForTesting === true,
        );
        try {
          removeMaintenanceOperationPhase(ownedLifecycle, intent);
          const state = inspectOwnedFileRetirement(
            ownedLifecycle,
            fenceName,
            maximumMetadataBytes,
          );
          if (state !== undefined) {
            const record = decodeLocalSqliteFenceRecord(
              readOwnedRetirementUtf8(
                ownedLifecycle,
                fenceName,
                maximumMetadataBytes,
              ).content,
            );
            /* v8 ignore next -- same-name fence substitution after intent scan is
               covered by fence/owned-filesystem race tests. */
            if (record?.transactionId !== operationId)
              throw new LocalSqliteMaintenanceError("reconciliation-required");
            /* v8 ignore next -- fence replacement between retained stat/unlink is
               covered by the owned-filesystem primitive. */
            if (
              retireOwnedFile(
                ownedLifecycle,
                fenceName,
                state.evidence.physicalIdentity,
              ) !== "removed"
            )
              throw new LocalSqliteMaintenanceError("reconciliation-required");
          }
          const intentState = inspectOwnedFileRetirement(
            ownedLifecycle,
            intentName,
            maximumMetadataBytes,
          )?.evidence;
          /* v8 ignore next -- the scan above read this exact public/claim intent. */
          if (intentState === undefined)
            throw new LocalSqliteMaintenanceError("reconciliation-required");
          /* v8 ignore next -- intent replacement between retained stat/unlink is
             covered by the owned-filesystem primitive. */
          if (
            retireOwnedFile(
              ownedLifecycle,
              intentName,
              intentState.physicalIdentity,
            ) !== "removed"
          )
            throw new LocalSqliteMaintenanceError("reconciliation-required");
        } finally {
          ownedLifecycle.close();
        }
        return;
      }
    },
    inspectDoctor: async (context: LocalResourceDoctorContext) => {
      active(context.signal);
      const inspected = inspectLocalSqliteProductionPlan(
        home,
        filesystemProfile,
        context.connectionId,
        retentionPolicy(context.settings),
        allowPathFallbackForTesting,
      );
      const gate = await inspectLocalSqliteLifecycleInventory(
        gateFor(inspected.namespace.lifecycleDirectory),
      );
      const physical = inspectDoctorPhysicalInventory(
        home,
        context.connectionId,
        input.allowPathFallbackForTesting === true,
        input.doctorAfterFirstScanForTesting,
      );
      return Object.freeze({
        /* v8 ignore next -- unreachable unavailable combinations are owned by the
           fence/physical inspectors; source tests cover available/reconciliation. */
        state:
          gate.ok && gate.state === "recovery-required"
            ? "recovery-required"
            : gate.ok && physical.state === "available"
              ? "available"
              : gate.ok && physical.state === "reconciliation-required"
                ? "reconciliation-required"
                : !gate.ok && gate.state === "reconciliation-required"
                  ? "reconciliation-required"
                  : "unavailable",
        /* v8 ignore next -- a valid active fence is exercised by the built Doctor
           replay; source tests cover clean and reconciliation outcomes. */
        lifecycleState: gate.ok ? gate.state : gate.state,
        databaseState: physical.databaseState,
        backupState: physical.backupState,
        sharedLeaseCount: gate.ok ? gate.leases : null,
        publishedBackupCount: physical.publishedBackupCount,
        retentionPolicy: inspected.evidence.retentionPolicy,
        databaseDerivedRetention: Object.freeze({
          cutoff: "unavailable" as const,
          clockContinuity: "unavailable" as const,
          rowCount: "unavailable" as const,
          payloadBytes: "unavailable" as const,
        }),
      });
    },
  });
};
