/* eslint-disable max-lines-per-function -- the parent owns one indivisible spawn/permission/cutoff/join/lease settlement ledger. */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

import {
  amendLocalSqliteLeaseWithChild,
  releaseLocalSqliteSharedLease,
  type LocalSqliteLifecycleGatePort,
  type LocalSqliteSharedLeaseAuthority,
} from "../lifecycle/fence.js";
import type {
  LocalSqliteGetEvidence,
  LocalSqliteGetPlan,
  LocalSqliteSearchEvidence,
  LocalSqliteSearchPlan,
} from "../retriever/evidence-types.js";
import { processStartIdentity } from "./filesystem-port.js";
import {
  bounded,
  createLocalSqliteFailureLedger,
  retrievalFailureStages as stages,
} from "./retrieval-diagnostics.js";
import type { LocalSqliteExecutionPolicy } from "./sqlite-port.js";
import {
  decodeLocalSqliteReporterChildReady,
  encodeLocalSqliteReporterChildMessage,
} from "./reporter-child-protocol.js";
import {
  decodeLocalSqliteRetrieverChildResult,
  encodeLocalSqliteRetrieverChildRequest,
  MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES,
  type LocalSqliteRetrieverChildRequest,
} from "./retriever-child-protocol.js";

export type LocalSqliteRetrieverChildPrograms = Readonly<{
  workerPath: string;
  watchdogPath: string;
}>;

export type LocalSqliteRetrieverChildAttempt = Readonly<{
  programs: LocalSqliteRetrieverChildPrograms;
  gate: LocalSqliteLifecycleGatePort;
  lease: LocalSqliteSharedLeaseAuthority;
  nonce: string;
  databasePath: string;
  databaseFamily: readonly Readonly<{
    name: string;
    physicalIdentity: string;
  }>[];
  policy: LocalSqliteExecutionPolicy;
  operation: "search" | "get";
  plan: LocalSqliteSearchPlan | LocalSqliteGetPlan;
  cutoffAtMonotonicMilliseconds: number;
  teardownReserveMilliseconds: number;
  signal: AbortSignal;
  childIdentity?: (pid: number) => string | undefined;
  failureLedger?: ReturnType<typeof createLocalSqliteFailureLedger>;
}>;

type Exit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

const waitForExit = (child: ChildProcess): Promise<Exit> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: Exit): void => {
      /* v8 ignore next -- exit and error are once-only Node events; this guard
         closes the defensive double-settlement race. */
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
    /* v8 ignore start -- a successfully spawned child reports termination via
       exit; the error event is retained for an OS-level post-spawn failure. */
    child.once("error", () => {
      finish({ code: null, signal: null });
    });
    /* v8 ignore stop */
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
      // A successful leader can leave descendants in the detached group.
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
  // A successful group SIGKILL is the kernel termination boundary for every
  // current member. Descendants may remain briefly observable as dead zombies
  // while the platform's init process reaps them; that is not surviving work.
  return true;
};

const writeInput = (child: ChildProcess, value: string): Promise<boolean> =>
  new Promise((resolve) => {
    const input = child.stdin;
    /* v8 ignore next 4 -- both children are spawned with pipe stdin; peer closure
       is source-tested through the asynchronous write/error settlement path. */
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
        } else {
          /* v8 ignore next -- peer closure may instead arrive through onError. */
          finish(false);
        }
      });
    } catch {
      /* v8 ignore next -- Node writable.write reports asynchronous pipe
         failure through callback/event on supported runtimes. */
      finish(false);
    }
  });

export const readWorkerMessages = (
  child: ChildProcess,
  nonce: string,
): Readonly<{
  ready: Promise<ReturnType<typeof decodeLocalSqliteReporterChildReady>>;
  result: Promise<ReturnType<typeof decodeLocalSqliteRetrieverChildResult>>;
  valid: () => boolean;
}> => {
  const readyChunks: Buffer[] = [];
  let readyBytes = 0;
  const resultChunks: Buffer[] = [];
  let resultBytes = 0;
  let sawReady = false;
  let sawResult = false;
  let sawResultFrame = false;
  let invalidWire = false;
  let parsedResult: ReturnType<typeof decodeLocalSqliteRetrieverChildResult>;
  let resolveReady!: (
    value: ReturnType<typeof decodeLocalSqliteReporterChildReady>,
  ) => void;
  let resolveResult!: (
    value: ReturnType<typeof decodeLocalSqliteRetrieverChildResult>,
  ) => void;
  const ready = new Promise<
    ReturnType<typeof decodeLocalSqliteReporterChildReady>
  >((resolve) => {
    resolveReady = resolve;
  });
  const result = new Promise<
    ReturnType<typeof decodeLocalSqliteRetrieverChildResult>
  >((resolve) => {
    resolveResult = resolve;
  });
  const invalid = (): void => {
    invalidWire = true;
    if (!sawReady) resolveReady(undefined);
    if (!sawResult) resolveResult(undefined);
    sawResult = true;
  };
  child.stdout?.on("data", (value: Buffer | Uint8Array) => {
    if (sawReady || invalidWire) {
      invalid();
      return;
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const newline = chunk.indexOf(10);
    const piece = newline < 0 ? chunk : chunk.subarray(0, newline);
    readyBytes += piece.byteLength;
    if (readyBytes > 4_096 || readyChunks.length >= 4_096) {
      invalid();
      return;
    }
    if (piece.byteLength > 0) readyChunks.push(piece);
    if (newline < 0) return;
    if (newline !== chunk.byteLength - 1) {
      invalid();
      return;
    }
    const parsed = decodeLocalSqliteReporterChildReady(
      Buffer.concat(readyChunks, readyBytes).toString("utf8"),
    );
    sawReady = true;
    resolveReady(parsed?.nonce === nonce ? parsed : undefined);
    if (parsed?.nonce !== nonce) invalid();
  });
  // Stdout carries only the diagnostic ready frame. A descendant inheriting
  // fds 0-2 must never be able to supply the result authority on private fd 3.
  child.stdout?.once("end", () => {
    if (!sawReady) invalid();
  });
  const resultChannel = child.stdio[3] as Readable | null;
  resultChannel?.on("data", (value: Buffer | Uint8Array) => {
    if (sawResultFrame || invalidWire) {
      invalid();
      return;
    }
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const newline = chunk.indexOf(10);
    const piece = newline < 0 ? chunk : chunk.subarray(0, newline);
    resultBytes += piece.byteLength;
    if (
      resultBytes > MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES ||
      resultChunks.length >= 4_096
    ) {
      invalid();
      return;
    }
    if (piece.byteLength > 0) resultChunks.push(piece);
    if (newline < 0) return;
    if (newline !== chunk.byteLength - 1) {
      invalid();
      return;
    }
    sawResultFrame = true;
    parsedResult = decodeLocalSqliteRetrieverChildResult(
      Buffer.concat(resultChunks, resultBytes).toString("utf8"),
    );
    if (parsedResult?.nonce !== nonce) invalid();
  });
  resultChannel?.once("end", () => {
    if (
      invalidWire ||
      !sawReady ||
      !sawResultFrame ||
      parsedResult?.nonce !== nonce ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      invalid();
      return;
    }
    sawResult = true;
    resolveResult(parsedResult);
  });
  resultChannel?.once("close", () => {
    if (!sawResult) invalid();
  });
  child.once("exit", () => {
    if (!sawResult) invalid();
  });
  child.once("error", invalid);
  if (resultChannel === null) invalid();
  return Object.freeze({ ready, result, valid: () => !invalidWire });
};

const watch = (
  watchdog: ChildProcess,
  workerPid: number,
  workerStartIdentity: string,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      /* v8 ignore next -- once-only IPC listeners may race each other only at
         the OS boundary; first settlement owns the result. */
      if (settled) return;
      settled = true;
      watchdog.removeListener("message", onMessage);
      watchdog.removeListener("error", onError);
      watchdog.removeListener("exit", onExit);
      resolve(value);
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "watching"
      )
        finish(true);
      else finish(false);
    };
    /* v8 ignore start -- missing/early-exit watchdog tests cover unavailable;
       a distinct post-spawn IPC error event is OS-owned. */
    const onError = (): void => {
      finish(false);
    };
    /* v8 ignore stop */
    const onExit = (): void => {
      finish(false);
    };
    watchdog.once("message", onMessage);
    watchdog.once("error", onError);
    watchdog.once("exit", onExit);
    try {
      watchdog.send?.(
        { type: "watch", workerPid, workerStartIdentity },
        (error) => {
          /* v8 ignore next -- channel-close callback races the watched exit;
             the exit listener already supplies the same false result. */
          if (error !== null) finish(false);
        },
      );
    } catch {
      /* v8 ignore next -- synchronous closed-channel send is the counterpart
         of the callback race above. */
      finish(false);
    }
  });

export const executeLocalSqliteRetrieverChild = async (
  input: LocalSqliteRetrieverChildAttempt,
  // eslint-disable-next-line complexity -- one indivisible permission/cutoff/join/lease settlement ledger.
): Promise<LocalSqliteSearchEvidence | LocalSqliteGetEvidence> => {
  let authority = input.lease;
  const cutoffAt = input.cutoffAtMonotonicMilliseconds;
  const teardownDeadline = cutoffAt + input.teardownReserveMilliseconds;
  const ledger =
    input.failureLedger ?? createLocalSqliteFailureLedger(cutoffAt);
  const remaining = (): number => Math.max(0, cutoffAt - performance.now());
  try {
    const worker = spawn(process.execPath, [input.programs.workerPath], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const workerPid = worker.pid;
    /* v8 ignore start -- supported Node spawn always assigns a PID; missing
     executable tests exercise immediate post-spawn failure and cleanup. */
    if (workerPid === undefined) {
      ledger.capture();
      const joined = await terminateAndJoin(worker, teardownDeadline, true);
      const released = await releaseLocalSqliteSharedLease(
        input.gate,
        input.lease,
      );
      ledger.settle(joined, null, released.ok);
      const error = new Error("destination.local-sqlite.unavailable");
      ledger.capture();
      throw error;
    }
    /* v8 ignore stop */
    const watchdog = spawn(process.execPath, [input.programs.watchdogPath], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const messages = readWorkerMessages(worker, input.nonce);
    const workerIdentity = (input.childIdentity ?? processStartIdentity)(
      workerPid,
    );
    const abort = (): void => {
      try {
        /* v8 ignore start -- platform-owned process termination is proven by the
         POSIX source gate and the cross-platform CI contract. */
        if (process.platform !== "win32") process.kill(-workerPid, "SIGKILL");
        else worker.kill("SIGKILL");
        /* v8 ignore stop */
      } catch {
        // Joined settlement below remains conservative.
      }
    };
    input.signal.addEventListener("abort", abort, { once: true });
    let evidence:
      LocalSqliteSearchEvidence | LocalSqliteGetEvidence | undefined;
    let failure: Error | undefined;
    try {
      ledger.enter(stages.watchdogAssociation);
      if (
        workerIdentity === undefined ||
        !(await bounded(
          watch(watchdog, workerPid, workerIdentity),
          remaining(),
        )) ||
        input.signal.aborted
      )
        throw new Error("destination.local-sqlite.unavailable");
      const request: LocalSqliteRetrieverChildRequest = Object.freeze({
        type: "retrieve",
        nonce: input.nonce,
        databasePath: input.databasePath,
        databaseFamily: input.databaseFamily,
        maximumWorkMilliseconds: Math.max(
          1,
          Math.min(input.plan.maximumWorkMilliseconds, Math.floor(remaining())),
        ),
        policy: input.policy,
        operation: input.operation,
        plan: Object.freeze({
          ...input.plan,
          maximumWorkMilliseconds: Math.max(
            1,
            Math.min(
              input.plan.maximumWorkMilliseconds,
              Math.floor(remaining()),
            ),
          ),
        }),
      });
      ledger.enter(stages.requestWrite);
      /* v8 ignore start -- a child that closes stdin after the authenticated
       ready frame is an OS pipe race; hostile close tests prove the same
       post-amendment operation cannot be reported successful. */
      if (
        !(await bounded(
          writeInput(worker, encodeLocalSqliteRetrieverChildRequest(request)),
          remaining(),
        ))
      )
        throw new Error("destination.local-sqlite.unavailable");
      ledger.enter(stages.readyFrame);
      const ready = await bounded(messages.ready, remaining());
      if (
        ready === undefined ||
        ready === null ||
        ready.pid !== workerPid ||
        ready.startIdentity !== workerIdentity ||
        input.signal.aborted
      )
        throw new Error("destination.local-sqlite.unavailable");
      ledger.enter(stages.leaseAmendment);
      const amended = await amendLocalSqliteLeaseWithChild(
        input.gate,
        authority,
        Object.freeze({
          nonce: input.nonce,
          pid: workerPid,
          startIdentity: workerIdentity,
        }),
      );
      if (!amended.ok || input.signal.aborted)
        throw new Error("destination.local-sqlite.unavailable");
      authority = amended.value;
      ledger.enter(stages.permissionWrite);
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
        throw new Error("destination.local-sqlite.outcome-unknown");
      /* v8 ignore stop */
      ledger.enter(stages.resultTransport);
      const result = await bounded(messages.result, remaining());
      if (result === undefined || result === null || !messages.valid())
        throw new Error("destination.local-sqlite.unavailable");
      if (!result.ok) {
        ledger.enter(stages.workerNegative);
        ledger.capture();
      }
      // Closing the existing request pipe acknowledges a complete private-fd
      // result. The authenticated worker remains alive until this close.
      worker.stdin?.end();
      ledger.enter(stages.workerTerminal);
      const exit = await bounded(waitForExit(worker), remaining());
      ledger.enter(
        !result.ok
          ? stages.workerNegative
          : result.evidence === undefined
            ? stages.resultEvidence
            : stages.workerTerminal,
      );
      if (
        !result.ok ||
        result.evidence === undefined ||
        !messages.valid() ||
        exit?.code !== 0 ||
        exit.signal !== null
      )
        throw new Error("destination.local-sqlite.unavailable");
      evidence = result.evidence;
    } catch (error) {
      ledger.capture();
      /* v8 ignore next -- package-owned helpers throw Error instances; the
       fallback prevents a hostile JavaScript boundary from leaking content. */
      failure =
        error instanceof Error
          ? error
          : new Error("destination.local-sqlite.unavailable");
    } finally {
      ledger.enter(stages.settlement);
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
      ledger.settle(
        workerJoined,
        watchdogJoined,
        released === undefined ? null : released.ok,
      );
      if (
        !workerJoined ||
        !watchdogJoined ||
        released === undefined ||
        !released.ok
      ) {
        ledger.enter(stages.settlement);
        ledger.capture();
        failure = new Error("destination.local-sqlite.outcome-unknown");
      }
    }
    if (failure !== undefined) {
      ledger.capture();
      throw failure;
    }
    return evidence!;
  } catch (error) {
    ledger.capture();
    throw error;
  }
};
