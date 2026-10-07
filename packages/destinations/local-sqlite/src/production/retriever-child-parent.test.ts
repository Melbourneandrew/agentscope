import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";

import {
  createDestinationConnectionId,
  createDestinationTypeId,
} from "@agentscope/destinations-core";
import {
  createTraceSearchRequest,
  normalizeTraceSearchQuery,
} from "@agentscope/destinations-core/testing";
import { describe, expect, it } from "vitest";

import { acquireLocalSqliteSharedLease } from "../lifecycle/fence.js";
import { compileLocalSqliteSearchPlan } from "../retriever/index.js";
import { createLocalSqliteFilesystemGatePort } from "./filesystem-port.js";
import { MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES } from "./retriever-child-protocol.js";
import {
  executeLocalSqliteRetrieverChild,
  readWorkerMessages,
} from "./retriever-child-parent.js";
import {
  createLocalSqliteFailureLedger,
  retrievalFailureStages,
} from "./retrieval-diagnostics.js";

describe("reported child settlement observations", () => {
  it("retains the actual parent first worker-negative boundary when release fails", async () => {
    const result = await run("false-result", { failRelease: true });
    expect(result.settled).toMatchObject({
      state: "rejected",
      message: "destination.local-sqlite.outcome-unknown",
      observation: {
        stage: 11,
        cutoffExpired: false,
        workerJoined: true,
        watchdogJoined: true,
        leaseReleased: false,
      },
    });
  });
  it("does not replace a captured worker-negative stage with a later teardown stage", () => {
    const ledger = createLocalSqliteFailureLedger(-1);
    ledger.enter(retrievalFailureStages.workerNegative);
    ledger.capture();
    ledger.enter(retrievalFailureStages.settlement);
    ledger.settle(true, true, false);
    expect(ledger.snapshot()).toEqual({
      stage: 11,
      cutoffExpired: true,
      workerJoined: true,
      watchdogJoined: true,
      leaseReleased: false,
    });
  });
});

const fingerprint = `sha256-${"a".repeat(64)}`;
const childIdentity = "5".repeat(32);
const connectionId = createDestinationConnectionId(
  `destination-connection-v1-${"a".repeat(64)}`,
);
const destinationType = createDestinationTypeId(
  "@agentscope/destination-local-sqlite",
);
const plan = compileLocalSqliteSearchPlan(
  createTraceSearchRequest(
    normalizeTraceSearchQuery(
      { limit: 1 },
      {
        commandStartedAt: "2099-01-01T00:00:00.000Z",
        knownHarnessIds: ["codex"],
        ordering: "start-time-desc-trace-id-asc",
      },
    ),
    { connectionId, destinationType },
  ),
  { maximumResponseBytes: 1_000, maximumWorkMilliseconds: 1_000 },
)!;

type WorkerState =
  | "accepted"
  | "accepted-descendant"
  | "stdout-forgery"
  | "duplicate-result"
  | "wrong-type-result"
  | "before"
  | "malformed"
  | "oversized"
  | "split-ready"
  | "wrong-start"
  | "close-after-ready"
  | "false-result"
  | "missing-evidence"
  | "wrong-result"
  | "result-error"
  | "hang";

type WatchdogState = "accepted" | "wrong-message" | "exit-before-watch";

const watchdogProgram = (stubborn: boolean, state: WatchdogState): string => `
let worker;
process.on("message", (value) => {
  if (value?.type === "watch") {
    worker = value.workerPid;
    ${state === "exit-before-watch" ? "process.exit(0);" : state === "wrong-message" ? 'process.send({type:"wrong"});' : 'process.send({type:"watching"});'}
  } else if (value?.type === "complete") {
    ${stubborn ? "setInterval(()=>{},1000);" : "process.disconnect();"}
  }
});
process.on("disconnect", () => process.exit(0));
`;

const successResult = (nonce: string): string =>
  `JSON.stringify({type:"retrieval-result",nonce:${nonce},ok:true,evidence:{rows:[],responseByteLimitReached:false,retentionCutoffSortKey:"00000000000000000000",snapshotToken:"3".repeat(64)}})+"\\n"`;

const workerProgram = (
  state: WorkerState,
  descendantPath: string,
  heartbeatPath: string,
): string => {
  const heartbeatProgram = `const {appendFileSync}=require("node:fs");setInterval(()=>appendFileSync(${JSON.stringify(heartbeatPath)},"x"),5);`;
  const forgeryProgram = `const {appendFileSync}=require("node:fs");setTimeout(()=>{process.stdout.write(${successResult('"' + "2".repeat(32) + '"')});setInterval(()=>appendFileSync(${JSON.stringify(heartbeatPath)},"x"),5);},100);`;
  return `
const {spawn} = require("node:child_process");
const {writeFileSync,createWriteStream} = require("node:fs");
const sendResult = (value, after) => {
  const channel = createWriteStream("", {fd:3});
  channel.on("close", () => { after?.(); });
  channel.end(value);
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("end",()=>process.exit(${state === "result-error" ? 1 : 0}));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const value = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (value.type === "retrieve") {
      ${state === "before" ? "return;" : state === "malformed" ? 'process.stdout.write("{}\\n"); process.exit(0);' : state === "oversized" ? 'process.stdout.write("x".repeat(4097)); process.exit(0);' : state === "split-ready" ? `const ready=JSON.stringify({type:"ready",nonce:value.nonce,pid:process.pid,startIdentity:"${childIdentity}"}); process.stdout.write(ready.slice(0,5)); setTimeout(()=>process.stdout.write(ready.slice(5)+"\\n"),5);` : `process.stdout.write(JSON.stringify({type:"ready",nonce:value.nonce,pid:process.pid,startIdentity:"${state === "wrong-start" ? "6".repeat(32) : childIdentity}"})+"\\n");`}
      ${state === "close-after-ready" ? "process.stdin.destroy(); setInterval(()=>{},1000);" : ""}
    } else if (value.type === "permission") {
      ${state === "hang" ? "setInterval(()=>{},1000);" : state === "accepted-descendant" ? `const child=spawn(process.execPath,["-e",${JSON.stringify(heartbeatProgram)}],{stdio:"ignore"}); writeFileSync(${JSON.stringify(descendantPath)},String(child.pid)); sendResult(${successResult("value.nonce")});` : state === "stdout-forgery" ? `const child=spawn(process.execPath,["-e",${JSON.stringify(forgeryProgram)}],{stdio:"inherit"}); writeFileSync(${JSON.stringify(descendantPath)},String(child.pid)); process.exit(0);` : state === "duplicate-result" ? `sendResult(${successResult("value.nonce")}+${successResult("value.nonce")});` : state === "wrong-type-result" ? 'sendResult(JSON.stringify({type:"wrong",nonce:value.nonce})+"\\n");' : state === "false-result" ? 'sendResult(JSON.stringify({type:"retrieval-result",nonce:value.nonce,ok:false})+"\\n");' : state === "missing-evidence" ? 'sendResult(JSON.stringify({type:"retrieval-result",nonce:value.nonce,ok:true})+"\\n");' : state === "wrong-result" ? `sendResult(${successResult('"0".repeat(32)')});` : state === "result-error" ? `sendResult(${successResult("value.nonce")},()=>process.exit(1));` : `sendResult(${successResult("value.nonce")});`}
    }
  }
});
`;
};

type AttemptOptions = Readonly<{
  abortAfterMilliseconds?: number;
  failAmend?: boolean;
  failRelease?: boolean;
  throwAmend?: boolean;
  identityMissing?: boolean;
  missingWorker?: boolean;
  missingWatchdog?: boolean;
  omitChildIdentity?: boolean;
  stubbornWatchdog?: boolean;
  watchdogState?: WatchdogState;
  maximumWorkMilliseconds?: number;
}>;

const readHeartbeat = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const proveDescendantStopped = async (path: string): Promise<boolean> => {
  const before = readHeartbeat(path);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return readHeartbeat(path) === before;
};

// eslint-disable-next-line max-lines-per-function -- one process-boundary fixture owns spawn, IPC, deadline, teardown, and exact cleanup evidence.
const run = async (state: WorkerState, options: AttemptOptions = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agentscope-retriever-child-"));
  chmodSync(root, 0o700);
  try {
    const lifecycle = join(root, "lifecycle");
    const workerPath = join(root, "worker.cjs");
    const watchdogPath = join(root, "watchdog.cjs");
    const descendantPath = join(root, "descendant.pid");
    const heartbeatPath = join(root, "descendant.heartbeat");
    mkdirSync(lifecycle, { mode: 0o700 });
    if (options.missingWorker !== true)
      writeFileSync(
        workerPath,
        workerProgram(state, descendantPath, heartbeatPath),
        {
          mode: 0o600,
        },
      );
    if (options.missingWatchdog !== true)
      writeFileSync(
        watchdogPath,
        watchdogProgram(
          options.stubbornWatchdog === true,
          options.watchdogState ?? "accepted",
        ),
        { mode: 0o600 },
      );
    const filesystemGate = createLocalSqliteFilesystemGatePort(lifecycle, {
      allowPathFallbackForTesting: true,
    });
    const lease = await acquireLocalSqliteSharedLease(filesystemGate, {
      leaseId: "1".repeat(32),
      lifecycleFingerprint: fingerprint,
      lifecycleGeneration: 1,
      parent: { pid: process.pid, startIdentity: "4".repeat(32) },
    });
    if (!lease.ok) throw new Error("lease fixture");
    const gate = Object.freeze({
      ...filesystemGate,
      ...(options.failAmend === true
        ? {
            replaceLeaseDurably: () =>
              Object.freeze({ state: "mismatch" as const }),
          }
        : {}),
      ...(options.failRelease === true
        ? {
            removeArtifactIfIdentity: () =>
              Object.freeze({ state: "mismatch" as const }),
          }
        : {}),
      ...(options.throwAmend === true
        ? {
            replaceLeaseDurably: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- hostile port boundary proves non-Error normalization.
              throw "synthetic hostile value";
            },
          }
        : {}),
    });
    const controller = new AbortController();
    const abortTimer =
      options.abortAfterMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, options.abortAfterMilliseconds);
    const startedAt = performance.now();
    const cutoffAt =
      performance.now() +
      (options.maximumWorkMilliseconds ?? (state === "hang" ? 50 : 1_000));
    const ledger = createLocalSqliteFailureLedger(cutoffAt);
    try {
      const settled = await executeLocalSqliteRetrieverChild({
        programs: { workerPath, watchdogPath },
        gate,
        lease: lease.value,
        nonce: "2".repeat(32),
        databasePath: join(root, "traces.sqlite"),
        databaseFamily: Object.freeze([
          Object.freeze({
            name: "traces.sqlite",
            physicalIdentity: "dev:1:ino:2",
          }),
        ]),
        policy: {
          maximumAgeNanoseconds: "1",
          maximumPayloadBytes: 1,
          maximumTraceCount: 1,
        },
        operation: "search",
        plan,
        cutoffAtMonotonicMilliseconds: cutoffAt,
        failureLedger: ledger,
        teardownReserveMilliseconds: 250,
        signal: controller.signal,
        ...(options.omitChildIdentity === true
          ? {}
          : {
              childIdentity: () =>
                options.identityMissing === true ? undefined : childIdentity,
            }),
      }).then(
        (value) => ({ state: "resolved" as const, value }),
        (error: unknown) => ({
          state: "rejected" as const,
          message: error instanceof Error ? error.message : "hostile",
          observation: ledger.snapshot(),
        }),
      );
      const completedDescendant =
        state === "accepted-descendant" && settled.state === "resolved";
      let descendantStopped: boolean | undefined;
      if (completedDescendant)
        descendantStopped = await proveDescendantStopped(heartbeatPath);
      return Object.freeze({
        settled,
        elapsed: performance.now() - startedAt,
        lifecycleEntries: readdirSync(lifecycle),
        descendantPid: completedDescendant
          ? Number(readFileSync(descendantPath, "utf8"))
          : undefined,
        descendantStopped,
      });
    } finally {
      if (abortTimer !== undefined) clearTimeout(abortTimer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("Local SQLite Retriever child stdout", () => {
  it("accepts a complete private-channel result before exit despite later stdout closure", async () => {
    const stdout = new PassThrough();
    const resultChannel = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdio: [null, stdout, null, resultChannel],
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const nonce = "2".repeat(32);
    const messages = readWorkerMessages(child, nonce);
    stdout.write(
      `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`,
    );
    await expect(messages.ready).resolves.toMatchObject({ nonce, pid: 42 });

    resultChannel.write(
      `${JSON.stringify({ type: "retrieval-result", nonce, ok: true, evidence: { row: null } })}\n`,
    );
    resultChannel.end();
    await expect(messages.result).resolves.toMatchObject({
      nonce,
      ok: true,
      evidence: { row: null },
    });
    child.emit("exit", 0, null);
    stdout.end();
    expect(messages.valid()).toBe(true);
  });

  it("rejects a same-nonce stdout forgery after leader exit", async () => {
    const stdout = new PassThrough();
    const resultChannel = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdio: [null, stdout, null, resultChannel],
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const nonce = "2".repeat(32);
    const messages = readWorkerMessages(child, nonce);
    stdout.write(
      `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`,
    );
    await expect(messages.ready).resolves.toMatchObject({ nonce, pid: 42 });
    child.emit("exit", 0, null);
    stdout.write(
      `${JSON.stringify({ type: "retrieval-result", nonce, ok: true, evidence: { row: null } })}\n`,
    );
    stdout.end();
    resultChannel.end();
    await expect(messages.result).resolves.toBeUndefined();
    expect(messages.valid()).toBe(false);
  });

  it("rejects a private-channel result exceeding the existing byte cap", async () => {
    const stdout = new PassThrough();
    const resultChannel = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdio: [null, stdout, null, resultChannel],
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const nonce = "2".repeat(32);
    const messages = readWorkerMessages(child, nonce);
    stdout.write(
      `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`,
    );
    await messages.ready;
    resultChannel.end(
      Buffer.alloc(MAXIMUM_RETRIEVER_CHILD_RESULT_BYTES + 1, 120),
    );
    await expect(messages.result).resolves.toBeUndefined();
    expect(messages.valid()).toBe(false);
  });
});

describe("Local SQLite Retriever inherited stdout", () => {
  it("rejects a real inherited-stdout descendant forgery after leader exit", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "agentscope-retriever-private-fd-"),
    );
    chmodSync(root, 0o700);
    const inheritedIdentityPath = join(root, "descendant-fd3-identity");
    const nonce = "2".repeat(32);
    const forged = `${JSON.stringify({ type: "retrieval-result", nonce, ok: true, evidence: { row: null } })}\n`;
    const descendant = `
      const {fstatSync,writeFileSync}=require("node:fs");
      let same=false;
      try { const fd=fstatSync(3); same=String(fd.dev)+":"+String(fd.ino)===process.argv[1]; } catch {}
      writeFileSync(${JSON.stringify(inheritedIdentityPath)},String(same));
      setTimeout(() => { if (process.send !== undefined) process.exit(71); process.stdout.write(${JSON.stringify(forged)}); }, 40);
    `;
    const program = `
      const { spawn } = require("node:child_process");
      const {fstatSync}=require("node:fs");
      const fd=fstatSync(3);
      process.stdout.write(JSON.stringify({type:"ready",nonce:${JSON.stringify(nonce)},pid:process.pid,startIdentity:${JSON.stringify(childIdentity)}})+"\\n");
      spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, String(fd.dev)+":"+String(fd.ino)], {stdio:"inherit"});
    `;
    try {
      const child = spawn(process.execPath, ["-e", program], {
        stdio: ["ignore", "pipe", "ignore", "pipe"],
      });
      const stdout = child.stdout;
      if (stdout === null) throw new Error("missing owned stdout pipe");
      const observed: string[] = [];
      stdout.on("data", (chunk: Buffer) => {
        observed.push(chunk.toString("utf8"));
      });
      const stdoutTerminal = new Promise<void>((resolve) => {
        stdout.once("end", resolve);
      });
      const messages = readWorkerMessages(child, nonce);
      await expect(messages.ready).resolves.toMatchObject({ nonce });
      await new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      await expect(messages.result).resolves.toBeUndefined();
      await stdoutTerminal;
      expect(readFileSync(inheritedIdentityPath, "utf8")).toBe("false");
      expect(observed.join("")).toContain(forged);
      expect(messages.valid()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Local SQLite Retriever private-channel framing", () => {
  const fakeChild = (resultChannel: PassThrough | null) => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdio: [null, stdout, null, resultChannel],
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    return { child, stdout, resultChannel };
  };

  it("rejects two ready frames in one stdout chunk", async () => {
    const stdout = new PassThrough();
    const resultChannel = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdio: [null, stdout, null, resultChannel],
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const nonce = "2".repeat(32);
    const messages = readWorkerMessages(child, nonce);
    const ready = `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`;
    stdout.end(ready + ready);
    resultChannel.end();
    await expect(messages.ready).resolves.toBeUndefined();
    await expect(messages.result).resolves.toBeUndefined();
    expect(messages.valid()).toBe(false);
  });

  it("rejects data following a complete private result frame", async () => {
    const stdout = new PassThrough();
    const resultChannel = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stdio: [null, stdout, null, resultChannel],
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const nonce = "2".repeat(32);
    const messages = readWorkerMessages(child, nonce);
    stdout.write(
      `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`,
    );
    await messages.ready;
    resultChannel.write(
      `${JSON.stringify({ type: "retrieval-result", nonce, ok: true, evidence: { row: null } })}\n`,
    );
    resultChannel.end("extra");
    await expect(messages.result).resolves.toBeUndefined();
    expect(messages.valid()).toBe(false);
  });

  it("accepts Uint8Array and split private frames", async () => {
    const { child, stdout, resultChannel } = fakeChild(new PassThrough());
    const nonce = "2".repeat(32);
    const messages = readWorkerMessages(child, nonce);
    stdout.emit(
      "data",
      new Uint8Array(
        Buffer.from(
          `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`,
        ),
      ),
    );
    await messages.ready;
    const frame = Buffer.from(
      `${JSON.stringify({ type: "retrieval-result", nonce, ok: true, evidence: { row: null } })}\n`,
    );
    resultChannel!.emit("data", new Uint8Array(frame.subarray(0, 5)));
    resultChannel!.emit("data", frame.subarray(5));
    resultChannel!.emit("end");
    await expect(messages.result).resolves.toMatchObject({ ok: true, nonce });
  });

  it("rejects empty ready and result frames", async () => {
    const first = fakeChild(new PassThrough());
    const firstMessages = readWorkerMessages(first.child, "2".repeat(32));
    first.stdout.end("\n");
    first.resultChannel!.end();
    await expect(firstMessages.ready).resolves.toBeUndefined();
    await expect(firstMessages.result).resolves.toBeUndefined();

    const second = fakeChild(new PassThrough());
    const nonce = "2".repeat(32);
    const secondMessages = readWorkerMessages(second.child, nonce);
    second.stdout.end(
      `${JSON.stringify({ type: "ready", nonce, pid: 42, startIdentity: childIdentity })}\n`,
    );
    await secondMessages.ready;
    second.resultChannel!.end("\n");
    await expect(secondMessages.result).resolves.toBeUndefined();
  });

  it("rejects a closed or missing private result pipe", async () => {
    const closed = fakeChild(new PassThrough());
    const closedMessages = readWorkerMessages(closed.child, "2".repeat(32));
    closed.resultChannel!.emit("close");
    await expect(closedMessages.result).resolves.toBeUndefined();

    const missing = fakeChild(null);
    const missingMessages = readWorkerMessages(missing.child, "2".repeat(32));
    await expect(missingMessages.ready).resolves.toBeUndefined();
    await expect(missingMessages.result).resolves.toBeUndefined();
  });
});

describe("Local SQLite Retriever fixture terminal ordering", () => {
  it.each([
    ["accepted", "stdin"],
    ["accepted", "writer"],
    ["result-error", "stdin"],
    ["result-error", "writer"],
  ] as const)(
    "fixture %s establishes its terminal exit when %s closes first",
    (state, firstClose) => {
      const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
      let resultFrame = "";
      let terminalCode: number | undefined;
      const writer = Object.assign(new EventEmitter(), {
        end(value: string) {
          resultFrame = value;
        },
      });
      // Replay the exact generated fixture with controlled event delivery.
      // Throwing from exit models process termination: no later callback wins.
      runInNewContext(workerProgram(state, "unused", "unused"), {
        process: {
          pid: 42,
          stdin,
          stdout: { write() {} },
          exit(code: number) {
            terminalCode = code;
            throw new Error("fixture exited");
          },
        },
        require(name: string) {
          if (name === "node:fs") return { createWriteStream: () => writer };
          if (name === "node:child_process") return {};
          throw new Error("unexpected fixture dependency");
        },
      });
      const nonce = "2".repeat(32);
      stdin.emit("data", `${JSON.stringify({ type: "retrieve", nonce })}\n`);
      stdin.emit("data", `${JSON.stringify({ type: "permission", nonce })}\n`);
      expect(JSON.parse(resultFrame)).toMatchObject({
        type: "retrieval-result",
        nonce,
        ok: true,
        evidence: { rows: [] },
      });
      expect(() => {
        if (firstClose === "writer") writer.emit("close");
        stdin.emit("end");
        writer.emit("close");
      }).toThrow("fixture exited");
      expect(terminalCode).toBe(state === "result-error" ? 1 : 0);
    },
  );
});

describe("Local SQLite Retriever child parent", () => {
  it("returns exact bounded evidence only after child exit and lease cleanup", async () => {
    for (const state of ["accepted", "split-ready"] as const) {
      const result = await run(state);
      expect(result.settled).toMatchObject({
        state: "resolved",
        value: { rows: [] },
      });
      expect(result.lifecycleEntries).toEqual([]);
    }
  });

  it("force-joins an uncooperative worker and watchdog within one reserve", async () => {
    const result = await run("hang", { stubbornWatchdog: true });
    expect(result.settled).toMatchObject({ state: "rejected" });
    // This real-process smoke bound includes scheduler and spawn latency under
    // aggregate CI load. The shared absolute teardown deadline is asserted by
    // the source contract; this oracle rejects an unbounded surviving child.
    expect(result.elapsed).toBeLessThan(750);
    expect(result.lifecycleEntries).toEqual([]);
  });

  it("reaps the complete group after a successful leader exits", async () => {
    // This real-process success smoke must first reach the post-permission
    // descendant state. Deadline/forced-settlement behavior is covered by the
    // dedicated hostile cases, so allow aggregate startup scheduling here.
    const result = await run("accepted-descendant", {
      maximumWorkMilliseconds: 2_000,
    });
    expect(result.settled).toMatchObject({ state: "resolved" });
    expect(result.descendantPid).toBeTypeOf("number");
    expect(result.descendantStopped).toBe(true);
  });

  it("preserves pre-publication rejection without reading descendant markers", async () => {
    const result = await run("accepted-descendant", { missingWorker: true });
    expect(result).toMatchObject({
      settled: { state: "rejected" },
      descendantPid: undefined,
      descendantStopped: undefined,
    });
  });

  it.each([
    "before",
    "malformed",
    "oversized",
    "wrong-start",
    "close-after-ready",
    "false-result",
    "missing-evidence",
    "wrong-result",
    "wrong-type-result",
    "duplicate-result",
    "stdout-forgery",
    "result-error",
  ] as const)(
    "rejects hostile %s settlement and cleans its lease",
    async (state) => {
      const result = await run(state, {
        maximumWorkMilliseconds: state === "before" ? 40 : 1_000,
      });
      expect(result.settled).toMatchObject({ state: "rejected" });
      expect(result.lifecycleEntries).toEqual([]);
    },
  );

  it("rejects missing child identity, failed amendment, abort, and missing worker", async () => {
    for (const options of [
      { identityMissing: true },
      { omitChildIdentity: true },
      { failAmend: true },
      { throwAmend: true },
      { abortAfterMilliseconds: 10, maximumWorkMilliseconds: 200 },
      { missingWorker: true },
      { missingWatchdog: true },
      { watchdogState: "wrong-message" as const },
      { watchdogState: "exit-before-watch" as const },
    ]) {
      const result = await run("accepted", options);
      expect(result.settled).toMatchObject({ state: "rejected" });
      expect(result.lifecycleEntries).toEqual([]);
    }
  });

  it("preserves outcome ambiguity when lease cleanup cannot be proven", async () => {
    const result = await run("accepted", { failRelease: true });
    expect(result.settled).toMatchObject({
      state: "rejected",
      message: "destination.local-sqlite.outcome-unknown",
    });
    expect(result.lifecycleEntries).toEqual([
      `lease-${"1".repeat(32)}.json`,
      `lease-cleanup-${"1".repeat(32)}.json`,
    ]);
  });
});
