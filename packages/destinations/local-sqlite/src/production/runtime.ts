import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createReporterReceipt,
  resolveLocalResourceHomeAuthority,
  type ReporterReceipt,
  type LocalResourceHome,
  type LocalResourceHomeAuthority,
} from "@agentscope/destinations-core";
import {
  acquireLocalSqliteSharedLease,
  releaseLocalSqliteSharedLease,
  type LocalSqliteLifecycleGatePort,
} from "../lifecycle/fence.js";
import { LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES } from "../lifecycle/capability.js";
import { bindLocalSqliteProductionLifecyclePorts } from "../lifecycle/configuration.js";
import {
  LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST,
  LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST,
} from "../native-support.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  createLocalSqliteFilesystemGatePort,
  currentProcessStartIdentity,
} from "./filesystem-port.js";
import {
  createLocalSqliteProductionLifecyclePort,
  openOwnedSqliteDescriptor,
  type LocalSqliteProductionHome,
  type OwnedSqliteOpener,
} from "./lifecycle-port.js";
import { createLocalSqliteProductionMaintenancePort } from "./maintenance-port.js";
import {
  initializeOwnedSqliteConnection,
  type LocalSqliteExecutionPolicy,
  type OwnedSqliteConnection,
} from "./sqlite-port.js";
import type {
  LocalSqlitePreparedTrace,
  LocalSqliteReporterPolicy,
} from "../reporter/transaction.js";
import {
  executeLocalSqliteReporterChild,
  type LocalSqliteReporterChildPrograms,
} from "./reporter-child-parent.js";
import { localSqliteReporterChildBatchFits } from "./reporter-child-protocol.js";
import {
  executeLocalSqliteRetrieverChild,
  type LocalSqliteRetrieverChildPrograms,
} from "./retriever-child-parent.js";
import type {
  LocalSqliteGetEvidence,
  LocalSqliteGetPlan,
  LocalSqliteSearchEvidence,
  LocalSqliteSearchPlan,
} from "../retriever/index.js";
import {
  inspectOwnedSqliteFamily,
  openOwnedDirectory,
  openOwnedFile,
  type OwnedDirectory,
  type OwnedFile,
} from "./owned-filesystem.js";
import { basename } from "node:path";

export type LocalSqliteProductionRuntime = Readonly<{
  home: LocalSqliteProductionHome;
  filesystemProfile: "local-ext4";
  platformId: "linux-x64-node22-ci-ext4-proposed";
  nativeTupleId: "node127-linux-x64-glibc";
  maximumSnapshotBytes: typeof LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES;
  opener: OwnedSqliteOpener;
  lifecyclePort: ReturnType<typeof createLocalSqliteProductionLifecyclePort>;
  maintenancePort: ReturnType<
    typeof createLocalSqliteProductionMaintenancePort
  >;
  reportPrepared: (
    attempt: Readonly<{
      connectionId: string;
      lifecycleFingerprint: string;
      policy: LocalSqliteReporterPolicy;
      prepared: readonly LocalSqlitePreparedTrace[];
      admissionTimeUnixNano: string;
      signal: AbortSignal;
      remainingMilliseconds: () => number;
    }>,
  ) => Promise<ReporterReceipt>;
  search: (
    attempt: Readonly<{
      connectionId: string;
      lifecycleFingerprint: string;
      policy: LocalSqliteExecutionPolicy;
      plan: LocalSqliteSearchPlan;
      signal: AbortSignal;
    }>,
  ) => Promise<LocalSqliteSearchEvidence>;
  get: (
    attempt: Readonly<{
      connectionId: string;
      lifecycleFingerprint: string;
      policy: LocalSqliteExecutionPolicy;
      plan: LocalSqliteGetPlan;
      signal: AbortSignal;
    }>,
  ) => Promise<LocalSqliteGetEvidence>;
  withSharedDatabase: <Value>(
    request: Readonly<{
      connectionId: string;
      lifecycleFingerprint: string;
      policy: LocalSqliteExecutionPolicy;
      maximumWorkMilliseconds: number;
      signal: AbortSignal;
      operation: (
        database: OwnedSqliteConnection,
        remainingMilliseconds: () => number,
      ) => Promise<Value> | Value;
    }>,
  ) => Promise<Value>;
}>;

type Loader = Readonly<{
  load: (
    authority: Readonly<{
      manifestDigest: string;
      nativeTupleId: string;
      platformTupleId: string;
    }>,
  ) => OwnedSqliteOpener;
}>;

type LocalSqliteRuntimeTestingHooks = Readonly<{
  afterSharedLeaseAcquired?: ((lifecycleDirectory: string) => void) | undefined;
  beforeSharedDatabaseOpen?: (() => void) | undefined;
  childIdentity?: ((pid: number) => string | undefined) | undefined;
  reporterPrograms?: LocalSqliteReporterChildPrograms | undefined;
  retrieverPrograms?: LocalSqliteRetrieverChildPrograms | undefined;
}>;

let productionRuntime: LocalSqliteProductionRuntime | undefined;
const monotonicNow = performance.now.bind(performance);

const withSharedDatabase = async <Value>(
  input: Readonly<{
    home: LocalResourceHome;
    opener: OwnedSqliteOpener;
    connectionId: string;
    lifecycleFingerprint: string;
    maximumWorkMilliseconds: number;
    signal: AbortSignal;
    operation: (
      database: OwnedSqliteConnection,
      remainingMilliseconds: () => number,
    ) => Promise<Value> | Value;
    allowPathFallbackForTesting: boolean;
    testingHooks?: LocalSqliteRuntimeTestingHooks | undefined;
  }>,
  // eslint-disable-next-line max-lines-per-function, complexity -- testing-only shared-database seam owns one lease/open/operation/close/release transaction.
): Promise<Value> => {
  const {
    home,
    opener,
    connectionId,
    lifecycleFingerprint,
    maximumWorkMilliseconds,
    signal,
    operation,
    allowPathFallbackForTesting,
    testingHooks,
  } = input;
  if (
    signal.aborted ||
    !Number.isSafeInteger(maximumWorkMilliseconds) ||
    maximumWorkMilliseconds < 1 ||
    maximumWorkMilliseconds > 60_000
  )
    throw new Error("destination.local-sqlite.unavailable");
  const startedAt = monotonicNow();
  const remaining = (): number =>
    Math.floor(maximumWorkMilliseconds - (monotonicNow() - startedAt));
  /* v8 ignore next -- the only admitted native tuple is Linux; Windows path
     grammar remains governed in the namespace compiler's own matrix. */
  const namespace = planLocalSqliteNamespace({
    agentscopeHome: home.root,
    connectionId,
    platform: home.platform === "win32" ? "win32" : "posix",
  });
  const gate: LocalSqliteLifecycleGatePort =
    createLocalSqliteFilesystemGatePort(namespace.lifecycleDirectory, {
      allowPathFallbackForTesting,
      atomicExchange: opener.exchangeOwnedFiles,
      lockOwnedFile: opener.lockOwnedFile,
      unlockOwnedFile: opener.unlockOwnedFile,
    });
  const acquired = await acquireLocalSqliteSharedLease(gate, {
    leaseId: randomBytes(16).toString("hex"),
    lifecycleFingerprint,
    lifecycleGeneration: 1,
    parent: Object.freeze({
      pid: process.pid,
      startIdentity: currentProcessStartIdentity(),
    }),
  });
  if (!acquired.ok)
    throw new Error(`destination.local-sqlite.${acquired.state}`);
  testingHooks?.afterSharedLeaseAcquired?.(namespace.lifecycleDirectory);
  const remainingWorkMilliseconds = remaining();
  if (signal.aborted || remainingWorkMilliseconds < 1) {
    const released = await releaseLocalSqliteSharedLease(gate, acquired.value);
    if (!released.ok)
      throw new Error("destination.local-sqlite.outcome-unknown");
    throw new Error("destination.local-sqlite.unavailable");
  }
  let database: OwnedSqliteConnection | undefined;
  let connectionDirectory: OwnedDirectory | undefined;
  let databaseFile: OwnedFile | undefined;
  let operationError: Error | undefined;
  let value: Value | undefined;
  try {
    testingHooks?.beforeSharedDatabaseOpen?.();
    if (signal.aborted) throw new Error("destination.local-sqlite.unavailable");
    connectionDirectory = openOwnedDirectory(
      namespace.connectionNamespace,
      allowPathFallbackForTesting,
    );
    const databaseName = basename(namespace.databasePath);
    const familyBefore = inspectOwnedSqliteFamily(
      connectionDirectory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    const before = familyBefore.find(
      ({ name }) => name === databaseName,
    )!.evidence;
    databaseFile = openOwnedFile(
      connectionDirectory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
      { writable: true, requireNonempty: true },
    );
    database = openOwnedSqliteDescriptor(
      opener,
      databaseFile,
      { fileMustExist: true, timeout: remainingWorkMilliseconds },
      allowPathFallbackForTesting,
    );
    const familyOpened = inspectOwnedSqliteFamily(
      connectionDirectory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    const opened = familyOpened.find(
      ({ name }) => name === databaseName,
    )!.evidence;
    if (opened.physicalIdentity !== before.physicalIdentity)
      throw new Error("destination.local-sqlite.reconciliation-required");
    for (const prior of familyBefore) {
      const current = familyOpened.find(({ name }) => name === prior.name);
      if (
        current === undefined ||
        current.evidence.physicalIdentity !== prior.evidence.physicalIdentity
      )
        throw new Error("destination.local-sqlite.reconciliation-required");
    }
    const afterOpenBudget = remaining();
    if (signal.aborted || afterOpenBudget < 1)
      throw new Error("destination.local-sqlite.unavailable");
    initializeOwnedSqliteConnection(database, afterOpenBudget);
    value = await operation(database, remaining);
    if (signal.aborted || remaining() < 1)
      throw new Error("destination.local-sqlite.unavailable");
    const familyAfter = inspectOwnedSqliteFamily(
      connectionDirectory,
      databaseName,
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    );
    const after = familyAfter.find(
      ({ name }) => name === databaseName,
    )!.evidence;
    if (after.physicalIdentity !== before.physicalIdentity)
      throw new Error("destination.local-sqlite.reconciliation-required");
    databaseFile.assertCurrent();
    connectionDirectory.assertCurrent();
  } catch (error) {
    operationError =
      error instanceof Error
        ? error
        : new Error("destination.local-sqlite.unavailable");
  }
  let cleanupError: Error | undefined;
  try {
    database?.close();
    databaseFile?.assertCurrent();
  } catch {
    cleanupError = new Error("destination.local-sqlite.outcome-unknown");
  }
  try {
    databaseFile?.close();
    connectionDirectory?.close();
  } catch {
    /* v8 ignore next -- OwnedDirectory.close is idempotent and owns its live
       descriptor; the sibling native-close failure path proves precedence. */
    cleanupError = new Error("destination.local-sqlite.outcome-unknown");
  }
  const released = await releaseLocalSqliteSharedLease(gate, acquired.value);
  if (cleanupError !== undefined || !released.ok)
    throw new Error("destination.local-sqlite.outcome-unknown");
  if (operationError !== undefined) throw operationError;
  return value as Value;
};

const reportPreparedWithChild = async (
  input: Readonly<{
    home: LocalResourceHome;
    programs: LocalSqliteReporterChildPrograms;
    opener: OwnedSqliteOpener;
    allowPathFallbackForTesting: boolean;
    childIdentity?: ((pid: number) => string | undefined) | undefined;
    attempt: Parameters<LocalSqliteProductionRuntime["reportPrepared"]>[0];
  }>,
): Promise<ReporterReceipt> => {
  const { home, opener, programs, allowPathFallbackForTesting, attempt } =
    input;
  const manifest = LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST;
  const minimum = manifest.minimumNativeChildBudgetMilliseconds;
  const reserve = manifest.nativeTeardownReserveMilliseconds;
  if (
    attempt.signal.aborted ||
    attempt.remainingMilliseconds() < minimum + reserve ||
    !localSqliteReporterChildBatchFits(attempt.prepared)
  )
    return createReporterReceipt("unavailable");
  /* v8 ignore start -- the admitted native tuple is Linux; Windows grammar is
     covered by the namespace compiler's cross-platform matrix. */
  const namespace = planLocalSqliteNamespace({
    agentscopeHome: home.root,
    connectionId: attempt.connectionId,
    platform: home.platform === "win32" ? "win32" : "posix",
  });
  /* v8 ignore stop */
  const gate = createLocalSqliteFilesystemGatePort(
    namespace.lifecycleDirectory,
    {
      allowPathFallbackForTesting,
      atomicExchange: opener.exchangeOwnedFiles,
      lockOwnedFile: opener.lockOwnedFile,
      unlockOwnedFile: opener.unlockOwnedFile,
    },
  );
  const acquired = await acquireLocalSqliteSharedLease(gate, {
    leaseId: randomBytes(16).toString("hex"),
    lifecycleFingerprint: attempt.lifecycleFingerprint,
    lifecycleGeneration: 1,
    parent: Object.freeze({
      pid: process.pid,
      startIdentity: currentProcessStartIdentity(),
    }),
  });
  if (!acquired.ok) return createReporterReceipt("unavailable");
  const available = Math.floor(attempt.remainingMilliseconds() - reserve);
  if (attempt.signal.aborted || available < minimum) {
    await releaseLocalSqliteSharedLease(gate, acquired.value);
    return createReporterReceipt("unavailable");
  }
  const connection = openOwnedDirectory(
    namespace.connectionNamespace,
    allowPathFallbackForTesting,
  );
  let databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  try {
    databaseFamily = inspectOwnedSqliteFamily(
      connection,
      basename(namespace.databasePath),
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    ).map(({ name, evidence }) =>
      Object.freeze({ name, physicalIdentity: evidence.physicalIdentity }),
    );
  } catch {
    await releaseLocalSqliteSharedLease(gate, acquired.value);
    return createReporterReceipt("unavailable");
  } finally {
    connection.close();
  }
  /* v8 ignore next -- the exact built/native verifier executes this child,
     validates its real database result, and proves watchdog teardown. */
  return executeLocalSqliteReporterChild({
    programs,
    gate,
    lease: acquired.value,
    nonce: randomBytes(16).toString("hex"),
    databasePath: namespace.databasePath,
    databaseFamily: Object.freeze(databaseFamily),
    policy: attempt.policy,
    prepared: attempt.prepared,
    admissionTimeUnixNano: attempt.admissionTimeUnixNano,
    maximumWorkMilliseconds: available,
    minimumUsefulWorkMilliseconds: minimum,
    teardownReserveMilliseconds: reserve,
    signal: attempt.signal,
    ...(input.childIdentity === undefined
      ? {}
      : { childIdentity: input.childIdentity }),
  });
};

const retrieveWithChild = async (
  input: Readonly<{
    home: LocalResourceHome;
    programs: LocalSqliteRetrieverChildPrograms;
    opener: OwnedSqliteOpener;
    allowPathFallbackForTesting: boolean;
    childIdentity?: ((pid: number) => string | undefined) | undefined;
    afterSharedLeaseAcquired?:
      ((lifecycleDirectory: string) => void) | undefined;
    operation: "search" | "get";
    attempt: Readonly<{
      connectionId: string;
      lifecycleFingerprint: string;
      policy: LocalSqliteExecutionPolicy;
      plan: LocalSqliteSearchPlan | LocalSqliteGetPlan;
      signal: AbortSignal;
    }>;
  }>,
): Promise<LocalSqliteSearchEvidence | LocalSqliteGetEvidence> => {
  const {
    home,
    opener,
    programs,
    allowPathFallbackForTesting,
    operation,
    attempt,
  } = input;
  const reserve = 250;
  const startedAt = monotonicNow();
  const remaining = (): number =>
    attempt.plan.maximumWorkMilliseconds - (monotonicNow() - startedAt);
  /* v8 ignore start -- the admitted native tuple is Linux; Windows grammar is
     covered by the namespace compiler's cross-platform matrix. */
  const namespace = planLocalSqliteNamespace({
    agentscopeHome: home.root,
    connectionId: attempt.connectionId,
    platform: home.platform === "win32" ? "win32" : "posix",
  });
  /* v8 ignore stop */
  const gate = createLocalSqliteFilesystemGatePort(
    namespace.lifecycleDirectory,
    {
      allowPathFallbackForTesting,
      atomicExchange: opener.exchangeOwnedFiles,
      lockOwnedFile: opener.lockOwnedFile,
      unlockOwnedFile: opener.unlockOwnedFile,
    },
  );
  const acquired = await acquireLocalSqliteSharedLease(gate, {
    leaseId: randomBytes(16).toString("hex"),
    lifecycleFingerprint: attempt.lifecycleFingerprint,
    lifecycleGeneration: 1,
    parent: Object.freeze({
      pid: process.pid,
      startIdentity: currentProcessStartIdentity(),
    }),
  });
  if (!acquired.ok)
    throw new Error(`destination.local-sqlite.${acquired.state}`);
  input.afterSharedLeaseAcquired?.(namespace.lifecycleDirectory);
  const available = Math.floor(remaining() - reserve);
  if (attempt.signal.aborted || available < 1) {
    const released = await releaseLocalSqliteSharedLease(gate, acquired.value);
    if (!released.ok)
      throw new Error("destination.local-sqlite.outcome-unknown");
    throw new Error("destination.local-sqlite.unavailable");
  }
  const connection = openOwnedDirectory(
    namespace.connectionNamespace,
    allowPathFallbackForTesting,
  );
  let databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  try {
    databaseFamily = inspectOwnedSqliteFamily(
      connection,
      basename(namespace.databasePath),
      LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    ).map(({ name, evidence }) =>
      Object.freeze({ name, physicalIdentity: evidence.physicalIdentity }),
    );
  } catch (error) {
    const released = await releaseLocalSqliteSharedLease(gate, acquired.value);
    if (!released.ok)
      throw new Error("destination.local-sqlite.outcome-unknown", {
        cause: error,
      });
    throw new Error("destination.local-sqlite.filesystem.invalid", {
      cause: error,
    });
  } finally {
    connection.close();
  }
  return executeLocalSqliteRetrieverChild({
    programs,
    gate,
    lease: acquired.value,
    nonce: randomBytes(16).toString("hex"),
    databasePath: namespace.databasePath,
    databaseFamily: Object.freeze(databaseFamily),
    policy: attempt.policy,
    operation,
    plan: attempt.plan,
    maximumWorkMilliseconds: available,
    teardownReserveMilliseconds: reserve,
    signal: attempt.signal,
    ...(input.childIdentity === undefined
      ? {}
      : { childIdentity: input.childIdentity }),
  });
};

const createRuntime = (
  home: LocalResourceHome,
  opener: OwnedSqliteOpener,
  allowPathFallbackForTesting: boolean,
  testingHooks?: LocalSqliteRuntimeTestingHooks,
): LocalSqliteProductionRuntime => {
  const productionHome = Object.freeze({
    root: home.root,
    platform: home.platform,
  });
  const lifecyclePort = createLocalSqliteProductionLifecyclePort({
    home: productionHome,
    filesystemProfile: "local-ext4",
    opener,
    allowPathFallbackForTesting,
  });
  const maintenancePort = createLocalSqliteProductionMaintenancePort({
    home: productionHome,
    filesystemProfile: "local-ext4",
    opener,
    allowPathFallbackForTesting,
  });
  const reporterPrograms =
    testingHooks?.reporterPrograms ??
    Object.freeze({
      workerPath: fileURLToPath(
        new URL(
          "../internal/local-sqlite-runtime/reporter-child.js",
          import.meta.url,
        ),
      ),
      watchdogPath: fileURLToPath(
        new URL(
          "../internal/local-sqlite-runtime/reporter-watchdog.js",
          import.meta.url,
        ),
      ),
    });
  const retrieverPrograms =
    testingHooks?.retrieverPrograms ??
    Object.freeze({
      workerPath: fileURLToPath(
        new URL(
          "../internal/local-sqlite-runtime/retriever-child.js",
          import.meta.url,
        ),
      ),
      watchdogPath: reporterPrograms.watchdogPath,
    });
  const runtime: LocalSqliteProductionRuntime = Object.freeze({
    home: productionHome,
    filesystemProfile: "local-ext4" as const,
    platformId: "linux-x64-node22-ci-ext4-proposed" as const,
    nativeTupleId: "node127-linux-x64-glibc" as const,
    maximumSnapshotBytes: LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES,
    opener,
    lifecyclePort,
    maintenancePort,
    reportPrepared: (attempt) =>
      reportPreparedWithChild({
        home,
        opener,
        programs: reporterPrograms,
        allowPathFallbackForTesting,
        childIdentity: testingHooks?.childIdentity,
        attempt,
      }),
    search: async (attempt) =>
      (await retrieveWithChild({
        home,
        opener,
        programs: retrieverPrograms,
        allowPathFallbackForTesting,
        childIdentity: testingHooks?.childIdentity,
        afterSharedLeaseAcquired: testingHooks?.afterSharedLeaseAcquired,
        operation: "search",
        attempt,
      })) as LocalSqliteSearchEvidence,
    get: async (attempt) =>
      (await retrieveWithChild({
        home,
        opener,
        programs: retrieverPrograms,
        allowPathFallbackForTesting,
        childIdentity: testingHooks?.childIdentity,
        afterSharedLeaseAcquired: testingHooks?.afterSharedLeaseAcquired,
        operation: "get",
        attempt,
      })) as LocalSqliteGetEvidence,
    withSharedDatabase: async ({
      connectionId,
      lifecycleFingerprint,
      policy: _policy,
      maximumWorkMilliseconds,
      signal,
      operation,
    }) =>
      withSharedDatabase({
        home,
        opener,
        connectionId,
        lifecycleFingerprint,
        maximumWorkMilliseconds,
        signal,
        operation,
        allowPathFallbackForTesting,
        testingHooks,
      }),
  });
  return runtime;
};

/* v8 ignore start -- this loader/bootstrap path is executed causally from the
   exact clean-installed Linux candidate; source tests use the restricted
   testing binder because the admitted native tuple is not macOS. */
export const initializeLocalSqliteProductionRuntime = (
  homeAuthority: LocalResourceHomeAuthority,
): LocalSqliteProductionRuntime => {
  const home = resolveLocalResourceHomeAuthority(homeAuthority);
  if (
    LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.maximumSnapshotBytes !==
    LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES
  )
    throw new Error("destination.local-sqlite.native-unavailable");
  if (productionRuntime !== undefined) {
    if (
      productionRuntime.home.root !== home.root ||
      productionRuntime.home.platform !== home.platform
    )
      throw new Error("destination.local-sqlite.native-unavailable");
    return productionRuntime;
  }
  const loaderUrl = new URL(
    "../internal/local-sqlite/loader/owned-loader.cjs",
    import.meta.url,
  );
  const loader = createRequire(import.meta.url)(
    fileURLToPath(loaderUrl),
  ) as Loader;
  const opener = loader.load({
    manifestDigest: LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST_DIGEST,
    nativeTupleId: "node127-linux-x64-glibc",
    platformTupleId: "linux-x64-node22-ci-ext4-proposed",
  });
  productionRuntime = createRuntime(home, opener, false);
  bindLocalSqliteProductionLifecyclePorts(
    productionRuntime.lifecyclePort,
    productionRuntime.maintenancePort,
    productionRuntime.maximumSnapshotBytes,
  );
  return productionRuntime;
};
/* v8 ignore stop */

export const getLocalSqliteProductionRuntime =
  (): LocalSqliteProductionRuntime => {
    /* v8 ignore else -- successful singleton retrieval follows the built-only
       initializer and is asserted by the packed composition gate. */
    if (productionRuntime === undefined)
      throw new Error("destination.local-sqlite.native-unavailable");
    /* v8 ignore next -- paired with the built-only singleton invariant above. */
    return productionRuntime;
  };

export const bindLocalSqliteProductionRuntimeForTesting = (
  homeAuthority: LocalResourceHomeAuthority,
  opener: OwnedSqliteOpener,
  testingHooks?: LocalSqliteRuntimeTestingHooks,
): LocalSqliteProductionRuntime => {
  const home = resolveLocalResourceHomeAuthority(homeAuthority);
  return createRuntime(home, opener, true, testingHooks);
};
