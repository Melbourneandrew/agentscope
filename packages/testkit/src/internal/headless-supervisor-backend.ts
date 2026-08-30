import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcess } from "node:child_process";

import {
  createBoundedHeadlessSupervisorContractSuite,
  encodeCanonicalHeadlessExecutionTrace,
  type HeadlessCanonicalTraceEnvelope,
  type HeadlessExecutionRequest,
  type HeadlessExecutionResult,
  type HeadlessExecutionTrace,
  type HeadlessObservedSignal,
  type HeadlessObserverScenario,
  type HeadlessProcessIdentity,
  type HeadlessProcessSetObservation,
} from "../headless-supervisor-contract.js";
import {
  HeadlessSupervisorError,
  type HeadlessSupervisorCapability,
} from "../headless-supervisor.js";

type ProcessSnapshot = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  startIdentity: string;
}>;

type ObservedProcess = Readonly<{
  identity: HeadlessProcessIdentity;
  pgid: number;
}>;

type ExitState = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type CapturedStream = Readonly<{
  bytes: Uint8Array;
  truncated: boolean;
}>;

type MutableCapture = {
  chunks: Buffer[];
  length: number;
  truncated: boolean;
};

type ExecutionTrigger =
  | Readonly<{ kind: "closed"; exit: ExitState }>
  | Readonly<{ kind: "output"; stream: "stdout" | "stderr" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "aborted" }>;

type ProcessTarget = "root" | "descendant" | "all";

type AuthenticatedProcessSetSession = Readonly<{
  identities: () => readonly HeadlessProcessIdentity[];
  live: (
    target: ProcessTarget,
    deadline: number,
  ) => Promise<readonly HeadlessProcessIdentity[]>;
  signal: (
    identity: HeadlessProcessIdentity,
    signal: "SIGTERM" | "SIGKILL",
    deadline: number,
  ) => Promise<HeadlessObservedSignal | undefined>;
  forceTerminateAndJoin: (deadline: number) => Promise<void>;
  assertTerminal: (deadline: number) => Promise<void>;
  stopAndJoin: (deadline: number) => Promise<void>;
}>;

type IsolationBackendLaunch = Readonly<{
  child: ChildProcess;
  openProcessSet: (
    startupDeadline: number,
  ) => Promise<AuthenticatedProcessSetSession>;
  cleanupUncertainLaunch: (deadline: number) => Promise<void>;
}>;

type SelectedIsolationBackendAuthority = Readonly<{
  kind: "selected-isolation-backend";
  launch: (request: HeadlessExecutionRequest) => IsolationBackendLaunch;
}>;

type ComponentFixtureBackendAuthority = Readonly<{
  kind: "synthetic-component-fixture";
  launch: (request: HeadlessExecutionRequest) => IsolationBackendLaunch;
}>;

type ExecutionBackendAuthority =
  SelectedIsolationBackendAuthority | ComponentFixtureBackendAuthority;

const selectedBackendAuthorities = new WeakMap<
  object,
  SelectedIsolationBackendAuthority
>();
// Intentionally write-closed in c1k.2. A concrete isolation backend must add
// its restricted in-package mint here in the separately reviewed composition
// work; neither caller data nor the component-fixture backend can populate it.
const internalErrorCodes = new WeakMap<object, string>();
const SafePromise = Promise;
const safeReflectApply = Reflect.apply;
// Capture the authority/provenance operations before any caller code can run.
// Invoking them with their genuine receivers prevents post-import prototype
// poisoning from authenticating a caller object or blessing a caller error.
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapGet = WeakMap.prototype.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapSet = WeakMap.prototype.set;
// eslint-disable-next-line @typescript-eslint/unbound-method
const promiseThen = Promise.prototype.then;
const abortSignalPrototype = AbortSignal.prototype;
const abortSignalAborted = Object.getOwnPropertyDescriptor(
  abortSignalPrototype,
  "aborted",
)!;
const eventTargetPrototype = Object.getPrototypeOf(
  abortSignalPrototype,
) as object;
const abortSignalAddEventListener = Object.getOwnPropertyDescriptor(
  eventTargetPrototype,
  "addEventListener",
)!;
const abortSignalRemoveEventListener = Object.getOwnPropertyDescriptor(
  eventTargetPrototype,
  "removeEventListener",
)!;
const maximumStreamBytes = 1_048_576;
const maximumStdinBytes = 1_048_576;
// Process snapshots are external commands. A 50 ms cadence stays well inside
// the family-owned descendant discovery window without turning aggregate test
// load into hundreds of repeated observer processes.
const observerPollMs = 50;

type Terminal<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ error: unknown; ok: false }>;

const readWeakMap = <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
): V | undefined => safeReflectApply(weakMapGet, map, [key]) as V | undefined;

const writeWeakMap = <K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
): void => {
  safeReflectApply(weakMapSet, map, [key, value]);
};

const kernelError = (code: string): HeadlessSupervisorError => {
  const error = new HeadlessSupervisorError(code);
  writeWeakMap(internalErrorCodes, error, code);
  return error;
};

const fail = (code: string): never => {
  throw kernelError(code);
};

const trustedErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null
    ? readWeakMap(internalErrorCodes, error)
    : undefined;

const terminalOf = <T>(promise: Promise<T>): Promise<Terminal<T>> =>
  safeReflectApply(promiseThen, promise, [
    (value: T) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  ]) as Promise<Terminal<T>>;

const observeAtCreation = <T>(promise: Promise<T>): Promise<T> => {
  void terminalOf(promise);
  return promise;
};

const joinSettled = (promises: readonly Promise<unknown>[]): Promise<void> =>
  observeAtCreation(
    new SafePromise<void>((resolve) => {
      if (promises.length === 0) {
        resolve();
        return;
      }
      let remainingPromises = promises.length;
      for (let index = 0; index < promises.length; index += 1) {
        const terminal = terminalOf(promises[index]!);
        void safeReflectApply(promiseThen, terminal, [
          () => {
            remainingPromises -= 1;
            if (remainingPromises === 0) resolve();
          },
        ]);
      }
    }),
  );

const signalAborted = (signal: AbortSignal): boolean => {
  // The captured getter is deliberately invoked with the signal receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  return safeReflectApply(abortSignalAborted.get!, signal, []) as boolean;
};

const addAbortListener = (signal: AbortSignal, listener: () => void): void => {
  safeReflectApply(
    abortSignalAddEventListener.value as CallableFunction,
    signal,
    ["abort", listener, { once: true }],
  );
};

const removeAbortListener = (
  signal: AbortSignal,
  listener: () => void,
): void => {
  safeReflectApply(
    abortSignalRemoveEventListener.value as CallableFunction,
    signal,
    ["abort", listener],
  );
};

const delay = (milliseconds: number): Promise<void> =>
  new SafePromise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });

const remaining = (deadline: number): number =>
  Math.max(0, deadline - performance.now());

const reconciliationAuthorities = (
  request: HeadlessExecutionRequest,
): Readonly<{
  termDeadline: number;
  killDeadline: number;
  shutdownDeadline: number;
}> => {
  const terminalReserve =
    (request.monotonicShutdownDeadlineMs -
      request.monotonicExecutionDeadlineMs -
      request.terminationGraceMs) /
    2;
  return {
    termDeadline: request.monotonicExecutionDeadlineMs + terminalReserve,
    killDeadline:
      request.monotonicExecutionDeadlineMs +
      terminalReserve +
      request.terminationGraceMs,
    shutdownDeadline: request.monotonicShutdownDeadlineMs,
  };
};

const before = async (deadline: number): Promise<void> => {
  const wait = remaining(deadline);
  if (wait > 0) await delay(wait);
};

const bounded = <T>(
  operation: () => Promise<T>,
  deadline: number,
  code: string,
): Promise<T> => {
  const initialWait = remaining(deadline);
  if (initialWait <= 0) return fail(code);
  let operationPromise: Promise<T>;
  try {
    operationPromise = operation();
  } catch (error: unknown) {
    throw kernelError(
      trustedErrorCode(error) ?? "testkit.headless.kernel.failure",
    );
  }
  // Attach both terminal handlers immediately after an authorized operation
  // is created. An expired authority is rejected above without invoking a new
  // backend callback or constructing a new aggregate operation.
  const observed = terminalOf(operationPromise);
  const wait = remaining(deadline);
  if (wait <= 0) {
    void observed;
    return fail(code);
  }
  return new SafePromise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(kernelError(code));
    }, wait);
    safeReflectApply(promiseThen, observed, [
      (settled: Terminal<T>) => {
        clearTimeout(timer);
        if (settled.ok) {
          resolve(settled.value);
        } else {
          reject(
            kernelError(
              trustedErrorCode(settled.error) ??
                "testkit.headless.kernel.failure",
            ),
          );
        }
      },
    ]);
  });
};

const validateRequest = (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): void => {
  if (
    (scenario !== "correct" &&
      scenario !== "stdout-limit" &&
      scenario !== "stderr-limit" &&
      scenario !== "timeout" &&
      scenario !== "descendant") ||
    typeof request !== "object" ||
    request === null ||
    typeof request.runId !== "string" ||
    typeof request.requestFingerprint !== "string" ||
    typeof request.executable !== "string" ||
    !Array.isArray(request.arguments) ||
    typeof request.cwd !== "string" ||
    typeof request.environment !== "object" ||
    request.environment === null ||
    !(request.stdin instanceof Uint8Array)
  )
    fail("testkit.headless.kernel.request");
  if (
    request.stdin.byteLength > maximumStdinBytes ||
    !Number.isSafeInteger(request.stdoutLimitBytes) ||
    request.stdoutLimitBytes < 1 ||
    request.stdoutLimitBytes > maximumStreamBytes ||
    !Number.isSafeInteger(request.stderrLimitBytes) ||
    request.stderrLimitBytes < 1 ||
    request.stderrLimitBytes > maximumStreamBytes ||
    !Number.isFinite(request.monotonicStartupDeadlineMs) ||
    !Number.isFinite(request.monotonicExecutionDeadlineMs) ||
    !Number.isFinite(request.monotonicShutdownDeadlineMs) ||
    !Number.isFinite(request.terminationGraceMs) ||
    request.terminationGraceMs < 0 ||
    request.monotonicStartupDeadlineMs > request.monotonicExecutionDeadlineMs ||
    request.monotonicExecutionDeadlineMs + request.terminationGraceMs >=
      request.monotonicShutdownDeadlineMs
  )
    fail("testkit.headless.kernel.request");
};

const listProcesses = (
  deadline: number,
): Promise<readonly ProcessSnapshot[]> => {
  const authority = remaining(deadline);
  if (authority <= 0)
    return observeAtCreation(
      new SafePromise((_, reject) => {
        reject(kernelError("testkit.headless.reconciliation.deadline"));
      }),
    );
  return observeAtCreation(
    new SafePromise((resolve, reject) => {
      execFile(
        "/bin/ps",
        ["-axo", "pid=,ppid=,pgid=,lstart="],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
          maxBuffer: 1_048_576,
          timeout: Math.max(1, Math.ceil(Math.min(1_000, authority))),
        },
        (error, stdout) => {
          if (error !== null) {
            reject(
              kernelError(
                performance.now() >= deadline
                  ? "testkit.headless.reconciliation.deadline"
                  : "testkit.headless.observer.read",
              ),
            );
            return;
          }
          const rows: ProcessSnapshot[] = [];
          for (const line of stdout.split("\n")) {
            const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
            if (match === null) continue;
            const pid = Number(match[1]);
            rows.push({
              pid,
              ppid: Number(match[2]),
              pgid: Number(match[3]),
              startIdentity: `${pid}:${match[4]!}`,
            });
          }
          if (performance.now() > deadline)
            reject(kernelError("testkit.headless.reconciliation.deadline"));
          else resolve(rows);
        },
      );
    }),
  );
};

const findSnapshot = (
  snapshots: readonly ProcessSnapshot[],
  identity: HeadlessProcessIdentity,
): ProcessSnapshot | undefined =>
  snapshots.find(
    (candidate) =>
      candidate.pid === identity.pid &&
      candidate.startIdentity === identity.startIdentity,
  );

const observeRoot = async (
  pid: number,
  deadline: number,
): Promise<ObservedProcess> => {
  while (performance.now() <= deadline) {
    const snapshot = (await listProcesses(deadline)).find(
      (candidate) => candidate.pid === pid,
    );
    if (snapshot !== undefined)
      return {
        identity: {
          pid,
          startIdentity: snapshot.startIdentity,
          role: "root",
        },
        pgid: snapshot.pgid,
      };
    await delay(observerPollMs);
  }
  return fail("testkit.headless.observer.root");
};

const discoverMembers = (
  snapshots: readonly ProcessSnapshot[],
  observed: Map<string, ObservedProcess>,
): void => {
  let changed = true;
  while (changed) {
    changed = false;
    for (const snapshot of snapshots) {
      if (observed.has(snapshot.startIdentity)) continue;
      let parentKnown = false;
      for (const member of observed.values())
        if (member.identity.pid === snapshot.ppid) parentKnown = true;
      if (!parentKnown) continue;
      observed.set(snapshot.startIdentity, {
        identity: {
          pid: snapshot.pid,
          startIdentity: snapshot.startIdentity,
          role: "descendant",
        },
        pgid: snapshot.pgid,
      });
      changed = true;
    }
  }
};

const observeUntil = (
  observed: Map<string, ObservedProcess>,
  deadline: number,
): Readonly<{ promise: Promise<void>; stop: () => void }> => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveObserver!: () => void;
  let rejectObserver!: (error: unknown) => void;
  const promise = observeAtCreation(
    new SafePromise<void>((resolve, reject) => {
      resolveObserver = resolve;
      rejectObserver = reject;
    }),
  );
  const poll = async (): Promise<void> => {
    try {
      discoverMembers(await listProcesses(deadline), observed);
      if (stopped) {
        resolveObserver();
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, observerPollMs);
    } catch (error: unknown) {
      rejectObserver(error);
    }
  };
  void poll();
  return {
    promise,
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        resolveObserver();
      }
    },
  };
};

const appendChunk = (
  capture: MutableCapture,
  chunk: Buffer,
  limit: number,
): boolean => {
  const available = Math.max(0, limit - capture.length);
  if (available > 0) {
    const retained = chunk.subarray(0, available);
    capture.chunks.push(Buffer.from(retained));
    capture.length += retained.byteLength;
  }
  if (chunk.byteLength > available) capture.truncated = true;
  return capture.truncated;
};

const finishCapture = (capture: MutableCapture): CapturedStream => ({
  bytes: new Uint8Array(Buffer.concat(capture.chunks, capture.length)),
  truncated: capture.truncated,
});

const closeOf = (child: ChildProcess): Promise<ExitState> =>
  observeAtCreation(
    new SafePromise((resolve, reject) => {
      child.once("error", () => {
        reject(kernelError("testkit.headless.kernel.spawn"));
      });
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    }),
  );

const eventOf = (child: ChildProcess, event: "spawn"): Promise<void> =>
  observeAtCreation(
    new SafePromise((resolve, reject) => {
      child.once(event, resolve);
      child.once("error", () => {
        reject(kernelError("testkit.headless.kernel.spawn"));
      });
    }),
  );

const streamClose = (stream: NodeJS.EventEmitter | null): Promise<void> =>
  stream === null
    ? observeAtCreation(
        new SafePromise((resolve) => {
          resolve();
        }),
      )
    : observeAtCreation(
        new SafePromise((resolve) => {
          stream.once("close", resolve);
        }),
      );

const componentFixtureBackend = (
  scenario: HeadlessObserverScenario,
): ComponentFixtureBackendAuthority => ({
  kind: "synthetic-component-fixture",
  launch: (request) => {
    validateComponentFixtureRequest(scenario, request);
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.cwd,
      detached: true,
      env: { ...request.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      child,
      openProcessSet: async (startupDeadline) => {
        const rootPid = child.pid ?? fail("testkit.headless.kernel.spawn");
        const root = await observeRoot(rootPid, startupDeadline);
        return componentProcessSet(
          new Map<string, ObservedProcess>([
            [root.identity.startIdentity, root],
          ]),
          request.monotonicShutdownDeadlineMs,
        );
      },
      cleanupUncertainLaunch: async (deadline) => {
        const reconciliationDeadline = Math.min(
          deadline,
          request.monotonicShutdownDeadlineMs,
        );
        const pid = child.pid;
        if (pid === undefined) return;
        const snapshots = await listProcesses(reconciliationDeadline);
        const rootSnapshot = snapshots.find(
          ({ pid: candidate }) => candidate === pid,
        );
        const observed = new Map<string, ObservedProcess>();
        if (rootSnapshot !== undefined) {
          observed.set(rootSnapshot.startIdentity, {
            identity: {
              pid,
              role: "root",
              startIdentity: rootSnapshot.startIdentity,
            },
            pgid: rootSnapshot.pgid,
          });
          discoverMembers(snapshots, observed);
          for (const member of observed.values())
            await deliverSignal(member, "SIGKILL", reconciliationDeadline);
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        while (performance.now() <= reconciliationDeadline) {
          const remainingMembers = await liveMembers(
            observed,
            reconciliationDeadline,
          );
          const root = (await listProcesses(reconciliationDeadline)).find(
            ({ pid: candidate }) => candidate === pid,
          );
          if (root === undefined && remainingMembers.length === 0) return;
          await delay(observerPollMs);
        }
        fail("testkit.headless.reconciliation.deadline");
      },
    };
  },
});

type ComponentDeadlineSeed = "live-never" | "signal-never";

let syntheticPostExpiryCallbackCount = 0;

const componentDeadlineSeedBackend = (
  scenario: HeadlessObserverScenario,
  seed: ComponentDeadlineSeed,
): ComponentFixtureBackendAuthority => {
  const component = componentFixtureBackend(scenario);
  return {
    kind: "synthetic-component-fixture",
    launch: (request) => {
      const launch = component.launch(request);
      return {
        ...launch,
        openProcessSet: async (startupDeadline) => {
          const processSet = await launch.openProcessSet(startupDeadline);
          const afterExpiry = (): void => {
            if (performance.now() >= request.monotonicShutdownDeadlineMs)
              syntheticPostExpiryCallbackCount += 1;
          };
          return {
            ...processSet,
            live:
              seed === "live-never"
                ? () => {
                    afterExpiry();
                    return observeAtCreation(
                      new SafePromise<never>(() => undefined),
                    );
                  }
                : (target, deadline) => {
                    afterExpiry();
                    return processSet.live(target, deadline);
                  },
            signal:
              seed === "signal-never"
                ? () => {
                    afterExpiry();
                    return observeAtCreation(
                      new SafePromise<never>(() => undefined),
                    );
                  }
                : (identity, signal, deadline) => {
                    afterExpiry();
                    return processSet.signal(identity, signal, deadline);
                  },
            forceTerminateAndJoin: (deadline) => {
              afterExpiry();
              return processSet.forceTerminateAndJoin(deadline);
            },
            assertTerminal: (deadline) => {
              afterExpiry();
              return processSet.assertTerminal(deadline);
            },
            stopAndJoin: (deadline) => {
              afterExpiry();
              return processSet.stopAndJoin(deadline);
            },
          };
        },
      };
    },
  };
};

const triggerOf = (
  close: Promise<ExitState>,
  output: Promise<"stdout" | "stderr">,
  request: HeadlessExecutionRequest,
  signal: AbortSignal | undefined,
): Readonly<{
  promise: Promise<ExecutionTrigger>;
  release: () => void;
}> => {
  let abort: (() => void) | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const aborted = observeAtCreation(
    new SafePromise<ExecutionTrigger>((resolve) => {
      abort = () => {
        resolve({ kind: "aborted" });
      };
      if (signal !== undefined && signalAborted(signal)) abort();
      else if (signal !== undefined) addAbortListener(signal, abort);
    }),
  );
  const closed = terminalOf(close);
  const outputObserved = terminalOf(output);
  const timeout = observeAtCreation(
    new SafePromise<ExecutionTrigger>((resolve) => {
      deadlineTimer = setTimeout(() => {
        resolve({ kind: "timeout" });
      }, remaining(request.monotonicExecutionDeadlineMs));
    }),
  );
  const trigger = observeAtCreation(
    new SafePromise<ExecutionTrigger>((resolve, reject) => {
      const settleClosed = (settled: Terminal<ExitState>): void => {
        if (settled.ok) resolve({ kind: "closed", exit: settled.value });
        else reject(kernelError("testkit.headless.kernel.spawn"));
      };
      const settleOutput = (settled: Terminal<"stdout" | "stderr">): void => {
        if (settled.ok) resolve({ kind: "output", stream: settled.value });
        else reject(kernelError("testkit.headless.kernel.failure"));
      };
      safeReflectApply(promiseThen, closed, [settleClosed]);
      safeReflectApply(promiseThen, outputObserved, [settleOutput]);
      safeReflectApply(promiseThen, timeout, [resolve]);
      safeReflectApply(promiseThen, aborted, [resolve]);
    }),
  );
  return {
    promise: trigger,
    release: () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (abort !== undefined && signal !== undefined)
        try {
          removeAbortListener(signal, abort);
        } catch {
          // Listener disposal must never bypass process and observer joins.
        }
    },
  };
};

const currentSnapshot = async (
  identity: HeadlessProcessIdentity,
  deadline: number,
): Promise<ProcessSnapshot | undefined> =>
  findSnapshot(await listProcesses(deadline), identity);

const deliverSignal = async (
  process: ObservedProcess,
  signal: "SIGTERM" | "SIGKILL",
  deadline: number,
): Promise<HeadlessObservedSignal | undefined> => {
  const snapshot = await currentSnapshot(process.identity, deadline);
  if (snapshot === undefined) return undefined;
  try {
    if (
      process.identity.role === "root" &&
      snapshot.pgid === process.identity.pid
    )
      globalThis.process.kill(-snapshot.pgid, signal);
    else globalThis.process.kill(process.identity.pid, signal);
  } catch {
    return undefined;
  }
  return {
    signal,
    targetStartIdentity: process.identity.startIdentity,
    monotonicAtMs: performance.now(),
  };
};

const liveMembers = async (
  observed: Map<string, ObservedProcess>,
  deadline: number,
): Promise<readonly ObservedProcess[]> => {
  const snapshots = await listProcesses(deadline);
  discoverMembers(snapshots, observed);
  const live: ObservedProcess[] = [];
  for (const member of observed.values())
    if (findSnapshot(snapshots, member.identity) !== undefined)
      live.push(member);
  return live;
};

const componentProcessSet = (
  observed: Map<string, ObservedProcess>,
  reconciliationDeadline: number,
): AuthenticatedProcessSetSession => {
  const observer = observeUntil(observed, reconciliationDeadline);
  const boundedDeadline = (deadline: number): number =>
    Math.min(deadline, reconciliationDeadline);
  const assertNoMembers = async (deadline: number): Promise<void> => {
    const authority = boundedDeadline(deadline);
    while (performance.now() <= authority) {
      if ((await liveMembers(observed, authority)).length === 0) return;
      await delay(observerPollMs);
    }
    fail("testkit.headless.cleanup.residual");
  };
  return {
    identities: () =>
      [...observed.values()].map(({ identity }) => ({ ...identity })),
    live: async (target, deadline) => {
      const live = await liveMembers(observed, boundedDeadline(deadline));
      return live
        .filter(({ identity }) => target === "all" || identity.role === target)
        .map(({ identity }) => ({ ...identity }));
    },
    signal: async (identity, signal, deadline) => {
      const member = observed.get(identity.startIdentity);
      if (
        member === undefined ||
        member.identity.pid !== identity.pid ||
        member.identity.role !== identity.role
      )
        return fail("testkit.headless.backend.identity");
      return deliverSignal(member, signal, boundedDeadline(deadline));
    },
    forceTerminateAndJoin: async (deadline) => {
      const authority = boundedDeadline(deadline);
      const live = await liveMembers(observed, authority);
      for (const member of live) {
        await deliverSignal(member, "SIGKILL", authority);
      }
      await assertNoMembers(authority);
    },
    assertTerminal: assertNoMembers,
    stopAndJoin: async (deadline) => {
      observer.stop();
      await bounded(
        () => observer.promise,
        boundedDeadline(deadline),
        "testkit.headless.reconciliation.deadline",
      );
    },
  };
};

const componentScenarioCase = (scenario: HeadlessObserverScenario) => {
  const expectedName =
    scenario === "correct"
      ? "headless:correct-invocation"
      : scenario === "stdout-limit"
        ? "headless:stdout-limit"
        : scenario === "stderr-limit"
          ? "headless:stderr-limit"
          : scenario === "timeout"
            ? "headless:timeout-escalation"
            : "headless:descendant-cleanup";
  return createBoundedHeadlessSupervisorContractSuite().find(
    ({ name }) => name === expectedName,
  )!;
};

const validateComponentFixtureRequest = (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): void => {
  const definition = componentScenarioCase(scenario);
  const expectedArguments =
    scenario === "correct"
      ? ["argument one", "--literal=$VALUE"]
      : ([] as const);
  if (
    request.executable !== process.execPath ||
    request.arguments.length !== expectedArguments.length + 1 ||
    request.cwd !== dirname(request.arguments[0] ?? "") ||
    request.environment.AGENTSCOPE_ORACLE_VISIBLE !== "visible-canary" ||
    Object.keys(request.environment).length !== 1 ||
    Buffer.from(request.stdin).toString("utf8") !== "oracle-stdin" ||
    readFileSync(request.arguments[0]!, "utf8") !== definition.fixtureSource
  )
    fail("testkit.headless.component.fixture");
  for (let index = 0; index < expectedArguments.length; index += 1)
    if (request.arguments[index + 1] !== expectedArguments[index])
      fail("testkit.headless.component.fixture");
};

const cleanupMembers = async (
  processSet: AuthenticatedProcessSetSession,
  signals: HeadlessObservedSignal[],
  request: HeadlessExecutionRequest,
  target: ProcessTarget,
): Promise<void> => {
  const { termDeadline, killDeadline } = reconciliationAuthorities(request);
  const targets = await bounded(
    () => processSet.live(target, termDeadline),
    termDeadline,
    "testkit.headless.reconciliation.deadline",
  );
  if (targets.length === 0) return;
  for (const member of targets) {
    const observed = await bounded(
      () => processSet.signal(member, "SIGTERM", termDeadline),
      termDeadline,
      "testkit.headless.reconciliation.deadline",
    );
    if (observed !== undefined) signals.push(observed);
  }
  const graceDeadline = performance.now() + request.terminationGraceMs;
  await before(Math.min(graceDeadline, killDeadline));
  const afterGrace = await bounded(
    () => processSet.live(target, killDeadline),
    killDeadline,
    "testkit.headless.reconciliation.deadline",
  );
  for (const member of afterGrace) {
    const observed = await bounded(
      () => processSet.signal(member, "SIGKILL", killDeadline),
      killDeadline,
      "testkit.headless.reconciliation.deadline",
    );
    if (observed !== undefined) signals.push(observed);
  }
};

const waitForJoinedHandles = async (
  handles: readonly Promise<unknown>[],
  deadline: number,
): Promise<void> => {
  try {
    await bounded(
      () => joinSettled(handles),
      deadline,
      "testkit.headless.handles.deadline",
    );
  } catch {
    fail("testkit.headless.handles.deadline");
  }
};

type ResultInput = Readonly<{
  scenario: HeadlessObserverScenario;
  trigger: ExecutionTrigger;
  exit: ExitState;
  stdout: CapturedStream;
  stderr: CapturedStream;
  signals: readonly HeadlessObservedSignal[];
}>;

const resultFor = ({
  scenario,
  trigger,
  exit,
  stdout,
  stderr,
  signals,
}: ResultInput): HeadlessExecutionResult => {
  const termRequested = signals.some(({ signal }) => signal === "SIGTERM");
  const killRequested = signals.some(({ signal }) => signal === "SIGKILL");
  if (scenario === "correct")
    return {
      resultVersion: 1,
      outcome: "exited",
      exitCode: exit.code,
      signal: exit.signal as "SIGTERM" | "SIGKILL" | null,
      stdout: stdout.bytes,
      stderr: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      termRequested,
      killRequested,
      cleanup: "clean",
      residualProcessCount: 0,
      diagnosticCode: null,
    };
  if (scenario === "stdout-limit" || scenario === "stderr-limit")
    return {
      resultVersion: 1,
      outcome: "output-limit",
      exitCode: null,
      signal: "SIGTERM",
      stdout: stdout.bytes,
      stderr: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      termRequested,
      killRequested,
      cleanup: "clean",
      residualProcessCount: 0,
      diagnosticCode: "testkit.headless.output-limit",
    };
  if (scenario === "timeout")
    return {
      resultVersion: 1,
      outcome: "timed-out",
      exitCode: null,
      signal: "SIGKILL",
      stdout: stdout.bytes,
      stderr: stderr.bytes,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      termRequested,
      killRequested,
      cleanup: "clean",
      residualProcessCount: 0,
      diagnosticCode: "testkit.headless.timeout",
    };
  if (trigger.kind !== "closed" || exit.code !== 0)
    fail("testkit.headless.descendant.root");
  return {
    resultVersion: 1,
    outcome: "exited",
    exitCode: 0,
    signal: null,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    termRequested,
    killRequested,
    cleanup: "clean",
    residualProcessCount: 0,
    diagnosticCode: null,
  };
};

type StartedExecution = Readonly<{
  child: ChildProcess;
  closed: Promise<ExitState>;
  handles: readonly Promise<unknown>[];
  output: Promise<"stdout" | "stderr">;
  processSet: AuthenticatedProcessSetSession;
  readyAtMs: number;
  spawnedAtMs: number;
  stderrCapture: MutableCapture;
  stdoutCapture: MutableCapture;
}>;

const rejectStartedChild = async (
  launch: IsolationBackendLaunch,
  handles: readonly Promise<unknown>[],
  code: string,
  reconciliationDeadline: number,
): Promise<never> => {
  const { child } = launch;
  await bounded(
    () => launch.cleanupUncertainLaunch(reconciliationDeadline),
    reconciliationDeadline,
    "testkit.headless.reconciliation.deadline",
  );
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  await bounded(
    () => joinSettled(handles),
    reconciliationDeadline,
    "testkit.headless.reconciliation.deadline",
  );
  return fail(code);
};

const startExecution = async (
  backend: ExecutionBackendAuthority,
  request: HeadlessExecutionRequest,
): Promise<StartedExecution> => {
  const stdoutCapture: MutableCapture = {
    chunks: [],
    length: 0,
    truncated: false,
  };
  const stderrCapture: MutableCapture = {
    chunks: [],
    length: 0,
    truncated: false,
  };
  let resolveOutput!: (stream: "stdout" | "stderr") => void;
  const output = observeAtCreation(
    new SafePromise<"stdout" | "stderr">((resolve) => {
      resolveOutput = resolve;
    }),
  );
  const launch = backend.launch(request);
  const { child } = launch;
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    await bounded(
      () => launch.cleanupUncertainLaunch(request.monotonicShutdownDeadlineMs),
      request.monotonicShutdownDeadlineMs,
      "testkit.headless.reconciliation.deadline",
    );
    return fail("testkit.headless.backend.launch");
  }
  const spawnedAtMs = performance.now();
  const closed = closeOf(child);
  const spawned = eventOf(child, "spawn");
  const handles = [
    closed,
    streamClose(child.stdin),
    streamClose(child.stdout),
    streamClose(child.stderr),
  ];
  child.stdout.on("data", (chunk: Buffer) => {
    if (appendChunk(stdoutCapture, chunk, request.stdoutLimitBytes))
      resolveOutput("stdout");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (appendChunk(stderrCapture, chunk, request.stderrLimitBytes))
      resolveOutput("stderr");
  });
  child.stdin.end(Buffer.from(request.stdin));
  let processSet: AuthenticatedProcessSetSession;
  try {
    await bounded(
      () => spawned,
      request.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    processSet = await bounded(
      () => launch.openProcessSet(request.monotonicStartupDeadlineMs),
      request.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    if (performance.now() > request.monotonicStartupDeadlineMs)
      fail("testkit.headless.startup.deadline");
  } catch (error: unknown) {
    return rejectStartedChild(
      launch,
      handles,
      sanitizedErrorCode(error),
      request.monotonicShutdownDeadlineMs,
    );
  }
  return {
    child,
    closed,
    handles,
    processSet,
    output,
    readyAtMs: performance.now(),
    spawnedAtMs,
    stderrCapture,
    stdoutCapture,
  };
};

type EncodeExecutionInput = Readonly<{
  scenario: HeadlessObserverScenario;
  request: HeadlessExecutionRequest;
  started: StartedExecution;
  trigger: ExecutionTrigger;
  exit: ExitState;
  signals: readonly HeadlessObservedSignal[];
}>;

const encodeExecution = ({
  scenario,
  request,
  started,
  trigger,
  exit,
  signals,
}: EncodeExecutionInput): HeadlessCanonicalTraceEnvelope => {
  const settledAtMs = performance.now();
  const result = resultFor({
    scenario,
    trigger,
    exit,
    stdout: finishCapture(started.stdoutCapture),
    stderr: finishCapture(started.stderrCapture),
    signals,
  });
  const processes = started.processSet.identities();
  const observation: HeadlessProcessSetObservation = {
    observationVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    processes,
    signals,
    spawnedAtMs: started.spawnedAtMs,
    readyAtMs: started.readyAtMs,
    settledAtMs,
    processJoined: true,
    stdinJoined: true,
    stdoutJoined: true,
    stderrJoined: true,
    cleanup: "clean",
    residualStartIdentities: [],
  };
  const trace: HeadlessExecutionTrace = {
    traceVersion: 1,
    runId: request.runId,
    requestFingerprint: request.requestFingerprint,
    returnedAtMs: performance.now(),
    result,
    observation,
  };
  return encodeCanonicalHeadlessExecutionTrace(trace, scenario, request);
};

const recoverExecution = async (
  started: StartedExecution,
  request: HeadlessExecutionRequest,
): Promise<void> => {
  const deadline = request.monotonicShutdownDeadlineMs;
  let failed = false;
  try {
    await bounded(
      () => started.processSet.forceTerminateAndJoin(deadline),
      deadline,
      "testkit.headless.reconciliation.deadline",
    );
  } catch {
    failed = true;
  }
  try {
    await bounded(
      () => joinSettled(started.handles),
      deadline,
      "testkit.headless.reconciliation.deadline",
    );
  } catch {
    failed = true;
  }
  try {
    await bounded(
      () => started.processSet.assertTerminal(deadline),
      deadline,
      "testkit.headless.reconciliation.deadline",
    );
  } catch {
    failed = true;
  }
  if (failed) fail("testkit.headless.reconciliation.deadline");
};

const sanitizedErrorCode = (error: unknown): string =>
  trustedErrorCode(error) ?? "testkit.headless.kernel.failure";

const execute = async (
  backend: ExecutionBackendAuthority,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  abortSignal: AbortSignal | undefined,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  validateRequest(scenario, request);
  if (process.platform === "win32") fail("testkit.headless.kernel.platform");
  if (abortSignal !== undefined && signalAborted(abortSignal))
    fail("testkit.headless.aborted");
  if (performance.now() >= request.monotonicStartupDeadlineMs)
    fail("testkit.headless.startup.deadline");

  const started = await startExecution(backend, request);
  const signals: HeadlessObservedSignal[] = [];
  const trigger = triggerOf(
    started.closed,
    started.output,
    request,
    abortSignal,
  );
  let selected: ExecutionTrigger | undefined;
  let exit: ExitState | undefined;
  let lifecycleError: unknown;
  try {
    selected = await trigger.promise;
    trigger.release();
    if (selected.kind === "aborted") {
      await cleanupMembers(started.processSet, signals, request, "all");
      exit = await bounded(
        () => started.closed,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
      await bounded(
        () =>
          started.processSet.assertTerminal(
            request.monotonicShutdownDeadlineMs,
          ),
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.reconciliation.deadline",
      );
      fail("testkit.headless.aborted");
    }
    if (selected.kind === "output") {
      await cleanupMembers(started.processSet, signals, request, "root");
      exit = await bounded(
        () => started.closed,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
      if (signals.some(({ signal }) => signal === "SIGKILL"))
        fail("testkit.headless.output.escalated");
    } else if (selected.kind === "timeout") {
      await cleanupMembers(started.processSet, signals, request, "root");
      exit = await bounded(
        () => started.closed,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
    } else if (selected.kind === "closed") exit = selected.exit;
    else fail("testkit.headless.kernel.trigger");

    if (scenario === "descendant")
      await cleanupMembers(started.processSet, signals, request, "descendant");
    await bounded(
      () =>
        started.processSet.assertTerminal(request.monotonicShutdownDeadlineMs),
      request.monotonicShutdownDeadlineMs,
      "testkit.headless.reconciliation.deadline",
    );
  } catch (error: unknown) {
    lifecycleError = error;
    try {
      await recoverExecution(started, request);
    } catch (recoveryError: unknown) {
      lifecycleError = recoveryError;
    }
  } finally {
    trigger.release();
    try {
      await bounded(
        () =>
          started.processSet.stopAndJoin(request.monotonicShutdownDeadlineMs),
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.reconciliation.deadline",
      );
    } catch (joinError: unknown) {
      lifecycleError = joinError;
    }
  }
  if (lifecycleError !== undefined) fail(sanitizedErrorCode(lifecycleError));
  await waitForJoinedHandles(
    started.handles,
    request.monotonicShutdownDeadlineMs,
  );
  const settledTrigger = selected ?? fail("testkit.headless.kernel.settlement");
  const settledExit = exit ?? fail("testkit.headless.kernel.settlement");
  return encodeExecution({
    scenario,
    request,
    started,
    trigger: settledTrigger,
    exit: settledExit,
    signals,
  });
};

export const readHeadlessSupervisorKernelErrorCode = (
  error: unknown,
): string | undefined => trustedErrorCode(error);

export const executeWithHeadlessSupervisorCapability = async (
  capability: HeadlessSupervisorCapability,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  signal: AbortSignal | undefined,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  const backend =
    typeof capability === "object" && capability !== null
      ? readWeakMap(selectedBackendAuthorities, capability)
      : undefined;
  if (backend === undefined) return fail("testkit.headless.capability");
  try {
    return await execute(backend, scenario, request, signal);
  } catch (error: unknown) {
    return fail(sanitizedErrorCode(error));
  }
};

/**
 * Package-private component evidence for the five closed family fixtures.
 * This local backend is not a selected native/container isolation authority,
 * cannot mint a production capability, and makes no containment claim.
 */
export const executeSyntheticComponentFixtureHeadlessSupervisor = async (
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  signal?: AbortSignal,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  try {
    return await execute(
      componentFixtureBackend(scenario),
      scenario,
      request,
      signal,
    );
  } catch (error: unknown) {
    return fail(sanitizedErrorCode(error));
  }
};

/** Package-private causal seed; never production or acceptance evidence. */
export const executeSyntheticBackendDeadlineSeedForTest = async (
  seed: ComponentDeadlineSeed,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  syntheticPostExpiryCallbackCount = 0;
  try {
    return await execute(
      componentDeadlineSeedBackend(scenario, seed),
      scenario,
      request,
      undefined,
    );
  } catch (error: unknown) {
    return fail(sanitizedErrorCode(error));
  }
};

/** Package-private causal counter; never production or acceptance evidence. */
export const readSyntheticPostExpiryCallbackCountForTest = (): number =>
  syntheticPostExpiryCallbackCount;
