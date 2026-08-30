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
  live: (target: ProcessTarget) => Promise<readonly HeadlessProcessIdentity[]>;
  signal: (
    identity: HeadlessProcessIdentity,
    signal: "SIGTERM" | "SIGKILL",
  ) => Promise<HeadlessObservedSignal | undefined>;
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
const internalErrors = new WeakSet<Error>();
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
const finalJoinMs = 2_000;

const kernelError = (code: string): HeadlessSupervisorError => {
  const error = new HeadlessSupervisorError(code);
  internalErrors.add(error);
  return error;
};

const fail = (code: string): never => {
  throw kernelError(code);
};

const signalAborted = (signal: AbortSignal): boolean => {
  // The captured getter is deliberately invoked with the signal receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  return Reflect.apply(abortSignalAborted.get!, signal, []) as boolean;
};

const addAbortListener = (signal: AbortSignal, listener: () => void): void => {
  Reflect.apply(abortSignalAddEventListener.value as CallableFunction, signal, [
    "abort",
    listener,
    { once: true },
  ]);
};

const removeAbortListener = (
  signal: AbortSignal,
  listener: () => void,
): void => {
  Reflect.apply(
    abortSignalRemoveEventListener.value as CallableFunction,
    signal,
    ["abort", listener],
  );
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });

const remaining = (deadline: number): number =>
  Math.max(0, deadline - performance.now());

const before = async (deadline: number): Promise<void> => {
  const wait = remaining(deadline);
  if (wait > 0) await delay(wait);
};

const bounded = async <T>(
  promise: Promise<T>,
  deadline: number,
  code: string,
): Promise<T> => {
  const wait = remaining(deadline);
  if (wait <= 0) return fail(code);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(kernelError(code));
    }, wait);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : kernelError("testkit.headless.kernel.failure"),
        );
      },
    );
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
    request.monotonicExecutionDeadlineMs + request.terminationGraceMs >
      request.monotonicShutdownDeadlineMs
  )
    fail("testkit.headless.kernel.request");
};

const listProcesses = (): Promise<readonly ProcessSnapshot[]> =>
  new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,lstart="],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
        maxBuffer: 1_048_576,
        timeout: 1_000,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(kernelError("testkit.headless.observer.read"));
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
        resolve(rows);
      },
    );
  });

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
    const snapshot = (await listProcesses()).find(
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
): Readonly<{ promise: Promise<void>; stop: () => void }> => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveObserver!: () => void;
  let rejectObserver!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveObserver = resolve;
    rejectObserver = reject;
  });
  const poll = async (): Promise<void> => {
    try {
      discoverMembers(await listProcesses(), observed);
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
  new Promise((resolve, reject) => {
    child.once("error", () => {
      reject(kernelError("testkit.headless.kernel.spawn"));
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

const eventOf = (child: ChildProcess, event: "spawn"): Promise<void> =>
  new Promise((resolve, reject) => {
    child.once(event, resolve);
    child.once("error", () => {
      reject(kernelError("testkit.headless.kernel.spawn"));
    });
  });

const streamClose = (stream: NodeJS.EventEmitter | null): Promise<void> =>
  stream === null
    ? Promise.resolve()
    : new Promise((resolve) => {
        stream.once("close", resolve);
      });

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
        );
      },
      cleanupUncertainLaunch: async (deadline) => {
        const pid = child.pid;
        if (pid === undefined) return;
        const snapshots = await listProcesses();
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
            await deliverSignal(member, "SIGKILL");
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        while (performance.now() <= deadline) {
          const remainingMembers = await liveMembers(observed);
          const root = (await listProcesses()).find(
            ({ pid: candidate }) => candidate === pid,
          );
          if (root === undefined && remainingMembers.length === 0) return;
          await delay(observerPollMs);
        }
        fail("testkit.headless.cleanup.uncertain-launch");
      },
    };
  },
});

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
  const aborted = new Promise<ExecutionTrigger>((resolve) => {
    abort = () => {
      resolve({ kind: "aborted" });
    };
    if (signal !== undefined && signalAborted(signal)) abort();
    else if (signal !== undefined) addAbortListener(signal, abort);
  });
  return {
    promise: Promise.race([
      close.then((exit) => ({ kind: "closed", exit }) as const),
      output.then((stream) => ({ kind: "output", stream }) as const),
      new Promise<ExecutionTrigger>((resolve) => {
        deadlineTimer = setTimeout(() => {
          resolve({ kind: "timeout" });
        }, remaining(request.monotonicExecutionDeadlineMs));
      }),
      aborted,
    ]),
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
): Promise<ProcessSnapshot | undefined> =>
  findSnapshot(await listProcesses(), identity);

const deliverSignal = async (
  process: ObservedProcess,
  signal: "SIGTERM" | "SIGKILL",
): Promise<HeadlessObservedSignal | undefined> => {
  const snapshot = await currentSnapshot(process.identity);
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
): Promise<readonly ObservedProcess[]> => {
  const snapshots = await listProcesses();
  discoverMembers(snapshots, observed);
  const live: ObservedProcess[] = [];
  for (const member of observed.values())
    if (findSnapshot(snapshots, member.identity) !== undefined)
      live.push(member);
  return live;
};

const componentProcessSet = (
  observed: Map<string, ObservedProcess>,
): AuthenticatedProcessSetSession => {
  const observer = observeUntil(observed);
  return {
    identities: () =>
      [...observed.values()].map(({ identity }) => ({ ...identity })),
    live: async (target) => {
      const live = await liveMembers(observed);
      return live
        .filter(({ identity }) => target === "all" || identity.role === target)
        .map(({ identity }) => ({ ...identity }));
    },
    signal: async (identity, signal) => {
      const member = observed.get(identity.startIdentity);
      if (
        member === undefined ||
        member.identity.pid !== identity.pid ||
        member.identity.role !== identity.role
      )
        return fail("testkit.headless.backend.identity");
      return deliverSignal(member, signal);
    },
    assertTerminal: async (deadline) => {
      while (performance.now() <= deadline) {
        if ((await liveMembers(observed)).length === 0) return;
        await delay(observerPollMs);
      }
      fail("testkit.headless.cleanup.residual");
    },
    stopAndJoin: async (deadline) => {
      observer.stop();
      await bounded(
        observer.promise,
        deadline,
        "testkit.headless.observer.join",
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
  const targets = await processSet.live(target);
  if (targets.length === 0) return;
  for (const member of targets) {
    const observed = await processSet.signal(member, "SIGTERM");
    if (observed !== undefined) signals.push(observed);
  }
  const graceDeadline = performance.now() + request.terminationGraceMs;
  await before(Math.min(graceDeadline, request.monotonicShutdownDeadlineMs));
  const afterGrace = await processSet.live(target);
  for (const member of afterGrace) {
    const observed = await processSet.signal(member, "SIGKILL");
    if (observed !== undefined) signals.push(observed);
  }
};

const waitForJoinedHandles = async (
  handles: readonly Promise<unknown>[],
  deadline: number,
): Promise<void> => {
  try {
    await bounded(
      Promise.all(handles).then(() => undefined),
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
): Promise<never> => {
  const { child } = launch;
  await launch.cleanupUncertainLaunch(performance.now() + finalJoinMs);
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  await bounded(
    Promise.allSettled(handles).then(() => undefined),
    performance.now() + finalJoinMs,
    "testkit.headless.startup.join",
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
  const output = new Promise<"stdout" | "stderr">((resolve) => {
    resolveOutput = resolve;
  });
  const launch = backend.launch(request);
  const { child } = launch;
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    await launch.cleanupUncertainLaunch(performance.now() + finalJoinMs);
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
      spawned,
      request.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    processSet = await bounded(
      launch.openProcessSet(request.monotonicStartupDeadlineMs),
      request.monotonicStartupDeadlineMs,
      "testkit.headless.startup.deadline",
    );
    if (performance.now() > request.monotonicStartupDeadlineMs)
      fail("testkit.headless.startup.deadline");
  } catch (error: unknown) {
    return rejectStartedChild(
      launch,
      handles,
      error instanceof HeadlessSupervisorError
        ? error.code
        : "testkit.headless.kernel.failure",
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
  signals: HeadlessObservedSignal[],
  request: HeadlessExecutionRequest,
): Promise<void> => {
  await cleanupMembers(started.processSet, signals, request, "all");
  await bounded(
    Promise.allSettled(started.handles).then(() => undefined),
    performance.now() + finalJoinMs,
    "testkit.headless.recovery.join",
  );
  await started.processSet.assertTerminal(performance.now() + finalJoinMs);
};

const sanitizedErrorCode = (error: unknown): string =>
  error instanceof HeadlessSupervisorError && internalErrors.has(error)
    ? error.code
    : "testkit.headless.kernel.failure";

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
  try {
    selected = await trigger.promise;
    trigger.release();
    if (selected.kind === "aborted") {
      await cleanupMembers(started.processSet, signals, request, "all");
      exit = await bounded(
        started.closed,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
      await started.processSet.assertTerminal(
        request.monotonicShutdownDeadlineMs,
      );
      fail("testkit.headless.aborted");
    }
    if (selected.kind === "output") {
      await cleanupMembers(started.processSet, signals, request, "root");
      exit = await bounded(
        started.closed,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
      if (signals.some(({ signal }) => signal === "SIGKILL"))
        fail("testkit.headless.output.escalated");
    } else if (selected.kind === "timeout") {
      await cleanupMembers(started.processSet, signals, request, "root");
      exit = await bounded(
        started.closed,
        request.monotonicShutdownDeadlineMs,
        "testkit.headless.shutdown.deadline",
      );
    } else if (selected.kind === "closed") exit = selected.exit;
    else fail("testkit.headless.kernel.trigger");

    if (scenario === "descendant")
      await cleanupMembers(started.processSet, signals, request, "descendant");
    await started.processSet.assertTerminal(
      request.monotonicShutdownDeadlineMs,
    );
  } catch (error: unknown) {
    await recoverExecution(started, signals, request);
    fail(sanitizedErrorCode(error));
  } finally {
    trigger.release();
    await started.processSet.stopAndJoin(performance.now() + finalJoinMs);
  }
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
): string | undefined =>
  error instanceof HeadlessSupervisorError && internalErrors.has(error)
    ? error.code
    : undefined;

export const executeWithHeadlessSupervisorCapability = async (
  capability: HeadlessSupervisorCapability,
  scenario: HeadlessObserverScenario,
  request: HeadlessExecutionRequest,
  signal: AbortSignal | undefined,
): Promise<HeadlessCanonicalTraceEnvelope> => {
  const backend =
    typeof capability === "object" && capability !== null
      ? selectedBackendAuthorities.get(capability)
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
