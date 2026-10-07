import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import type {
  LocalResourceHome,
  ReporterDeadline,
} from "@agentscope/destinations-core";
import {
  acquireLocalSqliteSharedLease,
  releaseLocalSqliteSharedLease,
  type LocalSqliteLifecycleGatePort,
  type LocalSqliteSharedLeaseAuthority,
} from "../lifecycle/fence.js";
import { LOCAL_SQLITE_MAXIMUM_SNAPSHOT_BYTES } from "../lifecycle/capability.js";
import { LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST } from "../native-support.js";
import { planLocalSqliteNamespace } from "../lifecycle/namespace.js";
import {
  createLocalSqliteFilesystemGatePort,
  currentProcessStartIdentity,
} from "./filesystem-port.js";
import type { OwnedSqliteOpener } from "./lifecycle-port.js";
import type { LocalSqliteExecutionPolicy } from "./sqlite-port.js";
import {
  executeLocalSqliteRetrieverChild,
  type LocalSqliteRetrieverChildPrograms,
} from "./retriever-child-parent.js";
import type {
  LocalSqliteGetEvidence,
  LocalSqliteGetPlan,
  LocalSqliteSearchEvidence,
  LocalSqliteSearchPlan,
} from "../retriever/evidence-types.js";
import {
  inspectOwnedSqliteFamily,
  openOwnedDirectory,
} from "./owned-filesystem.js";
import {
  createLocalSqliteFailureLedger,
  retrievalFailureStages as stages,
} from "./retrieval-diagnostics.js";
const monotonicNow = performance.now.bind(performance);

const observeOwnedFamily = async (
  input: Readonly<{
    namespace: ReturnType<typeof planLocalSqliteNamespace>;
    gate: LocalSqliteLifecycleGatePort;
    lease: LocalSqliteSharedLeaseAuthority;
    allowPathFallbackForTesting: boolean;
    ledger: ReturnType<typeof createLocalSqliteFailureLedger>;
  }>,
) => {
  const { namespace, gate, lease, allowPathFallbackForTesting, ledger } = input;
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
    ledger.capture();
    const released = await releaseLocalSqliteSharedLease(gate, lease);
    ledger.settle(null, null, released.ok);
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
  return databaseFamily;
};

export const retrieveWithChild = async (
  input: Readonly<{
    home: LocalResourceHome;
    programs: LocalSqliteRetrieverChildPrograms;
    opener: OwnedSqliteOpener;
    allowPathFallbackForTesting: boolean;
    childIdentity?: ((pid: number) => string | undefined) | undefined;
    afterSharedLeaseAcquired?:
      ((lifecycleDirectory: string) => void) | undefined;
    executeChild?: typeof executeLocalSqliteRetrieverChild | undefined;
    failureLedger?: ReturnType<typeof createLocalSqliteFailureLedger>;
    operation: "search" | "get";
    attempt: Readonly<{
      connectionId: string;
      lifecycleFingerprint: string;
      policy: LocalSqliteExecutionPolicy;
      plan: LocalSqliteSearchPlan | LocalSqliteGetPlan;
      signal: AbortSignal;
      deadline: ReporterDeadline;
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
  const reserve =
    LOCAL_SQLITE_NATIVE_SUPPORT_MANIFEST.nativeTeardownReserveMilliseconds;
  const cutoffAtMonotonicMilliseconds =
    attempt.deadline.expiresAtMonotonicMilliseconds - reserve;
  const ledger =
    input.failureLedger ??
    createLocalSqliteFailureLedger(cutoffAtMonotonicMilliseconds);
  ledger.enter(stages.leaseAcquisition);
  try {
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
    ledger.enter(stages.preChildCutoff);
    if (
      attempt.signal.aborted ||
      cutoffAtMonotonicMilliseconds - monotonicNow() < 1
    ) {
      ledger.capture();
      const released = await releaseLocalSqliteSharedLease(
        gate,
        acquired.value,
      );
      ledger.settle(null, null, released.ok);
      /* v8 ignore next 2 -- exact shared-lease cleanup failure classification is
       proved in the fence module; this path preserves its fixed outcome. */
      if (!released.ok)
        throw new Error("destination.local-sqlite.outcome-unknown");
      throw new Error("destination.local-sqlite.unavailable");
    }
    ledger.enter(stages.familyObservation);
    const databaseFamily = await observeOwnedFamily({
      namespace,
      gate,
      lease: acquired.value,
      allowPathFallbackForTesting,
      ledger,
    });
    ledger.enter(stages.childSetup);
    return await (input.executeChild ?? executeLocalSqliteRetrieverChild)({
      programs,
      gate,
      lease: acquired.value,
      nonce: randomBytes(16).toString("hex"),
      databasePath: namespace.databasePath,
      databaseFamily: Object.freeze(databaseFamily),
      policy: attempt.policy,
      operation,
      plan: attempt.plan,
      cutoffAtMonotonicMilliseconds,
      teardownReserveMilliseconds: reserve,
      signal: attempt.signal,
      failureLedger: ledger,
      ...(input.childIdentity === undefined
        ? {}
        : { childIdentity: input.childIdentity }),
    });
  } catch (error) {
    ledger.capture();
    throw error;
  }
};
