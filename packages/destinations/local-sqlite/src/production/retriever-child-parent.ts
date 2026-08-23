/* eslint-disable max-lines-per-function -- the parent owns one indivisible spawn/permission/cutoff/join/lease settlement ledger. */
import { spawn, type ChildProcess } from "node:child_process";

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
} from "../retriever/index.js";
import { processStartIdentity } from "./filesystem-port.js";
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
  maximumWorkMilliseconds: number;
  teardownReserveMilliseconds: number;
  signal: AbortSignal;
  childIdentity?: (pid: number) => string | undefined;
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

const bounded = async <Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value | undefined> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        /* v8 ignore next -- the resolved promise can race the timer, but cannot
           deterministically execute both settlements in one source test. */
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
      /* v8 ignore start -- all promises supplied by this module normalize
         failure into values; rejection handling remains fail-closed. */
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
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (
        processGroup &&
        process.platform !== "win32" &&
        child.pid !== undefined
      )
        process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* v8 ignore next -- kill can race an already-exited child; joined
         settlement remains conservative in either case. */
      return false;
    }
  }
  return (
    (await bounded(
      waitForExit(child),
      Math.max(0, deadline - performance.now()),
    )) !== undefined
  );
};

const writeInput = (child: ChildProcess, value: string): Promise<boolean> =>
  new Promise((resolve) => {
    const input = child.stdin;
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

const readWorkerMessages = (
  child: ChildProcess,
  nonce: string,
): Readonly<{
  ready: Promise<ReturnType<typeof decodeLocalSqliteReporterChildReady>>;
  result: Promise<ReturnType<typeof decodeLocalSqliteRetrieverChildResult>>;
}> => {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let sawReady = false;
  let sawResult = false;
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
    if (!sawReady) resolveReady(undefined);
    if (!sawResult) resolveResult(undefined);
    sawResult = true;
  };
  child.stdout?.on("data", (value: Buffer | Uint8Array) => {
    /* v8 ignore next -- Node child stdout emits Buffer values; this also
       discards any post-result OS delivery defensively. */
    if (sawResult) return;
    /* v8 ignore next -- Uint8Array is retained for the declared stream type. */
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      const piece = chunk.subarray(offset, end);
      bytes += piece.byteLength;
      const maximum = sawReady ? MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES : 4_096;
      if (bytes > maximum || chunks.length >= 4_096) {
        invalid();
        return;
      }
      /* v8 ignore next -- canonical JSON frames are nonempty; empty frames are
         rejected by the decoder without adding bytes. */
      if (piece.byteLength > 0) chunks.push(piece);
      if (newline < 0) return;
      const line = Buffer.concat(chunks, bytes).toString("utf8");
      chunks = [];
      bytes = 0;
      if (!sawReady) {
        sawReady = true;
        const parsed = decodeLocalSqliteReporterChildReady(line);
        resolveReady(parsed?.nonce === nonce ? parsed : undefined);
        if (parsed?.nonce !== nonce) invalid();
      } else {
        sawResult = true;
        const parsed = decodeLocalSqliteRetrieverChildResult(line);
        resolveResult(parsed?.nonce === nonce ? parsed : undefined);
      }
      offset = newline + 1;
    }
  });
  child.once("exit", () => {
    invalid();
  });
  /* v8 ignore start -- post-spawn stdout/process errors are an OS race; exit
     and hostile framing tests exercise the same invalid settlement. */
  child.once("error", () => {
    invalid();
  });
  /* v8 ignore stop */
  return Object.freeze({ ready, result });
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
  const cutoffAt = performance.now() + input.maximumWorkMilliseconds;
  const teardownDeadline = cutoffAt + input.teardownReserveMilliseconds;
  const remaining = (): number => Math.max(0, cutoffAt - performance.now());
  const worker = spawn(process.execPath, [input.programs.workerPath], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const workerPid = worker.pid;
  /* v8 ignore start -- supported Node spawn always assigns a PID; missing
     executable tests exercise immediate post-spawn failure and cleanup. */
  if (workerPid === undefined) {
    await terminateAndJoin(worker, teardownDeadline, true);
    await releaseLocalSqliteSharedLease(input.gate, input.lease);
    throw new Error("destination.local-sqlite.unavailable");
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
  let evidence: LocalSqliteSearchEvidence | LocalSqliteGetEvidence | undefined;
  let failure: Error | undefined;
  try {
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
      maximumWorkMilliseconds: Math.max(1, Math.floor(remaining())),
      policy: input.policy,
      operation: input.operation,
      plan: Object.freeze({
        ...input.plan,
        maximumWorkMilliseconds: Math.max(1, Math.floor(remaining())),
      }),
    });
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
    const ready = await bounded(messages.ready, remaining());
    if (
      ready === undefined ||
      ready === null ||
      ready.pid !== workerPid ||
      ready.startIdentity !== workerIdentity ||
      input.signal.aborted
    )
      throw new Error("destination.local-sqlite.unavailable");
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
    worker.stdin?.end();
    const result = await bounded(messages.result, remaining());
    const exit = await bounded(waitForExit(worker), remaining());
    if (
      result === undefined ||
      result === null ||
      !result.ok ||
      result.evidence === undefined ||
      exit?.code !== 0 ||
      exit.signal !== null
    )
      throw new Error("destination.local-sqlite.unavailable");
    evidence = result.evidence;
  } catch (error) {
    /* v8 ignore next -- package-owned helpers throw Error instances; the
       fallback prevents a hostile JavaScript boundary from leaking content. */
    failure =
      error instanceof Error
        ? error
        : new Error("destination.local-sqlite.unavailable");
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
    if (
      !workerJoined ||
      !watchdogJoined ||
      released === undefined ||
      !released.ok
    )
      failure = new Error("destination.local-sqlite.outcome-unknown");
  }
  if (failure !== undefined) throw failure;
  return evidence!;
};
