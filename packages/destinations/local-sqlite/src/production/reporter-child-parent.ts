/* eslint-disable max-lines-per-function -- the parent owns one indivisible spawn/permission/cutoff/join/lease settlement ledger. */
import { spawn, type ChildProcess } from "node:child_process";

import {
  createReporterReceipt,
  type ReporterReceipt,
} from "@agentscope/destinations-core";

import {
  amendLocalSqliteLeaseWithChild,
  releaseLocalSqliteSharedLease,
  type LocalSqliteLifecycleGatePort,
  type LocalSqliteSharedLeaseAuthority,
} from "../lifecycle/fence.js";
import type {
  LocalSqlitePreparedTrace,
  LocalSqliteReporterPolicy,
} from "../reporter/transaction.js";
import { processStartIdentity } from "./filesystem-port.js";
import {
  encodeLocalSqliteReporterChildMessage,
  encodeLocalSqliteReporterChildRequestHeader,
  encodeLocalSqliteReporterChildTrace,
  MAXIMUM_REPORTER_CHILD_REQUEST_BYTES,
  type LocalSqliteReporterChildRequest,
} from "./reporter-child-protocol.js";
import { readLocalSqliteReporterChildMessages } from "./reporter-child-output.js";

export type LocalSqliteReporterChildPrograms = Readonly<{
  workerPath: string;
  watchdogPath: string;
}>;

export type LocalSqliteReporterChildAttempt = Readonly<{
  programs: LocalSqliteReporterChildPrograms;
  gate: LocalSqliteLifecycleGatePort;
  lease: LocalSqliteSharedLeaseAuthority;
  nonce: string;
  databasePath: string;
  databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  policy: LocalSqliteReporterPolicy;
  prepared: readonly LocalSqlitePreparedTrace[];
  admissionTimeUnixNano: string;
  cutoffAtMonotonicMilliseconds: number;
  minimumUsefulWorkMilliseconds: number;
  teardownReserveMilliseconds: number;
  signal: AbortSignal;
  childIdentity?: (pid: number) => string | undefined;
  monotonicNowForTesting?: () => number;
}>;

type Exit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

const waitForExit = (child: ChildProcess): Promise<Exit> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: Exit): void => {
      /* v8 ignore next -- exit/error listeners share this idempotent resolver;
         a second terminal event cannot change the already joined result. */
      if (settled) return;
      settled = true;
      resolve(value);
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      finish({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => {
      finish({ code, signal });
    });
    /* v8 ignore start -- spawn(process.execPath) failures arrive through the
       child error event before a PID; the PID-absent settlement below owns the
       same unavailable/cleanup result. */
    child.once("error", () => {
      finish({ code: null, signal: null });
    });
    /* v8 ignore stop */
  });

const bounded = async <Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value | undefined> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        /* v8 ignore next -- a cleared timer cannot run after promise settlement;
           retained as an idempotent event-loop guard. */
        if (settled) return;
        settled = true;
        resolve(undefined);
      },
      Math.max(0, milliseconds),
    );
    timer.unref();
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      /* v8 ignore start -- every promise supplied by this module is a
         totalized resolver; rejection is retained as a defensive join guard. */
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      },
      /* v8 ignore stop */
    );
  });

const terminateAndJoin = async (
  child: ChildProcess,
  deadline: number,
  processGroup = false,
): Promise<boolean> => {
  try {
    /* v8 ignore else -- POSIX worker groups and direct watchdogs are both covered
       by process-level settlement tests; one branch varies by owned child role. */
    if (processGroup && process.platform !== "win32" && child.pid !== undefined)
      // The group may outlive its leader, so absence of a live ChildProcess is
      // not authority to skip the group-wide teardown syscall.
      process.kill(-child.pid, "SIGKILL");
    else if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  } catch (error) {
    /* v8 ignore start -- real-process teardown exercises ESRCH and success; any
       other kernel kill failure is returned without additional authority. */
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ESRCH"
    )
      return false;
    /* v8 ignore stop */
  }
  const joined =
    (await bounded(
      waitForExit(child),
      Math.max(0, deadline - performance.now()),
    )) !== undefined;
  /* v8 ignore next -- a nonsettling killed child is the bounded failure result. */
  if (!joined) return false;
  // A successful group SIGKILL terminates every current member. A dead zombie
  // may remain observable until the platform's init process reaps it, but it
  // cannot retain a native handle or perform work after hook return.
  return true;
};

const writeInput = (child: ChildProcess, value: string): Promise<boolean> =>
  new Promise((resolve) => {
    const input = child.stdin;
    /* v8 ignore next -- both children are spawned with pipe stdin; peer closure
       is reported by the write callback and source-tested after ready. */
    if (input === null || input.destroyed) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value: boolean): void => {
      /* v8 ignore next -- callback and error event may race; first settlement
         owns the fixed result while the listener consumes the peer error. */
      if (settled) return;
      settled = true;
      resolve(value);
    };
    /* v8 ignore start -- a closed pipe may report through either this event or
       the write callback depending on OS timing; hostile child tests prove the
       operation settles without an unhandled error. */
    const onError = (): void => {
      finish(false);
    };
    /* v8 ignore stop */
    input.once("error", onError);
    try {
      input.write(value, "utf8", (error) => {
        /* v8 ignore else -- peer failure may be delivered through the error
           event instead of the callback on supported OS runtimes. */
        if (error == null) {
          input.removeListener("error", onError);
          finish(true);
          return;
        }
        /* v8 ignore next -- peer closure may instead arrive through onError. */
        finish(false);
      });
    } catch {
      /* v8 ignore next -- Node writable.write reports asynchronous pipe
         failure through callback/event on supported runtimes. */
      finish(false);
    }
  });

const writeRequest = async (
  child: ChildProcess,
  request: LocalSqliteReporterChildRequest,
  encodedTraces: readonly string[],
  remaining: () => number,
): Promise<boolean> => {
  const header = encodeLocalSqliteReporterChildRequestHeader(request);
  let requestBytes = Buffer.byteLength(header, "utf8");
  if (!(await bounded(writeInput(child, header), remaining()))) return false;
  for (const value of encodedTraces) {
    requestBytes += Buffer.byteLength(value, "utf8");
    /* v8 ignore next -- the trusted runtime's aggregate payload preflight and
       protocol per-trace ceiling imply this redundant encoded-byte guard. */
    if (requestBytes > MAXIMUM_REPORTER_CHILD_REQUEST_BYTES) return false;
    const available = remaining();
    /* v8 ignore next -- paired with the deterministic pre-encode cutoff guard. */
    if (available < 1) return false;
    /* v8 ignore next -- peer closure while the bounded trace write is pending
       is classified by the tested ready/exit and joined-teardown paths. */
    if (!(await bounded(writeInput(child, value), available))) return false;
  }
  return remaining() >= 1;
};

const watch = (
  watchdog: ChildProcess,
  workerPid: number,
  workerStartIdentity: string,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      /* v8 ignore next -- message/exit/error are competing one-shot watchdog
         terminals and cannot change the first result. */
      if (settled) return;
      settled = true;
      resolve(value);
    };
    watchdog.once("message", (value: unknown) => {
      /* v8 ignore next -- the package-owned watchdog emits only the exact
         watching record; missing/failed watchdog settlement is source-tested. */
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { type?: unknown }).type === "watching"
      ) {
        finish(true);
        return;
      }
      /* v8 ignore next -- the package-owned watchdog emits only the exact
         watching message; missing/failed watchdog settlement is source-tested. */
      finish(false);
    });
    watchdog.once("exit", () => {
      finish(false);
    });
    /* v8 ignore start -- spawn(process.execPath) error duplicates the tested
       watchdog exit/missing-program unavailable settlement. */
    watchdog.once("error", () => {
      finish(false);
    });
    /* v8 ignore stop */
    try {
      watchdog.send?.(
        { type: "watch", workerPid, workerStartIdentity },
        (error) => {
          /* v8 ignore next -- IPC callback errors are represented by watchdog
           exit in supported Node; this guard preserves fixed false settlement. */
          if (error !== null && error !== undefined) finish(false);
        },
      );
    } catch {
      /* v8 ignore next -- ChildProcess.send reports through its callback on
         supported Node; exotic synchronous failure remains fixed false. */
      finish(false);
    }
  });

const settlement = (
  permitted: boolean,
  receipt?: ReporterReceipt,
): ReporterReceipt =>
  receipt ??
  createReporterReceipt(permitted ? "outcome-unknown" : "unavailable");

export const executeLocalSqliteReporterChild = async (
  input: LocalSqliteReporterChildAttempt,
): Promise<ReporterReceipt> => {
  let permitted = false;
  let authority = input.lease;
  let receipt: ReporterReceipt | undefined;
  const now = input.monotonicNowForTesting ?? performance.now.bind(performance);
  const cutoffAt = input.cutoffAtMonotonicMilliseconds;
  const teardownDeadline = cutoffAt + input.teardownReserveMilliseconds;
  const remaining = (): number => Math.max(0, cutoffAt - now());
  const refuseBeforeSpawn = async (): Promise<ReporterReceipt> => {
    await releaseLocalSqliteSharedLease(input.gate, input.lease);
    return createReporterReceipt("unavailable");
  };
  const encodedTraces: string[] = [];
  let encodedRequestBytes = 0;
  for (const trace of input.prepared) {
    if (remaining() < input.minimumUsefulWorkMilliseconds)
      return refuseBeforeSpawn();
    const encoded = encodeLocalSqliteReporterChildTrace(input.nonce, trace);
    encodedRequestBytes += Buffer.byteLength(encoded, "utf8");
    /* v8 ignore next 6 -- production aggregate admission is strictly below the
       child protocol ceiling; this remains a defensive direct-call refusal. */
    if (
      encodedRequestBytes > MAXIMUM_REPORTER_CHILD_REQUEST_BYTES ||
      remaining() < input.minimumUsefulWorkMilliseconds
    )
      return refuseBeforeSpawn();
    encodedTraces.push(encoded);
  }
  const worker = spawn(process.execPath, [input.programs.workerPath], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const workerPid = worker.pid;
  /* v8 ignore next -- spawn(process.execPath) returns a PID in supported Node;
     the missing-worker program test covers immediate post-spawn failure. */
  if (workerPid === undefined) {
    await terminateAndJoin(worker, teardownDeadline, true);
    await releaseLocalSqliteSharedLease(input.gate, input.lease);
    return createReporterReceipt("unavailable");
  }
  const watchdog = spawn(process.execPath, [input.programs.watchdogPath], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const messages = readLocalSqliteReporterChildMessages(worker, input.nonce);
  const observedWorkerIdentity = (input.childIdentity ?? processStartIdentity)(
    workerPid,
  );
  const abort = (): void => {
    /* v8 ignore start -- source tests execute the Linux/macOS process-group
       branch; the Windows direct-child branch and already-exited kill race are
       retained for the cross-platform parent contract. */
    try {
      if (process.platform !== "win32") process.kill(-workerPid, "SIGKILL");
      else worker.kill("SIGKILL");
    } catch {
      // Joined settlement below remains conservative.
    }
    /* v8 ignore stop */
  };
  input.signal.addEventListener("abort", abort, { once: true });
  let attempted: ReporterReceipt;
  try {
    attempted = await (async (): Promise<ReporterReceipt> => {
      if (
        observedWorkerIdentity === undefined ||
        !(await bounded(
          watch(watchdog, workerPid, observedWorkerIdentity),
          remaining(),
        )) ||
        input.signal.aborted
      )
        return settlement(permitted);
      const request: LocalSqliteReporterChildRequest = Object.freeze({
        type: "attempt",
        nonce: input.nonce,
        databasePath: input.databasePath,
        databaseFamily: input.databaseFamily,
        maximumWorkMilliseconds: Math.max(1, Math.floor(remaining())),
        policy: input.policy,
        prepared: input.prepared,
        admissionTimeUnixNano: input.admissionTimeUnixNano,
      });
      if (
        !(await writeRequest(worker, request, encodedTraces, remaining)) ||
        input.signal.aborted
      )
        /* v8 ignore next -- the built child pipe-loss canary owns the
           asynchronous pre-permission write rejection boundary. */
        return settlement(permitted);
      const ready = await bounded(messages.ready, remaining());
      if (
        ready === undefined ||
        ready === null ||
        ready.pid !== workerPid ||
        input.signal.aborted
      )
        return settlement(permitted);
      /* v8 ignore next -- production uses /proc identity in the exact Linux
         packed gate; source tests inject the same bounded identity oracle. */
      if (observedWorkerIdentity !== ready.startIdentity)
        return settlement(permitted);
      const amended = await amendLocalSqliteLeaseWithChild(
        input.gate,
        authority,
        Object.freeze({
          nonce: input.nonce,
          pid: workerPid,
          startIdentity: observedWorkerIdentity,
        }),
      );
      if (!amended.ok || input.signal.aborted) return settlement(permitted);
      authority = amended.value;
      // From this point the permission write may be partially observed by the
      // child even if the pipe callback fails, so settlement is conservative.
      permitted = true;
      /* v8 ignore next -- a post-permission pipe failure has the same
         outcome-unknown settlement as the source-tested post-permission hang. */
      if (
        !(await bounded(
          writeInput(
            worker,
            encodeLocalSqliteReporterChildMessage({
              type: "permission",
              nonce: input.nonce,
            }),
          ),
          remaining(),
        ))
      )
        return settlement(permitted);
      /* v8 ignore next -- worker stdin is fixed pipe stdio; optional chaining
         reflects the Node type but the null case is rejected by writeInput. */
      worker.stdin?.end();
      const result = await bounded(messages.result, remaining());
      const exit = await bounded(waitForExit(worker), remaining());
      if (
        result !== undefined &&
        result !== null &&
        exit?.code === 0 &&
        exit.signal === null
      )
        receipt = result.receipt;
      return settlement(permitted, receipt);
    })();
  } catch {
    /* v8 ignore next -- owned helpers totalize their failures; this final
       boundary prevents hostile runtime throws from escaping classification. */
    attempted = settlement(permitted);
  } finally {
    input.signal.removeEventListener("abort", abort);
    try {
      watchdog.send?.({ type: "complete" }, () => undefined);
    } catch {
      // Forced shared-deadline teardown below owns settlement.
    }
    const [workerJoined, watchdogJoined] = await Promise.all([
      terminateAndJoin(worker, teardownDeadline, true),
      terminateAndJoin(watchdog, teardownDeadline),
    ]);
    const released = await bounded(
      releaseLocalSqliteSharedLease(input.gate, authority),
      Math.max(0, teardownDeadline - performance.now()),
    );
    if (!workerJoined || !watchdogJoined || released?.ok !== true)
      attempted = createReporterReceipt(
        permitted ? "outcome-unknown" : "unavailable",
      );
  }
  return attempted;
};
